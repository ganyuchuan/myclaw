# MyClaw MVP (Gateway v1)

This is a minimal Gateway-only MVP inspired by OpenClaw.

## Features

- WebSocket gateway at `/ws`
- First-frame `connect` handshake with token auth
- Minimal methods: `connect`, `health`, `send`, `agent`, `copilot`, `cron.*`
- In-memory sessions
- Generic LLM adapter with one unified entrypoint
- Supports `responses` and `chat_completions` protocols
- HTTP health endpoint at `/health`
- `copilot` method: call `gh copilot` CLI in non-interactive mode
- `cron.*` methods: 定时任务子系统（持久化 JSON、最近唤醒调度）

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Start server:

```bash
npm start
```

4. (Optional) Start Feishu bridge MVP:

```bash
npm run bridge:feishu
```

## Source Archive 安装与启动（无 Docker）

适用于通过 Git Tag + Source Archive 发布的源码产物。

### 1) 下载源码包

从 GitHub Release 下载以下任一文件并解压：

- `myclaw-v0.1.0-source.tar.gz`
- `myclaw-v0.1.0-source.zip`

### 2) 环境要求

- Node.js `>=22`
- npm `>=10`
- （如需 copilot）已安装并登录 `gh` CLI

### 3) 安装依赖

```bash
npm install
```

### 4) 配置环境变量

```bash
cp .env.example .env
```

按需编辑 `.env` 中以下关键项：

- 网关：`PORT`、`GATEWAY_TOKEN`
- LLM：`LLM_PROVIDER`、`LLM_PROTOCOL`、`LLM_ENDPOINT`、`LLM_MODEL`、`LLM_API_KEY`
- 飞书桥接：`FEISHU_*`
- Cron：`CRON_*`
- 同步：`SYNC_ENABLED`、`SYNC_SERVER_URL`

### 5) 启动服务

启动核心网关：

```bash
npm start
```

可选：启动飞书桥接：

```bash
npm run bridge:feishu
```

可选：启动同步服务：

```bash
npm run sync-server
```

### 6) 启动后检查

```bash
curl http://127.0.0.1:18789/health
curl http://127.0.0.1:18790/health
```

说明：若只启动网关，第二条命令会失败，这是预期行为。

## Environment Variables

- `PORT`: gateway port (default `18789`)
- `GATEWAY_TOKEN`: required token for websocket connect
- `LLM_PROVIDER`: provider label (example: `openai`, `doubao`)
- `LLM_PROTOCOL`: request protocol (`responses` or `chat_completions`)
- `LLM_ENDPOINT`: API endpoint URL
- `LLM_MODEL`: model name
- `LLM_API_KEY`: API key (optional; empty means fallback echo reply)
- `LLM_STREAM`: stream mode for `chat_completions` (`true`/`false`)
- `FEISHU_ENABLED`: enable Feishu bridge (`true`/`false`)
- `FEISHU_APP_ID`: Feishu app id (required when bridge enabled)
- `FEISHU_APP_SECRET`: Feishu app secret (required when bridge enabled)
- `FEISHU_DOMAIN`: `feishu` or `lark`
- `FEISHU_CONNECTION_MODE`: only `websocket` is supported in MVP
- `FEISHU_REQUIRE_MENTION_IN_GROUP`: in group chat, require bot mention to trigger
- `FEISHU_LOG_REPLY`: log outbound reply text in bridge logs (`true`/`false`, default `false`)
- `FEISHU_REPLY_MARKDOWN`: send Feishu replies as markdown-rendered interactive card (`true`/`false`, default `true`)
- `FEISHU_GATEWAY_URL`: myclaw gateway websocket url
- `FEISHU_GATEWAY_TOKEN`: gateway token used by feishu bridge
- `FEISHU_CLIENT_ID`: feishu bridge client id used in gateway connect
- `FEISHU_REQUEST_TIMEOUT_MS`: gateway request timeout for feishu bridge
- `FEISHU_IMAGE_TEMP_DIR`: local temp directory for downloaded Feishu images (default `data/feishu-images`)
- `FEISHU_IMAGE_MAX_BYTES`: max accepted image size in bytes (default `10485760`)
- `FEISHU_FILE_TEMP_DIR`: local temp directory for downloaded Feishu files (default `data/feishu-files`)
- `FEISHU_FILE_MAX_BYTES`: max accepted file size in bytes (default `20971520`)
- `FEISHU_FILE_MAX_TEXT_CHARS`: max chars kept when reading md/txt file content (default `20000`)
- `COPILOT_ENABLED`: enable gh copilot tool (`true`/`false`, default `true`)
- `COPILOT_TIMEOUT_MS`: timeout for gh copilot execution (default `120000`)
- `COPILOT_MODEL`: model to use (empty = copilot default)
- `COPILOT_ALLOW_ALL_TOOLS`: allow copilot to use all tools unattended (`true`/`false`, default `true`)
- `COPILOT_WORK_DIR`: working directory for copilot (empty = process cwd)
- `COPILOT_REUSE_SESSION`: reuse one shared copilot session in gateway `copilot` method (`true`/`false`, default `true`)
- `CRON_ENABLED`: enable cron subsystem (`true`/`false`, default `true`)
- `CRON_JOBS_FILE`: jobs persistence file path (default `data/cron-jobs.json`)
- `CRON_JOB_TIMEOUT_MS`: per-job execution timeout (default `600000` = 10 min)
- `CRON_MAX_CONCURRENT`: max concurrent job executions (default `1`)
- `SYNC_ENABLED`: enable cron sync client (`true`/`false`, default `false`)
- `SYNC_SERVER_URL`: sync REST server base URL (default `http://127.0.0.1:18790`)
- `SYNC_TIMEOUT_MS`: sync request timeout (default `5000`)
- `SYNC_NODE_ID`: node identity written to synced records (default `myclaw-local`)
- `SYNC_PORT`: sync server port (default `18790`)
- `SYNC_DB_FILE`: sync server persistence file (default `data/cron-sync-db.json`)

