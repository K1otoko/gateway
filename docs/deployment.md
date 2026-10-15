# 使用 GitHub Actions 和 Docker 部署

本文采用以下发布方式：

1. 推送代码到 `master`。
2. GitHub Actions 执行类型检查、测试和构建。
3. Actions 构建 Docker 镜像并推送到阿里云容器镜像服务（ACR）。
4. Actions 通过 SSH 登录服务器，上传 `compose.yaml`。
5. 服务器拉取当前 commit 对应的镜像并启动容器。

生产环境变量和路由配置只保存在服务器，不会被工作流覆盖。

## 一、仓库中的部署文件

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | 使用 Node.js 24 构建生产镜像 |
| `.dockerignore` | 防止本地依赖、构建结果和环境变量进入镜像 |
| `compose.yaml` | 定义生产容器、健康检查、端口和路由文件挂载 |
| `deploy/.env.example` | 服务器环境变量模板 |
| `.github/workflows/deploy.yml` | 校验、构建、推送和部署工作流 |

镜像包含一份默认的 `config/routes.yaml`，但 Compose 会用服务器上的生产路由文件覆盖它。

## 二、部署前确认

服务器需要满足：

- Linux 服务器。
- Docker Engine 已安装并正在运行。
- Docker Compose v2.20 或更高版本。工作流使用了 `docker compose up --wait`。
- 部署用户可以通过 SSH 登录。
- 部署用户有权限运行 Docker。
- ACR 中已经创建命名空间和 `gateway` 镜像仓库。
- 服务器和 GitHub Actions 使用的 ACR 账号都具有镜像访问权限。

在服务器执行：

```bash
docker version
docker compose version
docker run --rm hello-world
```

如果 `docker compose version` 不存在，需要安装 Docker Compose Plugin，而不是旧的 `docker-compose` 命令。

## 三、准备服务器用户和目录

以下命令以 `deploy` 用户和 `/project/gateway` 目录为例。已有合适用户时可以直接复用。

在服务器执行：

```bash
sudo useradd --create-home --shell /bin/bash deploy
sudo usermod -aG docker deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo install -d -m 755 -o deploy -g deploy /project/gateway/config
```

将用户加入 `docker` 组后，需要退出 SSH 并重新登录。使用下面的命令确认权限：

```bash
docker ps
```

Docker 组具有接近 root 的权限，只应授予专用且受控的部署用户。

## 四、配置生产环境变量

在服务器创建 `/project/gateway/.env`：

```dotenv
GATEWAY_BIND_ADDRESS=127.0.0.1
GATEWAY_PORT=3000

LOG_LEVEL=info
BODY_LIMIT=1048576
TRUST_PROXY=true

ROUTES_CONFIG_PATH=./config/routes.yaml
GATEWAY_NETWORK=gateway
SSO_NETWORK=sso

OIDC_ISSUER=https://example.com/api/sso/oidc
OIDC_JWKS_URI=http://sso:4000/api/sso/oidc/jwks
OIDC_AUDIENCE=urn:sso:api
AUTH_CLOCK_TOLERANCE_SECONDS=60
```

也可以先从仓库复制模板：

```bash
scp deploy/.env.example deploy@YOUR_SERVER:/project/gateway/.env
```

变量说明：

| 变量 | 建议值 | 说明 |
| --- | --- | --- |
| `GATEWAY_BIND_ADDRESS` | `127.0.0.1` | 仅允许本机反向代理访问 |
| `GATEWAY_PORT` | `3000` | 宿主机监听端口 |
| `LOG_LEVEL` | `info` | Pino 日志级别 |
| `BODY_LIMIT` | `1048576` | 最大请求体字节数 |
| `TRUST_PROXY` | `true` | `false`、`true`、可信跳数或可信代理 IP/CIDR 列表 |
| `ROUTES_CONFIG_PATH` | `./config/routes.yaml` | 生产路由文件路径 |
| `GATEWAY_NETWORK` | `gateway` | Docker 网络名称 |
| `SSO_NETWORK` | `sso` | 已运行的 SSO Compose 网络名称 |
| `OIDC_ISSUER` | SSO 对外 issuer | 必须与 access token 的 `iss` 完全一致 |
| `OIDC_JWKS_URI` | `http://sso:4000/api/sso/oidc/jwks` | Gateway 通过 SSO Docker 网络拉取 ES256 公钥 |
| `OIDC_AUDIENCE` | `urn:sso:api` | access token 必须包含的 audience |
| `AUTH_CLOCK_TOLERANCE_SECONDS` | `60` | JWT 时钟偏移容忍秒数 |

