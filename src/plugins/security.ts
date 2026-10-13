import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

export async function registerSecurityPlugins(
  app: FastifyInstance,
): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  });

  await app.register(rateLimit, {
    global: false,
  });
}
