import type { FastifyInstance } from 'fastify';

import type { GatewayConfig } from '../config/routes.js';

export interface HealthReadiness {
  isAuthenticationReady(): boolean | Promise<boolean>;
}

const healthResponseSchema = {
  type: 'object',
  required: ['status', 'timestamp'],
  properties: {
    status: { type: 'string' },
    timestamp: { type: 'string' },
    uptimeSeconds: { type: 'number' },
    routeCount: { type: 'integer' },
  },
} as const;

const connectivityResponseSchema = {
  type: 'object',
  required: ['status', 'service', 'timestamp', 'requestId'],
  properties: {
    status: { type: 'string' },
    service: { type: 'string' },
    timestamp: { type: 'string' },
    requestId: { type: 'string' },
  },
} as const;

export function registerHealthRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  readiness?: HealthReadiness,
): void {
  app.get(
    '/api/gateway/ping',
    {
      schema: {
        response: {
          200: connectivityResponseSchema,
        },
      },
    },
    (request, reply) => {
      reply.header('cache-control', 'no-store');

      return {
        status: 'ok',
        service: 'gateway',
        timestamp: new Date().toISOString(),
        requestId: request.id,
      };
    },
  );

  app.get(
    '/health/live',
    {
      schema: {
        response: {
          200: healthResponseSchema,
        },
      },
    },
    () => ({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        response: {
          200: healthResponseSchema,
          503: healthResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const authenticationReady =
        (await readiness?.isAuthenticationReady()) ?? true;

      return reply.code(authenticationReady ? 200 : 503).send({
        status: authenticationReady ? 'ready' : 'not_ready',
        timestamp: new Date().toISOString(),
        routeCount: config.routes.length,
      });
    },
  );
}
