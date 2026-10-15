import fastifyEnv from '@fastify/env';
import type {
  FastifyInstance,
  FastifyServerOptions,
} from 'fastify';

type TrustProxyOption = Exclude<
  FastifyServerOptions['trustProxy'],
  undefined
>;

export interface AppConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  HOST: string;
  PORT: number;
  LOG_LEVEL: string;
  BODY_LIMIT: number;
  TRUST_PROXY: string;
  ROUTES_CONFIG_FILE: string;
  OIDC_ISSUER: string;
  OIDC_JWKS_URI: string;
  OIDC_AUDIENCE: string;
  AUTH_CLOCK_TOLERANCE_SECONDS: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}

const envSchema = {
  type: 'object',
  properties: {
    NODE_ENV: {
      type: 'string',
      enum: ['development', 'test', 'production'],
      default: 'development',
    },
    HOST: {
      type: 'string',
      default: '0.0.0.0',
    },
    PORT: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      default: 3000,
    },
    LOG_LEVEL: {
      type: 'string',
      default: 'info',
    },
    BODY_LIMIT: {
      type: 'integer',
      minimum: 1,
      default: 1_048_576,
    },
    TRUST_PROXY: {
      type: 'string',
      minLength: 1,
      default: 'false',
    },
    ROUTES_CONFIG_FILE: {
      type: 'string',
      minLength: 1,
      default: 'config/routes.yaml',
    },
    OIDC_ISSUER: {
      type: 'string',
      minLength: 1,
      default: 'http://127.0.0.1:4000/api/sso/oidc',
    },
    OIDC_JWKS_URI: {
      type: 'string',
      minLength: 1,
      default: 'http://127.0.0.1:4000/api/sso/oidc/jwks',
    },
    OIDC_AUDIENCE: {
      type: 'string',
      minLength: 1,
      default: 'urn:sso:api',
    },
    AUTH_CLOCK_TOLERANCE_SECONDS: {
      type: 'integer',
      minimum: 0,
      maximum: 300,
      default: 60,
    },
  },
} as const;

export function parseTrustProxy(
  value: string | undefined,
): TrustProxyOption {
  const normalized = (value ?? 'false').trim();
  const keyword = normalized.toLowerCase();

  if (keyword === 'false') {
    return false;
  }

  if (keyword === 'true') {
    return true;
  }

  if (/^-?\d+$/.test(normalized)) {
    const trustedHops = Number(normalized);

    if (!Number.isSafeInteger(trustedHops) || trustedHops < 0) {
      throw new Error(
        'TRUST_PROXY hop count must be a non-negative safe integer',
      );
    }

    if (trustedHops === 0) {
      return false;
    }

    return (_address, hop) => hop < trustedHops;
  }

  if (normalized.length === 0) {
    throw new Error(
      'TRUST_PROXY must be false, true, a hop count, or trusted IP/CIDR values',
    );
  }

  return normalized;
}

export async function registerEnvironment(app: FastifyInstance): Promise<void> {
  await app.register(fastifyEnv, {
    confKey: 'config',
    dotenv: false,
    schema: envSchema,
  });
}
