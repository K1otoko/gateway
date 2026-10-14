import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';

import type { RouteAuth } from '../config/routes.js';
import { roleAtLeast } from './roles.js';
import type {
  AccessTokenVerifier,
  AuthenticatedUser,
} from './token-verifier.js';

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedUser: AuthenticatedUser | null;
  }
}

export function registerAuthenticationContext(app: FastifyInstance): void {
  app.decorateRequest('authenticatedUser', null);
}

function rejectInvalidToken(reply: FastifyReply, requestId: string) {
  reply.header('www-authenticate', 'Bearer');

  return reply.code(401).send({
    error: 'invalid_token',
    requestId,
  });
}

function parseBearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);

  return match?.[1];
}

export function createAuthorizationHook(
  routeId: string,
  auth: RouteAuth,
  verifyAccessToken: AccessTokenVerifier | undefined,
): preHandlerAsyncHookHandler | undefined {
  if (auth.mode === 'public') {
    return undefined;
  }

  if (verifyAccessToken === undefined) {
    throw new Error(`Route "${routeId}" requires an access token verifier`);
  }

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = parseBearerToken(request.headers.authorization);

    if (token === undefined) {
      request.log.warn({ routeId }, 'access token missing or malformed');
      return rejectInvalidToken(reply, request.id);
    }

    let authenticatedUser: AuthenticatedUser;

    try {
      authenticatedUser = await verifyAccessToken(token);
    } catch (error) {
      const errorCode =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : undefined;

      request.log.warn({ errorCode, routeId }, 'access token rejected');
      return rejectInvalidToken(reply, request.id);
    }

    if (!roleAtLeast(authenticatedUser.role, auth.minRole)) {
      request.log.warn(
        {
          actualRole: authenticatedUser.role,
          requiredRole: auth.minRole,
          routeId,
          userId: authenticatedUser.id,
        },
        'access token has insufficient role',
      );

      return reply.code(403).send({
        error: 'insufficient_role',
        requestId: request.id,
      });
    }

    request.authenticatedUser = authenticatedUser;
  };
}