OpenAI Responses example:

```dotenv
LLM_PROVIDER=openai
LLM_PROTOCOL=responses
LLM_ENDPOINT=https://api.openai.com/v1/responses
LLM_MODEL=gpt-4.1-mini
LLM_API_KEY=your_openai_key
LLM_STREAM=false
```

Doubao ChatCompletions example:

```dotenv
LLM_PROVIDER=doubao
LLM_PROTOCOL=chat_completions
LLM_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3/chat/completions
LLM_MODEL=doubao-1-5-pro-32k-250115
LLM_API_KEY=your_doubao_key
LLM_STREAM=true
```

## WebSocket Protocol (MVP)

Connect request (first frame only):

```json
{
  "type": "req",
  "id": "1",
  "method": "connect",
  "params": {
    "auth": { "token": "dev-token" },
    "client": { "id": "demo-cli", "version": "0.1.0" }
  }
}
```

Send message into session:

```json
{
  "type": "req",
  "id": "2",
  "method": "send",
  "params": { "sessionId": "main", "text": "大语言模型中的 token 是什么？用一句话解释它" }
}
```

Ask agent for response:

```json
{
  "type": "req",
  "id": "3",
  "method": "agent",
  "params": { "sessionId": "main" }
}
```

## Feishu Bridge MVP

MVP scope:

- Single account only (`FEISHU_APP_ID` + `FEISHU_APP_SECRET`).
- Inbound event: `im.message.receive_v1` via Feishu WebSocket connection.
- Supports `message_type=text`, `message_type=image`, and `message_type=file`.
- For image messages in copilot mode, bridge downloads image to local temp file and passes file path to copilot prompt.
- For file messages in copilot mode, bridge downloads the file; for md/txt it reads text content and forwards it to copilot.
- Group policy: only trigger when bot is mentioned if `FEISHU_REQUIRE_MENTION_IN_GROUP=true`.
- Session mapping:
  - DM: `feishu:dm:<senderOpenId>`
  - Group: `feishu:group:<chatId>`
- Outbound: reply text to original message (`im.message.reply`).

Run:

```bash
npm run bridge:feishu
```

Notes:

- This bridge assumes gateway is already running (`npm start`).
- If `FEISHU_ENABLED=false`, the process will fail fast by design.

## Notes

- This is intentionally minimal and not production hardened.
- Sessions are kept in memory and reset on restart.

## Copilot Tool

The `copilot` gateway method calls `gh copilot` CLI in non-interactive mode (`-p`, `-s`, `--yolo`).

Prerequisites:

- `gh` CLI installed and authenticated (`gh auth login`)
- `gh copilot` extension available (auto-downloaded on first use)

Request:

```json
{
  "type": "req",
  "id": "4",
  "method": "copilot",
  "params": { "prompt": "帮我提交下当前项目的代码修改" }
}
```

Response payload:

```json
{ "output": "git tag --sort=-creatordate" }
```

## Feishu × Copilot 交互

Feishu bridge 通过 `config.copilot.enabled` 全局切换消息路由：

- `COPILOT_ENABLED=true`：所有飞书消息走 gateway `copilot` 方法（`gh copilot` CLI）
- `COPILOT_ENABLED=false`：所有飞书消息走 `send` + `agent` 方法（LLM）

交互流程：

1. 收到飞书文本消息
2. 对原消息贴飞书原生 `OnIt` 表情，提示用户"正在处理"
3. 根据 `COPILOT_ENABLED` 分发到 copilot 或 agent
4. 将结果以文本回复到原消息
5. 处理过程中的任何错误都会以 `[错误] ...` 文本回复到原消息

## 超时配置

两个模块各自有独立超时控制，需注意链路上的依赖关系：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `FEISHU_REQUEST_TIMEOUT_MS` | `15000` | Feishu bridge 等待 gateway 响应的超时 |
| `COPILOT_TIMEOUT_MS` | `120000` | gateway 内 `gh copilot` 子进程执行超时 |