当端口直接暴露到公网时，应将 `TRUST_PROXY` 设置为 `false`。只有请求必然经过可信 Nginx、Caddy 或负载均衡器时才启用该配置。生产环境应优先填写直接连接 Gateway 的代理 IP/CIDR；`true` 会信任所有转发头，纯跳数也无法验证直接连接方。

不要把服务器的 `.env` 提交到 Git。

## 五、配置生产路由

在服务器创建 `/project/gateway/config/routes.yaml`。例如：

```yaml
routes:
  - id: user-service
    prefix: /api/gateway/users
    upstream: http://host.docker.internal:4000
    rewritePrefix: /users
    timeoutMs: 5000
    auth:
      mode: required
      minRole: user
    rateLimit:
      max: 100
      timeWindow: 60000
```

`upstream` 必须根据上游服务的位置配置。Gateway Compose 会加入现有的
`sso` 外部网络，因此部署 Gateway 前必须先启动 SSO，并确认
`docker network inspect sso` 成功。

### 上游运行在宿主机

使用：

```yaml
upstream: http://host.docker.internal:4000
```

`compose.yaml` 已将 `host.docker.internal` 映射到 Linux 宿主机。宿主机上的服务需要监听 Docker 网桥可以访问的地址，不能只监听 `127.0.0.1`。

### 上游也是 Docker 容器

让上游容器加入 `gateway` 网络，然后使用容器或服务名称：

```yaml
upstream: http://user-service:4000
```

其他 Compose 项目可以声明外部网络：

```yaml
networks:
  gateway:
    external: true
    name: gateway
```

并将对应服务连接到该网络。

### 上游位于其他服务器

使用可从 gateway 容器访问的内网域名或 IP：

```yaml
upstream: http://10.0.1.20:4000
```

上游 URL 只能包含协议、主机和端口，不能包含路径或认证信息。路径转换应使用 `rewritePrefix`。
每条路由必须显式配置 `auth`。公开路由使用 `auth: { mode: public }`；
受保护路由使用 `mode: required` 并配置 `minRole`（`user`、`admin` 或 `super`）。

Deployment 的公网 hook 使用更具体的公开前缀，其他接口继续要求 `super`：

```yaml
routes:
  - id: deployment-hooks
    prefix: /api/gateway/deployment/hooks
    upstream: http://deployment:4100
    rewritePrefix: /api/hooks
    timeoutMs: 5000
    auth:
      mode: public

  - id: deployment
    prefix: /api/gateway/deployment
    upstream: http://deployment:4100
    rewritePrefix: /api
    timeoutMs: 5000
    auth:
      mode: required
      minRole: super
```

Gateway 只负责公开该路径并转发请求，hook 签名校验和具体端点由 Deployment 实现。
Deployment 容器必须加入名为 `gateway` 的外部 Docker 网络，并在该网络中使用
`deployment` 服务名；不要依赖只绑定宿主机 `127.0.0.1:4100` 的发布端口。

修改路由后执行：

```bash
cd /project/gateway
docker compose --env-file .env --env-file .image.env restart gateway
```

应用只在启动时读取路由文件。

## 六、创建 GitHub Actions SSH 密钥

在可信的管理机器上创建专用密钥，不要复用个人 SSH 密钥：

```bash
ssh-keygen \
  -t ed25519 \
  -C github-actions-gateway \
  -f ./gateway-actions \
  -N ''
```

将公钥安装到服务器：

```bash
ssh-copy-id -i ./gateway-actions.pub -p 22 deploy@YOUR_SERVER
```

