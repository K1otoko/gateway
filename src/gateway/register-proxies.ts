import httpProxy from '@fastify/http-proxy';
import type { FastifyInstance } from 'fastify';

import { createAuthorizationHook } from '../auth/authorize.js';
import type { AccessTokenVerifier } from '../auth/token-verifier.js';
import {
  GatewayConfigurationError,
  type GatewayConfig,
} from '../config/routes.js';
import {
  buildUpstreamHeaders,
  type ProxyHeaders,
  type ProxyRequest,
} from './headers.js';

const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

export async function registerProxies(
  app: FastifyInstance,
  config: GatewayConfig,
  verifyAccessToken?: AccessTokenVerifier,
): Promise<void> {
  for (const route of config.routes) {
    if (route.websocket === true && route.auth.mode === 'required') {
      throw new GatewayConfigurationError(
        `Route "${route.id}" cannot require authentication when websocket is enabled`,
      );
    }

    const authorizationHook = createAuthorizationHook(
      route.id,
      route.auth,
      verifyAccessToken,
    );
    const routeConfig = route.rateLimit
      ? {
          gatewayRouteId: route.id,
          rateLimit: {
            max: route.rateLimit.max,
            timeWindow: route.rateLimit.timeWindow,
          },
        }
      : {
          gatewayRouteId: route.id,
          rateLimit: false,
        };

    const proxyOptions = {
      upstream: route.upstream,
      prefix: route.prefix,
      rewritePrefix: route.rewritePrefix ?? '',
      config: routeConfig,
      replyOptions: {
        timeout: route.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
        rewriteRequestHeaders: (
          request: ProxyRequest,
          headers: ProxyHeaders,
        ) =>
          buildUpstreamHeaders(request, headers, route.upstream),
      },
    };

    await app.register(async (routeApp) => {
      if (authorizationHook !== undefined) {
        routeApp.addHook('preHandler', authorizationHook);
      }

      if (route.websocket === true) {
        await routeApp.register(httpProxy, {
          ...proxyOptions,
          websocket: true,
        });
      } else {
        await routeApp.register(httpProxy, {
          ...proxyOptions,
          websocket: false,
        });
      }
    });

    app.log.info(
      {
        routeId: route.id,
        prefix: route.prefix,
        upstream: route.upstream,
      },
      'gateway route registered',
    );
  }
}
