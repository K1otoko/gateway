import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';

import type { AppConfig } from '../config/env.js';
import { isRole, type Role } from './roles.js';

interface UserAccessTokenPayload extends JWTPayload {
  role?: unknown;
  token_use?: unknown;
}

export interface AuthenticatedUser {
  id: string;
  role: Role;
}

export type AccessTokenVerifier = (
  token: string,
) => Promise<AuthenticatedUser>;

export interface AccessTokenVerifierOptions {
  audience: string;
  clockToleranceSeconds: number;
  issuer: string;
  key: JWTVerifyGetKey;
}

export function createAccessTokenVerifier({
  audience,
  clockToleranceSeconds,
  issuer,
  key,
}: AccessTokenVerifierOptions): AccessTokenVerifier {
  return async (token) => {
    const { payload } = await jwtVerify<UserAccessTokenPayload>(token, key, {
      algorithms: ['ES256'],
      audience,
      clockTolerance: clockToleranceSeconds,
      issuer,
      requiredClaims: ['exp', 'role', 'token_use'],
      typ: 'at+jwt',
    });

    if (
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      payload.token_use !== 'user' ||
      !isRole(payload.role)
    ) {
      throw new Error('Access token contains invalid user claims');
    }

    return {
      id: payload.sub,
      role: payload.role,
    };
  };
}

export function createRemoteAccessTokenVerifier(
  config: AppConfig,
): AccessTokenVerifier {
  const remoteKeySet = createRemoteJWKSet(new URL(config.OIDC_JWKS_URI));

  return createAccessTokenVerifier({
    audience: config.OIDC_AUDIENCE,
    clockToleranceSeconds: config.AUTH_CLOCK_TOLERANCE_SECONDS,
    issuer: config.OIDC_ISSUER,
    key: remoteKeySet,
  });
}
