import fastifyEnv from '@fastify/env';
import type { FastifyInstance } from 'fastify';

export interface AppConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  HOST: string;
  PORT: number;
  LOG_LEVEL: string;
  BODY_LIMIT: number;
  TRUST_PROXY: boolean;
  ROUTES_CONFIG_FILE: string;
  OIDC_ISSUER: string;
  OIDC_JWKS_URI: string;
  OIDC_AUDIENCE: string;
  AUTH_CLOCK_TOLERANCE_SECONDS: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}

const envSchema = {
  type: 'object',
  properties: {
    NODE_ENV: {
      type: 'string',
      enum: ['development', 'test', 'production'],
      default: 'development',
    },
    HOST: {
      type: 'string',
      default: '0.0.0.0',
    },
    PORT: {
      type: 'integer',
      minimum: 1,
      maximum: 65535,
      default: 3000,
    },
    LOG_LEVEL: {
      type: 'string',
      default: 'info',
    },
    BODY_LIMIT: {
      type: 'integer',
      minimum: 1,
      default: 1_048_576,
    },
    TRUST_PROXY: {
      type: 'boolean',
      default: false,
    },
    ROUTES_CONFIG_FILE: {
      type: 'string',
      minLength: 1,
      default: 'config/routes.yaml',
    },
    OIDC_ISSUER: {
      type: 'string',
      minLength: 1,
      default: 'http://127.0.0.1:4000/api/sso/oidc',
    },
    OIDC_JWKS_URI: {
      type: 'string',
      minLength: 1,
      default: 'http://127.0.0.1:4000/api/sso/oidc/jwks',
    },
    OIDC_AUDIENCE: {
      type: 'string',
      minLength: 1,
      default: 'urn:sso:api',
    },
    AUTH_CLOCK_TOLERANCE_SECONDS: {
      type: 'integer',
      minimum: 0,
      maximum: 300,
      default: 60,
    },
  },
} as const;

export async function registerEnvironment(app: FastifyInstance): Promise<void> {
  await app.register(fastifyEnv, {
    confKey: 'config',
    dotenv: false,
    schema: envSchema,
  });
}
