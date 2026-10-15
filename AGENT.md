# Gateway AI 工作说明

本文供在本仓库工作的 AI 使用。开始修改前先阅读本文、`README.md`、相关源码和
`docs/deployment.md`。若文档与代码不一致，以当前源码、测试和实际部署配置为准，
并在同一变更中修正文档。

## 1. 项目定位

本项目是基于 Fastify 5 和 TypeScript 的配置驱动 HTTP 网关，负责：

- 按 `config/routes.yaml` 注册固定上游的反向代理路由。
- 校验 SSO 签发的 ES256 access token。
- 按 `super > admin > user` 执行最低角色校验。
- 丢弃客户端伪造的 `X-User-*` 头，并向上游注入可信身份头。
- 提供逐路由限流、超时、路径改写、请求 ID 和健康检查。

本项目不负责：

- 用户登录、令牌签发和账号管理，这些属于 `../sso`。
- 登录页面和令牌存储，这些属于 `../sso-fe`。
- Deployment Hook 的签名、防重放和幂等，这些必须由 `../deployment` 实现。
- 业务服务内部权限。Gateway 的角色门槛不是业务资源授权的替代品。

## 2. 当前状态

- `GET /api/gateway/ping` 是公开连通性探针，不检查 SSO、JWKS 或业务上游。
- `GET /health/live` 只检查进程存活。
- `GET /health/ready` 在存在受保护路由时检查 JWKS 是否可用。
- 仓库中的 `config/routes.yaml` 是本地示例，当前生产服务器配置仍为
  `routes: []`。
- 路由只在启动时读取，修改 YAML 后必须重启服务。
- 受保护路由启动时会预加载 JWKS。预加载失败不会阻止公开路由启动，但就绪检查
  和受保护请求会返回 503，直到密钥加载恢复。

## 3. 技术与目录

- Node.js 24+，pnpm 10.25.0，ESM，TypeScript strict。
- `src/app.ts`：应用装配及 JWKS 就绪状态。
- `src/server.ts`：进程启动和退出。
- `src/config/env.ts`：运行时环境变量及 `TRUST_PROXY` 解析。
- `src/config/routes.ts`：YAML schema、上游约束和重复路由校验。
- `src/auth/`：JWT 验签、角色判断和授权 Hook。
- `src/gateway/register-proxies.ts`：代理注册、改写和超时。
- `src/gateway/headers.ts`：请求头清理、身份头和请求 ID。
- `src/routes/health.ts`：公开 ping、存活和就绪接口。
- `test/`：配置、代理和认证行为测试。
- `compose.yaml`、`Dockerfile`、`.github/workflows/deploy.yml`：生产发布。

## 4. 本地工作

```bash
pnpm install
cp .env.example .env
pnpm dev
```

常用验证：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm exec eslint <本次修改的文件...>
```

只对本次修改或新增的文件执行 ESLint，不运行全项目 lint 或 format。不要删除现有
`console.log`。纯 Markdown 变更没有配置专用 lint 时无需运行代码 lint。

测试应优先通过 `buildApp` 注入 `gatewayConfig` 和假的
`accessTokenVerifier`，避免依赖真实 SSO 或网络。代理行为测试需覆盖传入路径、
改写路径、身份头、状态码及超时。

## 5. 环境变量

应用直接读取：

- `NODE_ENV`、`HOST`、`PORT`
- `LOG_LEVEL`、`BODY_LIMIT`、`TRUST_PROXY`
- `ROUTES_CONFIG_FILE`
- `OIDC_ISSUER`、`OIDC_JWKS_URI`、`OIDC_AUDIENCE`
- `AUTH_CLOCK_TOLERANCE_SECONDS`

Compose 另外使用宿主机级变量：

- `GATEWAY_IMAGE`、`IMAGE_TAG`
- `GATEWAY_BIND_ADDRESS`、`GATEWAY_PORT`
- `ROUTES_CONFIG_PATH`
- `GATEWAY_NETWORK`、`SSO_NETWORK`

`OIDC_ISSUER` 必须与令牌中的 `iss` 完全一致；生产值是公网 issuer。
`OIDC_JWKS_URI` 可以是容器内地址，生产通过 SSO 网络访问
`http://sso:4000/api/sso/oidc/jwks`。不要把 `.env`、令牌、私钥或任何凭据提交
到仓库。

