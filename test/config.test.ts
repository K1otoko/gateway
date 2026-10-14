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
