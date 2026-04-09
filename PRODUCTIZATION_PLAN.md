# MyClaw 产品化方案（初版）

## 1. 目标与交付形态

本项目建议拆分为两个可交付物：

1. `myclaw-core`：网关 + Feishu Bridge + Cron + Copilot 执行。
2. `myclaw-sync`：独立同步查询服务（REST API），用于跨终端查看 jobs/runs。

推荐先发布 Docker 自托管版，便于他人一键部署和复用。

## 2. 产品化范围（MVP）

### 2.1 必须具备

1. 一键启动：提供 `docker-compose.yml`。
2. 可配置：提供 `.env.example`，按模块分组。
3. 可恢复：容器 `restart: unless-stopped`。
4. 可观测：保留 `/health` 并落盘日志。
5. 可持久化：`data/` 目录挂载卷。

### 2.2 安全基线

1. `myclaw-sync` 默认不建议裸露公网。
2. 生产环境建议通过 Nginx/Caddy 暴露并加 HTTPS。
3. 至少增加一种鉴权方式（Basic Auth 或 Bearer Token）。

## 3. 产品目录结构草案

```text
myclaw/
├─ product/
│  ├─ core/
│  │  ├─ Dockerfile
│  │  ├─ .dockerignore
│  │  └─ entrypoint.sh
│  ├─ sync/
│  │  ├─ Dockerfile
│  │  ├─ .dockerignore
│  │  └─ entrypoint.sh
│  ├─ nginx/
│  │  ├─ nginx.conf
│  │  └─ conf.d/
│  │     └─ myclaw.conf
│  └─ env/
│     ├─ core.env.example
│     ├─ sync.env.example
│     └─ compose.env.example
├─ src/
│  ├─ index.mjs
│  ├─ bridge/
│  ├─ cron/
│  ├─ gateway/
│  ├─ model/
│  └─ sync/
│     └─ http-server.mjs
├─ data/
│  ├─ cron-jobs.json
│  └─ cron-jobs-sync.json
├─ docker-compose.yml
├─ package.json
├─ .env.example
├─ README.md
└─ PRODUCTIZATION_PLAN.md
```

说明：

1. `product/core` 和 `product/sync` 分别构建两个镜像，便于独立扩缩容。
2. `data/` 必须做卷挂载，防止容器重建导致任务状态丢失。
3. `product/nginx` 可选，用于公网入口、TLS、鉴权和限流。

## 4. docker-compose 初版清单

> 该清单用于本地/云服务器快速起步。生产环境建议启用 `nginx` 服务并加 TLS。

```yaml
version: "3.9"

services:
  myclaw-core:
    build:
      context: .
      dockerfile: product/core/Dockerfile
    container_name: myclaw-core
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "18789:18789"
    volumes:
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:18789/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3

  myclaw-sync:
    build:
      context: .
      dockerfile: product/sync/Dockerfile
    container_name: myclaw-sync
    restart: unless-stopped
    environment:
      SYNC_PORT: "18790"
      SYNC_DB_FILE: "data/cron-jobs-sync.json"
    ports:
      - "18790:18790"
    volumes:
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:18790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3

  # 生产建议开启：统一公网入口 + HTTPS + 鉴权
  # nginx:
  #   image: nginx:1.27-alpine
  #   container_name: myclaw-nginx
  #   restart: unless-stopped
  #   depends_on:
  #     - myclaw-core
  #     - myclaw-sync
  #   ports:
  #     - "80:80"
  #     - "443:443"
  #   volumes:
  #     - ./product/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
  #     - ./product/nginx/conf.d:/etc/nginx/conf.d:ro
  #     - ./certs:/etc/nginx/certs:ro

networks:
  default:
    name: myclaw-net
```

## 5. Dockerfile 初版建议

### 5.1 `product/core/Dockerfile`

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY .env.example ./
RUN mkdir -p /app/data
EXPOSE 18789
CMD ["node", "src/index.mjs"]
```

### 5.2 `product/sync/Dockerfile`

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY src/sync/http-server.mjs ./src/sync/http-server.mjs
RUN mkdir -p /app/data
ENV SYNC_PORT=18790
ENV SYNC_DB_FILE=data/cron-jobs-sync.json
EXPOSE 18790
CMD ["node", "src/sync/http-server.mjs"]
```

## 6. 发行与版本策略（建议）

1. 使用语义化版本：`v0.1.0`, `v0.2.0`。
2. 每次发布记录变更日志和升级说明。
3. 提供两种发布产物：
   - Git Tag + Source Archive。
   - Docker 镜像（推荐推送到 GHCR）。

## 7. 快速上线清单（运维）

1. 云安全组仅开放必要端口（22/80/443，必要时 18789/18790）。
2. 生产环境启用 HTTPS。
3. 同步服务增加鉴权，避免匿名公网写入。
4. 持久化目录定时备份（`data/`）。
5. 设置监控与告警（至少进程存活和健康检查失败告警）。

## 8. 下一步实施顺序

1. 新增 `product/core/Dockerfile` 与 `product/sync/Dockerfile`。
2. 新增根目录 `docker-compose.yml`。
3. 补充 `product/env/*.env.example`。
4. 在 `README.md` 增加 5 分钟上手与生产部署章节。
5. 增加 `sync` 鉴权（Bearer Token 或 Nginx Basic Auth）。
