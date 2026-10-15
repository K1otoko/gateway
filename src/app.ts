import 'dotenv/config';

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { registerAuthenticationContext } from './auth/authorize.js';
import {
  createRemoteAccessTokenVerifier,
  type AccessTokenVerifier,
} from './auth/token-verifier.js';
import {
  parseTrustProxy,
  registerEnvironment,
} from './config/env.js';
import {
  loadGatewayConfig,
  type GatewayConfig,
} from './config/routes.js';
import { registerErrorHandlers } from './gateway/errors.js';
import { generateRequestId } from './gateway/headers.js';
import { registerProxies } from './gateway/register-proxies.js';
import { registerSecurityPlugins } from './plugins/security.js';
import {
  registerHealthRoutes,
  type HealthReadiness,
} from './routes/health.js';

export interface BuildAppOptions {
  accessTokenVerifier?: AccessTokenVerifier;
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
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  });

  registerErrorHandlers(app);
  await registerEnvironment(app);

  const gatewayConfig =
    options.gatewayConfig ??
    (await loadGatewayConfig(app.config.ROUTES_CONFIG_FILE));
  const hasProtectedRoutes = gatewayConfig.routes.some(
    (route) => route.auth.mode === 'required',
  );
  let accessTokenVerifier = options.accessTokenVerifier;
  let healthReadiness: HealthReadiness | undefined;

  if (accessTokenVerifier === undefined && hasProtectedRoutes) {
    const remoteVerifier = createRemoteAccessTokenVerifier(app.config);

    try {
      await remoteVerifier.preload();
    } catch (error) {
      app.log.error({ err: error }, 'OIDC signing keys are not ready');
    }

    accessTokenVerifier = remoteVerifier;
    healthReadiness = {
      isAuthenticationReady: () => remoteVerifier.ensureReady(),
    };
  }

  await registerSecurityPlugins(app);
  registerAuthenticationContext(app);
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });
  registerHealthRoutes(app, gatewayConfig, healthReadiness);
  await registerProxies(app, gatewayConfig, accessTokenVerifier);

  return app;
}
