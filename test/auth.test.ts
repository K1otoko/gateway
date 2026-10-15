import { createServer, type Server } from 'node:http';

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Role } from '../src/auth/roles.js';
import { createAccessTokenVerifier } from '../src/auth/token-verifier.js';
import { buildApp } from '../src/app.js';

const ISSUER = 'https://sso.example.com/api/sso/oidc';
const AUDIENCE = 'urn:sso:api';
const KEY_ID = 'test-signing-key';
const USER_ID = '78a763fc-e0c1-48e2-83e8-0dc9e4b8cf5d';
const servers: Server[] = [];

let privateKey: CryptoKey;
let publicJwk: JWK;
let accessTokenVerifier: ReturnType<typeof createAccessTokenVerifier>;

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

interface TokenOptions {
  audience?: string;
  expiresAt?: number | string;
  issuer?: string;
  keyId?: string;
  role?: Role | 'unknown';
  signingKey?: CryptoKey;
  tokenUse?: 'service' | 'user';
  typ?: string;
}

async function issueToken(options: TokenOptions = {}): Promise<string> {
  return new SignJWT({
    role: options.role ?? 'user',
    token_use: options.tokenUse ?? 'user',
    username: 'gateway-test',
  })
    .setProtectedHeader({
      alg: 'ES256',
      kid: options.keyId ?? KEY_ID,
      typ: options.typ ?? 'at+jwt',
    })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject(USER_ID)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? '5m')
    .sign(options.signingKey ?? privateKey);
}