`TRUST_PROXY` 支持 `false`、`true`、非负跳数、IP/CIDR 或逗号分隔的可信地址。
生产应信任实际网桥和代理地址，不要无约束使用 `true`。

## 6. 路由与认证契约

每条路由必须显式配置：

- 唯一 `id`，以及除根路径 `/` 外无尾斜杠的 `prefix`
- 仅包含 origin 的 HTTP(S) `upstream`，不得含凭据、路径、查询或 fragment
- `auth.mode` 为 `public`，或 `required` 并提供 `minRole`

可选字段为 `rewritePrefix`、`timeoutMs`、`rateLimit` 和 `websocket`。受保护的
WebSocket 路由会被拒绝，因为当前 HTTP 授权 Hook 不覆盖升级请求。

受保护请求必须使用 `Authorization: Bearer <token>`。Gateway 校验签名、issuer、
audience、有效期、`typ=at+jwt`、`token_use=user`、subject 和 role。关键响应：

- 401 `invalid_token`：缺失、格式错误或令牌无效。
- 403 `insufficient_role`：令牌有效但角色不足。
- 503 `authentication_unavailable`：JWKS 网络、超时或配置不可用。
- 502：上游不可达。
- 504：上游超过路由超时。

修改鉴权或头部逻辑时，必须证明客户端不能伪造身份，并保持请求 ID 可追踪。

## 7. 跨项目与生产拓扑

2026-10-15 已核验的链路：

```text
浏览器
  -> https://sso.xpeach.top
  -> 前端 Nginx 101.200.164.181
  -> /api/** 原样代理到 https://api.xpeach.top
  -> 后端 Nginx 82.157.201.240
  -> /api/gateway/** 到宿主机 127.0.0.1:3000
  -> Gateway 容器
```

生产目录为后端服务器 `/project/gateway`。Gateway 容器同时加入：

- `sso` 外部网络：通过服务名 `sso:4000` 读取 JWKS。
- `gateway` 网络：后续通过服务名 `deployment:4100` 访问 Deployment。

必须先启动 SSO，再启动 Gateway。3000 只绑定宿主机回环地址，健康接口不经公网
Nginx 暴露。现有前端 `/api/` 代理和后端 `/api/gateway` 代理已覆盖本服务，
新增 ping 或业务路由不需要修改 Nginx。

Deployment 上线后的计划路由是：

- 公开 `/api/gateway/deployment/hooks/**` 改写为 `/api/hooks/**`。
- 受保护 `/api/gateway/deployment/**` 改写为 `/api/**`，最低角色 `super`。

公开 Hook 路由应先于较宽的受保护前缀注册。Deployment 未实现签名、防重放、
幂等和就绪检查前，不要启用生产路由。

完整服务器检查和发布步骤见仓库上级目录的 `../生产部署前检查清单.md`。

## 8. 修改规则

1. 开始前运行 `git status --short`，保留所有非本任务改动。
2. 路由 schema、README 示例、部署文档和测试必须随契约一起更新。
3. 不允许根据客户端参数动态选择任意上游，避免开放代理和 SSRF。
4. 新公开路由必须明确说明为什么无需认证，并补充滥用与限流分析。
5. 不在日志中记录 Authorization、Cookie、令牌、密钥或完整敏感请求体。
6. 不擅自修改生产 Nginx、服务器 `.env` 或路由文件；这些属于独立部署操作。
7. 不运行破坏性 Git 命令，不覆盖用户未提交的修改。

## 9. 完成标准

按变更范围完成以下检查：

- 相关单元/集成测试通过，并覆盖成功和失败路径。
- `pnpm typecheck` 通过。
- 修改过的代码文件逐一通过 ESLint。
- 影响运行产物时执行 `pnpm build`。
- 路由变更已验证前缀边界、路径改写、鉴权、角色、超时和上游失败。
- 部署配置变更已执行 `docker compose ... config --quiet`，且未输出或提交秘密。
- 发布后本机检查 `/health/live`、`/health/ready`，公网用
  `/api/gateway/ping` 验证整条 Nginx 链路。
