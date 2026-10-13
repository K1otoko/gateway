import type { FastifyInstance } from 'fastify';

import type { GatewayConfig } from '../config/routes.js';

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

export function registerHealthRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
): void {
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
        },
      },
    },
    () => ({
      status: 'ready',
      timestamp: new Date().toISOString(),
      routeCount: config.routes.length,
    }),
  );
}