function setEnvironment(values: Record<string, string>): () => void {
  const previousValues = new Map(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );

  Object.assign(process.env, values);

  return () => {
    for (const [name, value] of previousValues) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

beforeAll(async () => {
  const keyPair = await generateKeyPair('ES256');
  privateKey = keyPair.privateKey;
  publicJwk = await exportJWK(keyPair.publicKey);
  const localKeySet = createLocalJWKSet({
    keys: [
      {
        ...publicJwk,
        alg: 'ES256',
        kid: KEY_ID,
        use: 'sig',
      },
    ],
  });

  accessTokenVerifier = createAccessTokenVerifier({
    audience: AUDIENCE,
    clockToleranceSeconds: 60,
    issuer: ISSUER,
    key: localKeySet,
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe('gateway authentication', () => {
  it('rejects missing and invalid access tokens before proxying', async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.end('unexpected');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const app = await buildApp({
      accessTokenVerifier,
      gatewayConfig: {
        routes: [
          {
            id: 'protected',
            prefix: '/api/gateway/protected',
            upstream: `http://127.0.0.1:${upstreamPort}`,
            auth: {
              mode: 'required',
              minRole: 'user',
            },
          },
        ],
      },
      logger: false,
    });

    try {
      const missingResponse = await app.inject({
        method: 'GET',
        url: '/api/gateway/protected/resource',
      });
      const invalidResponse = await app.inject({
        method: 'GET',
        url: '/api/gateway/protected/resource',
        headers: {
          authorization: 'Bearer not-a-jwt',
        },
      });

      expect(missingResponse.statusCode).toBe(401);
      expect(missingResponse.headers['www-authenticate']).toBe('Bearer');
      expect(missingResponse.json()).toMatchObject({
        error: 'invalid_token',
      });
      expect(invalidResponse.statusCode).toBe(401);
      expect(invalidResponse.json()).toMatchObject({
        error: 'invalid_token',
      });
      expect(upstreamRequests).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('injects verified identity and removes client supplied identity headers', async () => {
    const upstream = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          authorization: request.headers.authorization,
          requestId: request.headers['x-request-id'],
          userAdmin: request.headers['x-user-admin'],
          userId: request.headers['x-user-id'],
          userRole: request.headers['x-user-role'],
        }),
      );
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const app = await buildApp({
      accessTokenVerifier,
      gatewayConfig: {
        routes: [
          {
            id: 'protected',
            prefix: '/api/gateway/protected',
            upstream: `http://127.0.0.1:${upstreamPort}`,
            auth: {
              mode: 'required',
              minRole: 'admin',
            },
          },
        ],
      },
      logger: false,
    });
    const token = await issueToken({ role: 'admin' });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/gateway/protected/resource',
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'authenticated-request',
          'x-user-admin': 'true',
          'x-user-id': 'spoofed-user',
          'x-user-role': 'super',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['x-request-id']).toBe('authenticated-request');
      expect(response.json()).toEqual({
        authorization: `Bearer ${token}`,
        requestId: 'authenticated-request',
        userId: USER_ID,
        userRole: 'admin',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects a valid token when its role is below the route minimum', async () => {
    const upstream = createServer((_request, response) => {
      response.end('ok');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const app = await buildApp({
      accessTokenVerifier,
      gatewayConfig: {
        routes: [
          {
            id: 'admin',
            prefix: '/api/gateway/admin',
            upstream: `http://127.0.0.1:${upstreamPort}`,
            auth: {
              mode: 'required',
              minRole: 'admin',
            },
          },
        ],
      },
      logger: false,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/gateway/admin/resource',
        headers: {
          authorization: `Bearer ${await issueToken({ role: 'user' })}`,
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: 'insufficient_role',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects tokens that violate the SSO access token contract', async () => {
    const upstream = createServer((_request, response) => {
      response.end('unexpected');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const app = await buildApp({
      accessTokenVerifier,
      gatewayConfig: {
        routes: [
          {
            id: 'protected',
            prefix: '/api/gateway/protected',
            upstream: `http://127.0.0.1:${upstreamPort}`,
            auth: {
              mode: 'required',
              minRole: 'user',
            },
          },
        ],
      },
      logger: false,
    });
    const otherKeyPair = await generateKeyPair('ES256');
    const invalidTokens = await Promise.all([
      issueToken({
        expiresAt: Math.floor(Date.now() / 1000) - 120,
      }),
      issueToken({ audience: 'urn:other:api' }),
      issueToken({ issuer: 'https://other.example.com/api/sso/oidc' }),
      issueToken({ tokenUse: 'service' }),
      issueToken({ role: 'unknown' }),
      issueToken({ typ: 'JWT' }),
      issueToken({ signingKey: otherKeyPair.privateKey }),
    ]);

    try {
      for (const token of invalidTokens) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/gateway/protected/resource',
          headers: {
            authorization: `Bearer ${token}`,
          },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          error: 'invalid_token',
        });
      }
    } finally {
      await app.close();
    }
  });

  it('preloads remote signing keys and keeps cached keys available', async () => {
    let jwksRequests = 0;
    const jwksServer = createServer((_request, response) => {
      jwksRequests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          keys: [
            {
              ...publicJwk,
              alg: 'ES256',
              kid: KEY_ID,
              use: 'sig',
            },
          ],
        }),
      );
    });
    servers.push(jwksServer);
    const jwksPort = await listen(jwksServer);
    const upstream = createServer((_request, response) => {
      response.end('ok');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const restoreEnvironment = setEnvironment({
      AUTH_CLOCK_TOLERANCE_SECONDS: '60',
      OIDC_AUDIENCE: AUDIENCE,
      OIDC_ISSUER: ISSUER,
      OIDC_JWKS_URI: `http://127.0.0.1:${jwksPort}/jwks`,
    });

    try {
      const app = await buildApp({
        gatewayConfig: {
          routes: [
            {
              id: 'remote-protected',
              prefix: '/remote-protected',
              upstream: `http://127.0.0.1:${upstreamPort}`,
              auth: {
                mode: 'required',
                minRole: 'user',
              },
            },
          ],
        },
        logger: false,
      });

      try {
        const readyResponse = await app.inject({
          method: 'GET',
          url: '/health/ready',
        });
        const unknownKeyResponse = await app.inject({
          method: 'GET',
          url: '/remote-protected/resource',
          headers: {
            authorization: `Bearer ${await issueToken({
              keyId: 'unknown-key',
            })}`,
          },
        });

        expect(jwksRequests).toBe(1);
        expect(readyResponse.statusCode).toBe(200);
        expect(unknownKeyResponse.statusCode).toBe(401);

        await close(jwksServer);
        servers.splice(servers.indexOf(jwksServer), 1);

        const cachedKeyResponse = await app.inject({
          method: 'GET',
          url: '/remote-protected/resource',
          headers: {
            authorization: `Bearer ${await issueToken()}`,
          },
        });

        expect(cachedKeyResponse.statusCode).toBe(200);
        expect(cachedKeyResponse.body).toBe('ok');
        expect(jwksRequests).toBe(1);
      } finally {
        await app.close();
      }
    } finally {
      restoreEnvironment();
    }
  });

  it('reports not ready and returns 503 when JWKS cannot be reached', async () => {
    const unavailableJwks = createServer();
    servers.push(unavailableJwks);
    const jwksPort = await listen(unavailableJwks);
    await close(unavailableJwks);
    servers.splice(servers.indexOf(unavailableJwks), 1);

    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.end('unexpected');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const restoreEnvironment = setEnvironment({
      AUTH_CLOCK_TOLERANCE_SECONDS: '60',
      OIDC_AUDIENCE: AUDIENCE,
      OIDC_ISSUER: ISSUER,
      OIDC_JWKS_URI: `http://127.0.0.1:${jwksPort}/jwks`,
    });

    try {
      const app = await buildApp({
        gatewayConfig: {
          routes: [
            {
              id: 'unavailable-auth',
              prefix: '/unavailable-auth',
              upstream: `http://127.0.0.1:${upstreamPort}`,
              auth: {
                mode: 'required',
                minRole: 'user',
              },
            },
          ],
        },
        logger: false,
      });

      try {
        const readyResponse = await app.inject({
          method: 'GET',
          url: '/health/ready',
        });
        const protectedResponse = await app.inject({
          method: 'GET',
          url: '/unavailable-auth/resource',
          headers: {
            authorization: `Bearer ${await issueToken()}`,
          },
        });

        expect(readyResponse.statusCode).toBe(503);
        expect(readyResponse.json()).toMatchObject({
          status: 'not_ready',
        });
        expect(protectedResponse.statusCode).toBe(503);
        expect(protectedResponse.headers['retry-after']).toBe('5');
        expect(protectedResponse.json()).toMatchObject({
          error: 'authentication_unavailable',
        });
        expect(upstreamRequests).toBe(0);
      } finally {
        await app.close();
      }
    } finally {
      restoreEnvironment();
    }
  });

  it('recovers readiness after JWKS gains an ES256 signing public key', async () => {
    let hasSigningKey = false;
    const jwksServer = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          keys: hasSigningKey
            ? [
                {
                  ...publicJwk,
                  alg: 'ES256',
                  kid: KEY_ID,
                  use: 'sig',
                },
              ]
            : [],
        }),
      );
    });
    servers.push(jwksServer);
    const jwksPort = await listen(jwksServer);
    const upstream = createServer((_request, response) => {
      response.end('ok');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const restoreEnvironment = setEnvironment({
      AUTH_CLOCK_TOLERANCE_SECONDS: '60',
      OIDC_AUDIENCE: AUDIENCE,
      OIDC_ISSUER: ISSUER,
      OIDC_JWKS_URI: `http://127.0.0.1:${jwksPort}/jwks`,
    });
    let currentTime = Date.now();
    const dateNow = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => currentTime);

    try {
      const app = await buildApp({
        gatewayConfig: {
          routes: [
            {
              id: 'invalid-jwks',
              prefix: '/invalid-jwks',
              upstream: `http://127.0.0.1:${upstreamPort}`,
              auth: {
                mode: 'required',
                minRole: 'user',
              },
            },
          ],
        },
        logger: false,
      });

      try {
        const readyResponse = await app.inject({
          method: 'GET',
          url: '/health/ready',
        });
        const protectedResponse = await app.inject({
          method: 'GET',
          url: '/invalid-jwks/resource',
          headers: {
            authorization: `Bearer ${await issueToken()}`,
          },
        });

        expect(readyResponse.statusCode).toBe(503);
        expect(protectedResponse.statusCode).toBe(503);
        expect(protectedResponse.json()).toMatchObject({
          error: 'authentication_unavailable',
        });

        hasSigningKey = true;
        currentTime += 5_001;

        const recoveredReadyResponse = await app.inject({
          method: 'GET',
          url: '/health/ready',
        });
        const recoveredProtectedResponse = await app.inject({
          method: 'GET',
          url: '/invalid-jwks/resource',
          headers: {
            authorization: `Bearer ${await issueToken()}`,
          },
        });

        expect(recoveredReadyResponse.statusCode).toBe(200);
        expect(recoveredProtectedResponse.statusCode).toBe(200);
        expect(recoveredProtectedResponse.body).toBe('ok');
      } finally {
        await app.close();
      }
    } finally {
      dateNow.mockRestore();
      restoreEnvironment();
    }
  });

  it('removes client identity headers from public routes', async () => {
    const upstream = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          userId: request.headers['x-user-id'] ?? null,
          userRole: request.headers['x-user-role'] ?? null,
        }),
      );
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);
    const app = await buildApp({
      gatewayConfig: {
        routes: [
          {
            id: 'public',
            prefix: '/public',
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
        url: '/public/resource',
        headers: {
          'x-user-id': 'spoofed-user',
          'x-user-role': 'super',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        userId: null,
        userRole: null,
      });
    } finally {
      await app.close();
    }
  });
});