确认密钥可以登录：

```bash
ssh -i ./gateway-actions -p 22 deploy@YOUR_SERVER
```

私钥 `gateway-actions` 的完整内容稍后配置为 GitHub Secret。公钥可以保留在服务器，私钥不要提交到仓库。

## 七、获取服务器 SSH 主机指纹

在可信网络中执行：

```bash
ssh-keyscan -H -p 22 YOUR_SERVER > gateway-known-hosts
ssh-keygen -lf gateway-known-hosts
```

通过云服务商控制台或服务器控制台核对指纹，不能只依赖 `ssh-keyscan` 的结果。`gateway-known-hosts` 的完整内容将配置为 GitHub Secret。

## 八、配置阿里云 ACR

本项目使用以下 ACR 个人版镜像仓库：

```text
crpi-aesb6g2i9nvevyft.cn-beijing.personal.cr.aliyuncs.com/k1otoko/gateway
```

在阿里云 ACR 控制台的“访问凭证”页面获取准确的登录用户名，并设置独立的 Registry 固定密码。该密码不是阿里云控制台登录密码。

```bash
read -rsp "ACR password: " ACR_PASSWORD
echo
printf '%s' "$ACR_PASSWORD" |
  docker login \
    --username YOUR_ACR_USERNAME \
    --password-stdin \
    crpi-aesb6g2i9nvevyft.cn-beijing.personal.cr.aliyuncs.com
unset ACR_PASSWORD
```

成功时会显示 `Login Succeeded`。每次部署使用 commit SHA 标签，同时发布 `latest` 标签用于人工查看。

## 九、配置 GitHub Environment 和 Secrets

进入：

```text
GitHub repository
  -> Settings
  -> Environments
  -> New environment
  -> production
```

在 `production` Environment 的 Variables 中添加：

| Variable | 值 |
| --- | --- |
| `ACR_IMAGE` | `crpi-aesb6g2i9nvevyft.cn-beijing.personal.cr.aliyuncs.com/k1otoko/gateway` |

建议将以下 Secrets 配置在 `production` Environment 中：

| Secret | 示例 | 说明 |
| --- | --- | --- |
| `ACR_USERNAME` | ACR 访问凭证页面显示的用户名 | 镜像仓库登录用户名 |
| `ACR_PASSWORD` | ACR Registry 固定密码 | 不是阿里云控制台密码 |
| `DEPLOY_HOST` | `gateway.example.com` | 不包含 `https://` |
| `DEPLOY_PORT` | `22` | SSH 端口，必须填写 |
| `DEPLOY_USER` | `deploy` | 部署用户 |
| `DEPLOY_PATH` | `/project/gateway` | 服务器部署目录 |
| `DEPLOY_SSH_KEY` | `-----BEGIN OPENSSH...` | 专用 SSH 私钥完整内容 |
| `DEPLOY_KNOWN_HOSTS` | `gateway.example.com ssh-ed25519...` | 已核验的主机记录 |

Environment 可以增加 Required reviewers，使生产发布必须人工批准。

工作流会从 `ACR_IMAGE` 自动解析 ACR 登录域名。不要在变量中添加 `https://` 或镜像标签。

## 十、配置域名、HTTPS 和防火墙

将域名的 A/AAAA 记录指向服务器。推荐只开放：

- SSH 端口，仅允许可信来源访问。
- TCP 80，用于 HTTP 和证书签发。
- TCP 443，用于 HTTPS。

不要向公网开放 3000 端口。默认 Compose 配置只监听 `127.0.0.1:3000`。

下面是 Nginx HTTP 配置示例：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name gateway.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

可以使用 Certbot 签发并自动配置 HTTPS：

```bash
sudo certbot --nginx -d gateway.example.com
```

签发前必须确保 DNS 已生效，并且 80、443 端口可以从公网访问。

## 十一、首次发布

发布前，服务器至少应存在：

```text
/project/gateway/
├── .env
└── config/
    └── routes.yaml
```

将部署配置提交并推送到 `master`：

