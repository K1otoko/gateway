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

- `GET /health/live` for liveness
- `GET /health/ready` for readiness
- `/example/*` proxied to `http://127.0.0.1:4000/*`

The example upstream does not need to be running for the gateway to start.

## Route configuration

Routes are loaded from `config/routes.yaml` by default:

```yaml
routes:
  - id: user-service
    prefix: /api/users
    upstream: http://127.0.0.1:4000
    rewritePrefix: /users
    timeoutMs: 5000
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
| `rateLimit` | no | Per-route request limit |
| `websocket` | no | Enables WebSocket proxying; defaults to `false` |

Route changes take effect after a restart. Only configured upstream origins can
receive proxied requests; clients cannot provide an arbitrary target URL.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `3000` | Listen port |
| `LOG_LEVEL` | `info` | Pino log level |
| `BODY_LIMIT` | `1048576` | Maximum request body size in bytes |
| `TRUST_PROXY` | `false` | Trust incoming proxy headers |
| `ROUTES_CONFIG_FILE` | `config/routes.yaml` | Route configuration path |

Enable `TRUST_PROXY` only when the gateway is behind a trusted reverse proxy.

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