重要：`FEISHU_REQUEST_TIMEOUT_MS` 必须 **大于** `COPILOT_TIMEOUT_MS`，否则 Feishu bridge 会在 copilot 尚未完成时提前超时。推荐配置：

```dotenv
COPILOT_TIMEOUT_MS=120000
FEISHU_REQUEST_TIMEOUT_MS=130000
```

超时链路：`飞书用户等待` → `FEISHU_REQUEST_TIMEOUT_MS` → `gateway` → `COPILOT_TIMEOUT_MS` → `gh copilot 子进程`

## 并发场景

### 飞书同时发送多条消息

每条消息触发独立的 async handler，在 `await` 处交替执行。

- **Copilot 模式**：各请求独立 spawn `gh copilot` 子进程，互不干扰，无共享状态。注意多个 `gh copilot` 并行会消耗 CPU 和 API 配额。
- **Agent 模式**：`send` → `agent` 两步非原子操作，同一 session 的多条消息可能交错写入 history。MVP 可接受，生产环境建议加 per-session 串行队列。

### 飞书 + 本地终端发送同一条消息

- Feishu bridge 按 `messageId` 去重，终端 WebSocket 无 messageId，两者不会互相去重
- Copilot 模式：两个独立请求，各自返回结果，无冲突
- Agent 模式：若 sessionId 相同，同一文本会被 push 两次进 history

### MVP 结论

- Copilot 模式下 **不需要加锁**
- Agent 模式下 MVP 不加锁，生产环境建议对 sessionId 加 async mutex

## Cron 定时任务子系统

最小可用的定时任务调度器，支持 6 个核心能力：创建、持久化、定时触发、手动触发、记录结果、重启恢复。

### Schedule 类型

| 类型 | value 含义 | 示例 |
|------|-----------|------|
| `at` | ISO 时间字符串或毫秒时间戳（一次性） | `"2026-04-01T08:00:00Z"` |
| `every` | 间隔毫秒数 | `60000`（每分钟） |
| `cron` | cron 表达式（由 croner 库解析） | `"0 9 * * 1-5"`（工作日 9 点） |

### Payload Action

| action | 说明 |
|--------|------|
| `log` | 打印 `params.message` 到控制台 |
| `copilot` | 以 `params.prompt` 调用 gh copilot |

### Gateway 方法

**cron.list** — 列出所有任务

```json
{ "type": "req", "id": "10", "method": "cron.list", "params": {} }
```

**cron.add** — 创建任务

```json
{
  "type": "req", "id": "11", "method": "cron.add",
  "params": {
    "name": "每分钟打日志",
    "schedule": { "type": "every", "value": 60000 },
    "payload": { "action": "log", "params": { "message": "heartbeat" } }
  }
}
```

**cron.update** — 更新任务（传 id + 要改的字段）

```json
{
  "type": "req", "id": "12", "method": "cron.update",
  "params": { "id": "<job-id>", "enabled": false }
}
```

**cron.remove** — 删除任务

```json
{ "type": "req", "id": "13", "method": "cron.remove", "params": { "id": "<job-id>" } }
```

**cron.run** — 手动强制执行一次

```json
{ "type": "req", "id": "14", "method": "cron.run", "params": { "id": "<job-id>" } }
```

### 持久化

- 任务存储在 `data/cron-jobs.json`（可通过 `CRON_JOBS_FILE` 配置）
- 每次增删改后立即落盘（写临时文件 + rename 保证原子性）
- `data/` 目录已加入 `.gitignore`

### MVP 防护

- 任务超时：默认 10 分钟（`CRON_JOB_TIMEOUT_MS`）
- 并发上限：默认 1（`CRON_MAX_CONCURRENT`）
- 防重复执行：`runningAtMs` 标记 + 持久化
- 启动恢复：自动清理上次残留 running 标记，重算 nextRunAtMs
- 一次性任务（`at`）：过期后自动禁用

## Cron Sync REST Server

新增一个最小可用 Node.js HTTP 服务，用于汇总本地 cron job 与每次执行输出。其他终端可通过 REST API 拉取这些数据。

启动：

```bash
npm run sync-server
```

健康检查：

```bash
curl http://127.0.0.1:18790/health
```

主要 API：

- `GET /api/jobs`：获取全部任务快照
- `GET /api/jobs/:id`：获取单个任务
- `GET /api/runs?jobId=<id>&limit=100`：获取执行记录

当 `SYNC_ENABLED=true` 时，myclaw gateway 会自动将以下数据同步到该服务：

- cron 任务增删改（upsert/delete）
- 每次任务执行完成事件（含 `status/error/output`）

说明：

- 同步失败不会影响本地 cron 执行，仅记录 warning 日志
- 服务端数据落盘为 JSON（写临时文件 + rename）
