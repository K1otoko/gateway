import { describe, expect, it } from 'vitest';

import { parseTrustProxy } from '../src/config/env.js';
import {
  GatewayConfigurationError,
  parseGatewayConfig,
} from '../src/config/routes.js';

describe('parseGatewayConfig', () => {
  it('parses and normalizes a valid route configuration', () => {
    const config = parseGatewayConfig(`
routes:
  - id: users
    prefix: /api/users
    upstream: http://127.0.0.1:4000/
    rewritePrefix: /users
    timeoutMs: 5000
    auth:
      mode: required
      minRole: user
`);

    expect(config.routes).toEqual([
      {
        id: 'users',
        prefix: '/api/users',
        upstream: 'http://127.0.0.1:4000',
        rewritePrefix: '/users',
        timeoutMs: 5000,
        auth: {
          mode: 'required',
          minRole: 'user',
        },
      },
    ]);
  });

  it('rejects duplicate prefixes', () => {
    expect(() =>
      parseGatewayConfig(`
routes:
  - id: users
    prefix: /api
    upstream: http://127.0.0.1:4000
    auth:
      mode: public
  - id: orders
    prefix: /api
    upstream: http://127.0.0.1:5000
    auth:
      mode: public
`),
    ).toThrowError(GatewayConfigurationError);
  });

  it('rejects upstream URLs containing paths', () => {
    expect(() =>
      parseGatewayConfig(`
routes:
  - id: users
    prefix: /api
    upstream: http://127.0.0.1:4000/internal
    auth:
      mode: public
`),
    ).toThrow('use rewritePrefix for paths');
  });

  it('requires every route to declare an authentication policy', () => {
    expect(() =>
      parseGatewayConfig(`
routes:
  - id: users
    prefix: /api
    upstream: http://127.0.0.1:4000
`),
    ).toThrowError(GatewayConfigurationError);
  });

  it('rejects authenticated websocket routes', () => {
    expect(() =>
      parseGatewayConfig(`
routes:
  - id: events
    prefix: /events
    upstream: http://127.0.0.1:4000
    websocket: true
    auth:
      mode: required
      minRole: user
`),
    ).toThrow('cannot require authentication when websocket is enabled');
  });
});

describe('parseTrustProxy', () => {
  it('parses boolean and trusted address values', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy('127.0.0.1, 10.0.0.0/8')).toBe(
      '127.0.0.1, 10.0.0.0/8',
    );
  });

  it('parses a non-negative trusted hop count', () => {
    expect(parseTrustProxy('0')).toBe(false);

    const trustTwoHops = parseTrustProxy('2');

    expect(trustTwoHops).toBeTypeOf('function');

    if (typeof trustTwoHops === 'function') {
      expect(trustTwoHops('127.0.0.1', 0)).toBe(true);
      expect(trustTwoHops('10.0.0.1', 1)).toBe(true);
      expect(trustTwoHops('203.0.113.1', 2)).toBe(false);
    }
  });

  it('rejects an invalid trusted hop count', () => {
    expect(() => parseTrustProxy('-1')).toThrow(
      'TRUST_PROXY hop count must be a non-negative safe integer',
    );
  });
});
