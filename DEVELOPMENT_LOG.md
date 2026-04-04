# Development Log

## 2026-04-04

### 1) Feishu 命令路由增强

关联提交：`31fb1eb`

变更目标：在飞书中直接下发可执行命令，而不是全部走普通对话。

主要改动：
- 在 Feishu bridge 中新增命令解析与路由。
- 支持命令：
  - /help
  - /copilot <prompt>
  - /agent <text>
  - /cron list
  - /cron add <json>
  - /cron update <jobId> <jsonPatch>
  - /cron remove <jobId>
  - /cron run <jobId>
- 未命中命令时，保留原默认路由：
  - COPILOT_ENABLED=true -> 走 copilot
  - COPILOT_ENABLED=false -> 走 send + agent

涉及文件：
- src/bridge/feishu.mjs

---

### 2) Cron 执行完成后回飞书通知

关联提交：`31fb1eb`、`718ed3b`

变更目标：从飞书创建的 cron 任务执行完成后，自动回发成功/失败结果。

主要改动：
- Feishu 侧在 /cron add 时自动注入 notify 目标：
  - notify.type = "feishu"
  - notify.chatId
  - notify.senderOpenId
- 调度器新增任务完成回调机制：onJobFinished。
- 网关启动时创建 Feishu client，监听任务完成事件并回发：
  - 成功：任务名、id、触发类型、action、输出摘要
  - 失败：任务名、id、触发类型、action、错误信息

涉及文件：
- src/bridge/feishu.mjs
- src/cron/scheduler.mjs
- src/index.mjs

问题修复：
- 修复 cron.add / cron.update 中 notify 字段未持久化的问题。
- 修复后 data/cron-jobs.json 可看到 notify 数据。

---

### 3) Cron Job 绑定 Copilot Session（会话复用）

关联提交：`e2c6d84`

变更目标：同一个 cron job 持续复用一个 copilot session，避免每次新会话。

主要改动：
- copilot 工具层新增会话能力：
  - 支持传入 resumeSessionId（内部使用 --resume）
  - 新增 runCopilotWithSession，解析 JSON 输出提取可复用 sessionId
- cron copilot 执行器逻辑改为：
  - 读取 job.state.copilotSessionId 作为 resumeSessionId
  - 执行后回写新的 sessionId
- scheduler state 增加字段：copilotSessionId

涉及文件：
- src/tool/copilot.mjs
- src/index.mjs
- src/cron/scheduler.mjs

---

### 4) 验证记录

关联提交：`31fb1eb`、`718ed3b`、`e2c6d84`

已执行语法检查：
- node --check src/bridge/feishu.mjs
- node --check src/tool/copilot.mjs
- node --check src/index.mjs
- node --check src/cron/scheduler.mjs

结果：全部通过。

---

### 5) 当前行为说明（最新）

关联提交：`31fb1eb`、`718ed3b`、`e2c6d84`

- 通过飞书 /cron add 创建的任务：
  - 会自动带 notify 元数据
  - 执行完成后自动回飞书通知
- 同一 cron job 的 copilot 任务：
  - 首次执行创建会话
  - 后续执行复用同一会话（通过 job.state.copilotSessionId）
- 旧任务（历史上未带 notify）：
  - 仍会执行
  - 不会自动回飞书，需重建或补充 notify

---

### 6) cron.run 返回 output 给调用方

关联提交：`78fbcf0`

变更目标：手动执行 `cron.run` 后，调用方可直接拿到本次任务输出（尤其是 copilot 输出）。

主要改动：
- `runJob` 在完成后返回执行结果对象：
  - `output`
  - `lastStatus`
  - `lastError`
  - `lastRunAtMs`
- `run(id)` 改为接收 `runJob` 返回值并透传给 RPC 调用方。

涉及文件：
- src/cron/scheduler.mjs

验证记录：
- node --check src/cron/scheduler.mjs
- 结果：通过

---

### 7) 新增 Cron Sync REST 服务与数据同步

关联提交：`ab579fe`

变更目标：
- 提供一个最小可用 HTTP REST 服务，支持跨终端查询 cron job 与执行输出。
- 将本地 cron 数据（任务增删改 + 每次执行结果）同步到该服务。

主要改动：
- 新增同步服务：`src/sync/http-server.mjs`
  - `GET /health`
  - `GET /api/jobs`
  - `GET /api/jobs/:id`
  - `PUT /api/jobs/:id`
  - `DELETE /api/jobs/:id`
  - `GET /api/runs?jobId=<id>&limit=100`
  - `POST /api/runs`
- 新增同步客户端：`src/sync/client.mjs`
  - `upsertJob/removeJob/appendRun/health`
- 在 scheduler 中新增任务变更监听：`onJobChanged`
  - add/update -> upsert
  - remove -> delete
- 在 `index.mjs` 中接入同步逻辑：
  - 启动时全量同步一次 jobs
  - job 变化时同步 job 快照
  - job 执行完成时同步 run 记录（包含 output）
- 新增配置：
  - `SYNC_ENABLED`
  - `SYNC_SERVER_URL`
  - `SYNC_TIMEOUT_MS`
  - `SYNC_NODE_ID`
  - `SYNC_PORT`
  - `SYNC_DB_FILE`
- 新增脚本：`npm run sync-server`

涉及文件：
- src/sync/http-server.mjs
- src/sync/client.mjs
- src/cron/scheduler.mjs
- src/index.mjs
- src/config.mjs
- package.json
- .env.example
- README.md

验证记录：
- node --check src/sync/http-server.mjs
- node --check src/sync/client.mjs
- node --check src/index.mjs
- node --check src/cron/scheduler.mjs
- node --check src/config.mjs
- curl -s http://127.0.0.1:18790/health
- 结果：通过
