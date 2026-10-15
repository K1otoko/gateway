import {
  createRemoteJWKSet,
  importJWK,
  jwtVerify,
  type JWK,
  type JWK_EC_Public,
  type JSONWebKeySet,
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

export interface RemoteAccessTokenVerifier extends AccessTokenVerifier {
  ensureReady(): Promise<boolean>;
  isReady(): boolean;
  preload(): Promise<void>;
}

export interface AccessTokenVerifierOptions {
  audience: string;
  clockToleranceSeconds: number;
  issuer: string;
  key: JWTVerifyGetKey;
}

export class AccessTokenVerificationUnavailableError extends Error {
  override readonly name = 'AccessTokenVerificationUnavailableError';
}

type Es256PublicJwk = JWK_EC_Public & { kty: 'EC' };
const JWKS_RETRY_INTERVAL_MS = 5_000;

function isEs256SigningKey(jwk: JWK): jwk is Es256PublicJwk {
  return (
    jwk.kty === 'EC' &&
    jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' &&
    typeof jwk.y === 'string' &&
    jwk.d === undefined &&
    (jwk.alg === undefined || jwk.alg === 'ES256') &&
    (jwk.use === undefined || jwk.use === 'sig') &&
    (jwk.key_ops === undefined || jwk.key_ops.includes('verify'))
  );
}

async function assertUsableEs256SigningKey(
  jwks: JSONWebKeySet | undefined,
): Promise<void> {
  let keyImportError: unknown;

  for (const jwk of jwks?.keys ?? []) {
    if (!isEs256SigningKey(jwk)) {
      continue;
    }

    try {
      const key = await importJWK(jwk, 'ES256');

      if (key.type === 'public') {
        return;
      }
    } catch (error) {
      keyImportError = error;
    }
  }

  throw new AccessTokenVerificationUnavailableError(
    'JWKS does not contain a usable ES256 signing public key',
    keyImportError === undefined ? undefined : { cause: keyImportError },
  );
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function unavailableError(
  error: unknown,
): AccessTokenVerificationUnavailableError {
  if (error instanceof AccessTokenVerificationUnavailableError) {
    return error;
  }

  return new AccessTokenVerificationUnavailableError(
    'Access token verification keys are unavailable',
    { cause: error },
  );
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
): RemoteAccessTokenVerifier {
  const remoteKeySet = createRemoteJWKSet(new URL(config.OIDC_JWKS_URI));
  let loadPromise: Promise<void> | undefined;
  let nextLoadAt = 0;
  let ready = false;

  const markReadyFromCache = async (): Promise<void> => {
    await assertUsableEs256SigningKey(remoteKeySet.jwks());
    ready = true;
  };

  const key: JWTVerifyGetKey = async (...args) => {
    try {
      const resolvedKey = await remoteKeySet(...args);

      if (!ready) {
        await markReadyFromCache();
      }

      return resolvedKey;
    } catch (error) {
      const errorCode = getErrorCode(error);

      if (
        errorCode === 'ERR_JWKS_NO_MATCHING_KEY' ||
        errorCode === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'
      ) {
        try {
          await markReadyFromCache();
        } catch (validationError) {
          ready = false;
          throw unavailableError(validationError);
        }

        throw error;
      }

      ready = false;
      throw unavailableError(error);
    }
  };

  const verify = createAccessTokenVerifier({
    audience: config.OIDC_AUDIENCE,
    clockToleranceSeconds: config.AUTH_CLOCK_TOLERANCE_SECONDS,
    issuer: config.OIDC_ISSUER,
    key,
  });

  const loadKeys = (): Promise<void> => {
    if (loadPromise === undefined) {
      loadPromise = (async () => {
        try {
          await remoteKeySet.reload();
          await markReadyFromCache();
        } catch (error) {
          ready = false;
          throw unavailableError(error);
        } finally {
          nextLoadAt = Date.now() + JWKS_RETRY_INTERVAL_MS;
        }
      })().finally(() => {
        loadPromise = undefined;
      });
    }

    return loadPromise;
  };

  const remoteVerifier = Object.assign(verify, {
    ensureReady: async () => {
      if (ready) {
        return true;
      }

      if (Date.now() < nextLoadAt) {
        return false;
      }

      try {
        await loadKeys();
        return true;
      } catch {
        return false;
      }
    },
    isReady: () => ready,
    preload: loadKeys,
  });

  return remoteVerifier;
}
