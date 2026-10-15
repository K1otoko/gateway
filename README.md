# Gateway

A configuration-driven HTTP reverse proxy built with Fastify and TypeScript.

## Requirements

- Node.js 24 or newer
- pnpm 10

## Start locally

```bash
cp .env.example .env
pnpm install
pnpm dev
```

The default configuration exposes:

- `GET /api/gateway/ping` for frontend-to-gateway connectivity checks
- `GET /health/live` for liveness
- `GET /health/ready` for readiness
- authenticated `/api/gateway/example/*` requests proxied to
  `http://127.0.0.1:4000/*`

The example upstream and SSO server do not need to be running for the gateway
to start. When protected routes exist, the gateway preloads and validates the
SSO ES256 signing keys. If that fails, public routes remain available while
`/health/ready` and protected requests return `503` until key loading recovers.

## Authentication

Protected routes accept the SSO access token as
`Authorization: Bearer <token>`. The gateway verifies the ES256 signature,
`typ=at+jwt`, issuer, audience, expiration, `token_use=user`, subject, and role.
It then removes all client-supplied `X-User-*` headers and injects trusted
`X-User-Id` and `X-User-Role` headers for the upstream.

Invalid tokens return `401 invalid_token`; valid users below a route's minimum
role return `403 insufficient_role`. A JWKS network, timeout, or configuration
failure returns `503 authentication_unavailable`. Role levels are
`super > admin > user`.

## Route configuration

Routes are loaded from `config/routes.yaml` by default:

```yaml
routes:
  - id: user-service
    prefix: /api/gateway/users
    upstream: http://127.0.0.1:4000
    rewritePrefix: /users
    timeoutMs: 5000
    auth:
      mode: required
      minRole: user
    rateLimit:
      max: 100
      timeWindow: 60000
```

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Unique route identifier |
| `prefix` | yes | Incoming path prefix without a trailing slash |
| `upstream` | yes | HTTP or HTTPS origin without a path or credentials |
| `rewritePrefix` | no | Prefix sent to the upstream; defaults to an empty prefix |
| `timeoutMs` | no | Upstream timeout in milliseconds; defaults to `10000` |
| `auth` | yes | Explicit route policy: `public`, or `required` with `minRole` |
| `rateLimit` | no | Per-route request limit |
| `websocket` | no | Enables WebSocket proxying for public routes; defaults to `false` |

Route changes take effect after a restart. Only configured upstream origins can
receive proxied requests; clients cannot provide an arbitrary target URL.
Authenticated WebSocket routes are rejected because HTTP authorization hooks do
not protect upgrade requests.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `3000` | Listen port |
| `LOG_LEVEL` | `info` | Pino log level |
| `BODY_LIMIT` | `1048576` | Maximum request body size in bytes |
| `TRUST_PROXY` | `false` | `false`, `true`, trusted hop count, or trusted IP/CIDR list |
| `ROUTES_CONFIG_FILE` | `config/routes.yaml` | Route configuration path |
| `OIDC_ISSUER` | `http://127.0.0.1:4000/api/sso/oidc` | Exact access token issuer |
| `OIDC_JWKS_URI` | `{local issuer}/jwks` | JWKS URL; may use an internal address |
| `OIDC_AUDIENCE` | `urn:sso:api` | Required access token audience |
| `AUTH_CLOCK_TOLERANCE_SECONDS` | `60` | JWT clock skew tolerance, from 0 to 300 |

Enable `TRUST_PROXY` only when the gateway is behind a trusted reverse proxy.
Prefer an IP/CIDR value such as `127.0.0.1` over `true` or a hop count, because
it validates the directly connected proxy. In production, set `OIDC_ISSUER` to
the public issuer in the token and use `OIDC_JWKS_URI` for the reachable
internal JWKS endpoint.

## Commands

```bash
pnpm dev
pnpm build
pnpm start
pnpm test
pnpm typecheck
pnpm lint
```

Production startup:

```bash
NODE_ENV=production pnpm build
NODE_ENV=production pnpm start
```

## Docker deployment

The repository includes a production Docker image, Docker Compose
configuration, and a GitHub Actions workflow that publishes to Alibaba Cloud
Container Registry (ACR) and deploys over SSH.

See [docs/deployment.md](docs/deployment.md) for the complete server and GitHub
configuration guide.
