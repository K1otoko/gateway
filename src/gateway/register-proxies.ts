import httpProxy from '@fastify/http-proxy';
import type { FastifyInstance } from 'fastify';

import type { GatewayConfig } from '../config/routes.js';
import {
  buildUpstreamHeaders,
  type ProxyHeaders,
  type ProxyRequest,
} from './headers.js';

const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

export async function registerProxies(
  app: FastifyInstance,
  config: GatewayConfig,
): Promise<void> {
  for (const route of config.routes) {
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
      timeout: route.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
      config: routeConfig,
      replyOptions: {
        rewriteRequestHeaders: (
          request: ProxyRequest,
          headers: ProxyHeaders,
        ) =>
          buildUpstreamHeaders(request, headers, route.upstream),
      },
    };

    if (route.websocket === true) {
      await app.register(httpProxy, {
        ...proxyOptions,
        websocket: true,
      });
    } else {
      await app.register(httpProxy, {
        ...proxyOptions,
        websocket: false,
      });
    }

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
