import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Type, type Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { parse } from 'yaml';

const RateLimitSchema = Type.Object(
  {
    max: Type.Integer({ minimum: 1 }),
    timeWindow: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const GatewayRouteSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
    }),
    prefix: Type.String({
      minLength: 1,
      pattern: '^/',
    }),
    upstream: Type.String({ minLength: 1 }),
    rewritePrefix: Type.Optional(
      Type.String({
        minLength: 1,
        pattern: '^/',
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 300_000,
      }),
    ),
    rateLimit: Type.Optional(RateLimitSchema),
    websocket: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const GatewayConfigSchema = Type.Object(
  {
    routes: Type.Array(GatewayRouteSchema),
  },
  { additionalProperties: false },
);

const gatewayConfigValidator = TypeCompiler.Compile(GatewayConfigSchema);

export type GatewayConfig = Static<typeof GatewayConfigSchema>;
export type GatewayRoute = Static<typeof GatewayRouteSchema>;

export class GatewayConfigurationError extends Error {
  override readonly name = 'GatewayConfigurationError';
}

function validateUpstream(route: GatewayRoute, sourceName: string): string {
  let upstream: URL;

  try {
    upstream = new URL(route.upstream);
  } catch {
    throw new GatewayConfigurationError(
      `${sourceName}: route "${route.id}" has an invalid upstream URL`,
    );
  }

  if (!['http:', 'https:'].includes(upstream.protocol)) {
    throw new GatewayConfigurationError(
      `${sourceName}: route "${route.id}" upstream must use HTTP or HTTPS`,
    );
  }

  if (upstream.username || upstream.password) {
    throw new GatewayConfigurationError(
      `${sourceName}: route "${route.id}" upstream must not contain credentials`,
    );
  }

  if (upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new GatewayConfigurationError(
      `${sourceName}: route "${route.id}" upstream must contain only an origin; use rewritePrefix for paths`,
    );
  }

  return upstream.origin;
}

export function parseGatewayConfig(
  source: string,
  sourceName = 'gateway routes',
): GatewayConfig {
  const value: unknown = parse(source);

  if (!gatewayConfigValidator.Check(value)) {
    const details = [...gatewayConfigValidator.Errors(value)]
      .map((error) => `${error.path || '/'} ${error.message}`)
      .join('; ');

    throw new GatewayConfigurationError(`${sourceName}: ${details}`);
  }

  const ids = new Set<string>();
  const prefixes = new Set<string>();
  const routes = value.routes.map((route) => {
    if (route.prefix !== '/' && route.prefix.endsWith('/')) {
      throw new GatewayConfigurationError(
        `${sourceName}: route "${route.id}" prefix must not end with "/"`,
      );
    }

    if (ids.has(route.id)) {
      throw new GatewayConfigurationError(
        `${sourceName}: duplicate route id "${route.id}"`,
      );
    }

    if (prefixes.has(route.prefix)) {
      throw new GatewayConfigurationError(
        `${sourceName}: duplicate route prefix "${route.prefix}"`,
      );
    }

    ids.add(route.id);
    prefixes.add(route.prefix);

    return {
      ...route,
      upstream: validateUpstream(route, sourceName),
    };
  });

  return { routes };
}

export async function loadGatewayConfig(filePath: string): Promise<GatewayConfig> {
  const absolutePath = resolve(process.cwd(), filePath);
  const source = await readFile(absolutePath, 'utf8');

  return parseGatewayConfig(source, absolutePath);
}
