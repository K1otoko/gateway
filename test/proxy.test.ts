import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test upstream did not bind to a TCP port');
  }

  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe('gateway', () => {
  it('reports liveness and readiness', async () => {
    const app = await buildApp({
      gatewayConfig: { routes: [] },
      logger: false,
    });

    try {
      const liveResponse = await app.inject({
        method: 'GET',
        url: '/health/live',
      });
      const readyResponse = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(liveResponse.statusCode).toBe(200);
      expect(liveResponse.json()).toMatchObject({ status: 'ok' });
      expect(readyResponse.statusCode).toBe(200);
      expect(readyResponse.json()).toMatchObject({
        status: 'ready',
        routeCount: 0,
      });
    } finally {
      await app.close();
    }
  });

  it('returns bad gateway when an upstream cannot be reached', async () => {
    const unavailableUpstream = createServer();
    servers.push(unavailableUpstream);
    const upstreamPort = await listen(unavailableUpstream);
    await close(unavailableUpstream);
    servers.splice(servers.indexOf(unavailableUpstream), 1);

    const app = await buildApp({
      gatewayConfig: {
        routes: [
          {
            id: 'unavailable',
            prefix: '/unavailable',
            upstream: `http://127.0.0.1:${upstreamPort}`,
            auth: {
              mode: 'public',
            },
          },
        ],
      },
      logger: false,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/unavailable/ping',
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        statusCode: 502,
        error: 'Bad Gateway',
      });
    } finally {
      await app.close();
    }
  });

  it('rewrites paths, forwards request IDs, and applies route limits', async () => {
    const upstream = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          requestId: request.headers['x-request-id'],
          url: request.url,
        }),
      );
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const app = await buildApp({
      gatewayConfig: {
        routes: [
          {
            id: 'users',
            prefix: '/api',
            upstream: `http://127.0.0.1:${upstreamPort}`,
            rewritePrefix: '/v1',
            timeoutMs: 1000,
            auth: {
              mode: 'public',
            },
            rateLimit: {
              max: 1,
              timeWindow: 60_000,
            },
          },
        ],
      },
      logger: false,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/users?active=true',
        headers: {
          'x-request-id': 'integration-request',
        },
      });
      const limitedResponse = await app.inject({
        method: 'GET',
        url: '/api/users',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        requestId: 'integration-request',
        url: '/v1/users?active=true',
      });
      expect(limitedResponse.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
