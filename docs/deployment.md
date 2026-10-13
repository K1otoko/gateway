# 使用 GitHub Actions 和 Docker 部署

本文采用以下发布方式：

1. 推送代码到 `master`。
2. GitHub Actions 执行类型检查、测试和构建。
3. Actions 构建 Docker 镜像并推送到 GitHub Container Registry（GHCR）。
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
- 服务器能访问 `ghcr.io`。
- 若镜像是私有的，服务器已登录 GHCR。

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
| `TRUST_PROXY` | `true` | 是否信任代理转发头 |
| `ROUTES_CONFIG_PATH` | `./config/routes.yaml` | 生产路由文件路径 |
| `GATEWAY_NETWORK` | `gateway` | Docker 网络名称 |

当端口直接暴露到公网时，应将 `TRUST_PROXY` 设置为 `false`。只有请求必然经过可信 Nginx、Caddy 或负载均衡器时才设置为 `true`。

不要把服务器的 `.env` 提交到 Git。

## 五、配置生产路由

在服务器创建 `/project/gateway/config/routes.yaml`。例如：

```yaml
routes:
  - id: user-service
    prefix: /api/users
    upstream: http://host.docker.internal:4000
    rewritePrefix: /users
    timeoutMs: 5000
    rateLimit:
      max: 100
      timeWindow: 60000
```

`upstream` 必须根据上游服务的位置配置。

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

## 八、配置 GHCR

工作流通过仓库自带的 `GITHUB_TOKEN` 推送：

```text
ghcr.io/k1otoko/gateway:<commit-sha>
ghcr.io/k1otoko/gateway:latest
```

每次部署实际使用不可变的 commit SHA 标签，`latest` 只用于人工查看或临时运行。

首次执行后，可以在 GitHub 仓库或个人主页的 Packages 页面调整镜像可见性。

### 私有镜像

如果镜像保持私有，需要创建至少具有 `read:packages` 权限的 GitHub Personal Access Token，然后在服务器登录：

```bash
echo 'YOUR_GHCR_TOKEN' | docker login ghcr.io -u K1otoko --password-stdin
```

组织启用了 SSO 时，还需要为 Token 授权对应组织。登录信息会保存在部署用户的 Docker 配置中。

### 公开镜像

公开镜像通常不需要服务器登录 GHCR，但仍建议先手动执行一次 `docker pull` 验证服务器网络。

## 九、配置 GitHub Environment 和 Secrets

进入：

```text
GitHub repository
  -> Settings
  -> Environments
  -> New environment
  -> production
```

建议将以下 Secrets 配置在 `production` Environment 中：

| Secret | 示例 | 说明 |
| --- | --- | --- |
| `DEPLOY_HOST` | `gateway.example.com` | 不包含 `https://` |
| `DEPLOY_PORT` | `22` | SSH 端口，必须填写 |
| `DEPLOY_USER` | `deploy` | 部署用户 |
| `DEPLOY_PATH` | `/project/gateway` | 服务器部署目录 |
| `DEPLOY_SSH_KEY` | `-----BEGIN OPENSSH...` | 专用 SSH 私钥完整内容 |
| `DEPLOY_KNOWN_HOSTS` | `gateway.example.com ssh-ed25519...` | 已核验的主机记录 |

Environment 可以增加 Required reviewers，使生产发布必须人工批准。

同时检查仓库设置：

```text
Settings -> Actions -> General -> Workflow permissions
```

组织或仓库策略必须允许工作流写入 Packages。工作流本身已经声明：

```yaml
permissions:
  contents: read
  packages: write
```

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
3. 构建并推送 GHCR 镜像。
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
curl --fail https://gateway.example.com/health/ready
```

`/health/ready` 当前只确认 gateway 已启动并加载路由，不会主动检查每个上游服务是否可用。

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

需要恢复到更早版本时，在 GitHub Actions 历史或 GHCR Packages 页面找到对应的 commit SHA，然后执行：

```bash
cd /project/gateway

cat > .image.env <<'EOF'
GATEWAY_IMAGE=ghcr.io/k1otoko/gateway
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

镜像是私有的，但服务器没有登录 GHCR，或 Token 缺少 `read:packages` 权限。

### `Missing GitHub secret`

工作流要求六个部署 Secret 全部存在。检查它们是否配置在名为 `production` 的 Environment，名称和大小写必须完全一致。

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
