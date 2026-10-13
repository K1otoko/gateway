import { describe, expect, it } from 'vitest';

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
`);

    expect(config.routes).toEqual([
      {
        id: 'users',
        prefix: '/api/users',
        upstream: 'http://127.0.0.1:4000',
        rewritePrefix: '/users',
        timeoutMs: 5000,
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
  - id: orders
    prefix: /api
    upstream: http://127.0.0.1:5000
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
`),
    ).toThrow('use rewritePrefix for paths');
  });
});