```bash
git add Dockerfile .dockerignore compose.yaml deploy docs .github README.md .gitignore
git commit -m "configure Docker deployment"
git push origin master
```

GitHub Actions 会依次：

1. 安装锁定版本的依赖。
2. 执行类型检查、测试和 TypeScript 构建。
3. 登录 ACR，构建并推送镜像。
4. 创建服务器部署目录并上传 `compose.yaml`。
5. 写入只包含镜像名称和 commit SHA 的 `.image.env`。
6. 校验 Compose 配置、拉取镜像并等待健康检查通过。
7. 如果新容器部署失败，使用 `.image.env.previous` 自动恢复上一镜像，并将工作流标记为失败。

## 十二、发布后验证

在服务器执行：

```bash
cd /project/gateway
docker compose --env-file .env --env-file .image.env ps
docker compose --env-file .env --env-file .image.env logs --tail=100 gateway
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

通过公网域名检查：

```bash
curl --fail https://api.xpeach.top/api/gateway/ping
curl --fail https://sso.xpeach.top/api/gateway/ping
```

`/health/ready` 确认 gateway 已加载路由；存在受保护路由时，还要求 JWKS 已成功加载且包含可用的 ES256 签名公钥。它不会主动检查每个业务上游是否可用。
`/api/gateway/ping` 是公开的链路探针，用于确认请求已经经过现有 Nginx
代理到达 Gateway，不检查 SSO、JWKS 或业务上游。

## 十三、回滚

工作流在每次更新前将当前镜像信息保存到 `.image.env.previous`。新版本拉取、启动或健康检查失败时会自动尝试恢复上一镜像。

需要手动恢复上一镜像时，在服务器执行：

```bash
cd /project/gateway
cp .image.env.previous .image.env
docker compose --env-file .env --env-file .image.env pull gateway
docker compose --env-file .env --env-file .image.env up \
  -d \
  --wait \
  --wait-timeout 90 \
  gateway
```

需要恢复到更早版本时，在 GitHub Actions 历史或 ACR 镜像仓库中找到对应的 commit SHA，然后执行：

```bash
cd /project/gateway

cat > .image.env <<'EOF'
GATEWAY_IMAGE=crpi-aesb6g2i9nvevyft.cn-beijing.personal.cr.aliyuncs.com/k1otoko/gateway
IMAGE_TAG=REPLACE_WITH_COMMIT_SHA
EOF

docker compose --env-file .env --env-file .image.env pull gateway
docker compose --env-file .env --env-file .image.env up \
  -d \
  --wait \
  --wait-timeout 90 \
  gateway
```

最后重新检查容器状态、日志和健康接口。

## 十四、常见问题

### 容器启动后无法访问宿主机服务

确认路由使用 `host.docker.internal`，并确认宿主机服务没有只监听 `127.0.0.1`。同时检查服务器防火墙是否允许 Docker 网桥访问对应端口。

### `pull access denied`

服务器没有登录对应的 ACR 域名，Registry 密码错误，或者账号没有该镜像仓库的读取权限。

### `Missing GitHub secret`

检查八个 Secrets 和 `ACR_IMAGE` Variable 是否配置在名为 `production` 的 Environment，名称和大小写必须完全一致。

### 容器一直显示 `unhealthy`

查看日志：

```bash
docker compose --env-file .env --env-file .image.env logs gateway
```

重点检查：

- `.env` 中变量是否合法。
- `config/routes.yaml` 是否存在且 YAML 格式正确。
- `ROUTES_CONFIG_PATH` 是否指向正确文件。
- 路由 ID 和 prefix 是否重复。
- upstream URL 是否包含不允许的路径或认证信息。

### SSH 主机验证失败

服务器重装或 SSH Host Key 发生变化时，重新通过可信渠道核验指纹，然后更新 `DEPLOY_KNOWN_HOSTS`。不要关闭 Strict Host Key Checking。

### 发布存在短暂中断

当前 Compose 配置是单实例发布，容器替换期间可能出现短暂中断。需要严格零停机时，应增加负载均衡器并采用双实例或蓝绿发布。
