import 'dotenv/config';

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { registerEnvironment } from './config/env.js';
import {
  loadGatewayConfig,
  type GatewayConfig,
} from './config/routes.js';
import { registerErrorHandlers } from './gateway/errors.js';
import { generateRequestId } from './gateway/headers.js';
import { registerProxies } from './gateway/register-proxies.js';
import { registerSecurityPlugins } from './plugins/security.js';
import { registerHealthRoutes } from './routes/health.js';

export interface BuildAppOptions {
  gatewayConfig?: GatewayConfig;
  logger?: boolean;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createLoggerOptions(): FastifyServerOptions['logger'] {
  const level = process.env.LOG_LEVEL ?? 'info';

  if (process.env.NODE_ENV === 'production') {
    return { level };
  }

  return {
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: true,
        translateTime: 'SYS:standard',
      },
    },
  };
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: parsePositiveInteger(process.env.BODY_LIMIT, 1_048_576),
    genReqId: generateRequestId,
    logger: options.logger ?? createLoggerOptions(),
    trustProxy: process.env.TRUST_PROXY === 'true',
  });

  registerErrorHandlers(app);
  await registerEnvironment(app);

  const gatewayConfig =
    options.gatewayConfig ??
    (await loadGatewayConfig(app.config.ROUTES_CONFIG_FILE));

  await registerSecurityPlugins(app);
  registerHealthRoutes(app, gatewayConfig);
  await registerProxies(app, gatewayConfig);

  return app;
}
