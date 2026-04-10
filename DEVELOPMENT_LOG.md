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

---

## 2026-04-06

### 8) Feishu 图片消息“真图片处理版”接入 Copilot

关联提交：`497b504`

变更目标：
- 让飞书图片消息不再仅传 image_key 元数据，而是下载真实图片后交给 copilot 处理。

主要改动：
- Feishu bridge 新增图片处理链路：
  - 识别 `message_type=image`
  - 通过飞书 OpenAPI 获取 tenant_access_token（含缓存）
  - 按 `message_id + image_key` 下载图片到本地临时目录
  - 将本地图片路径、类型、大小写入 prompt 调用 gateway `copilot`
  - 在 `finally` 中清理临时文件
- 非 copilot 模式下，图片消息返回明确提示，不再错误走 agent 文本链路。
- 新增配置项：
  - `FEISHU_IMAGE_TEMP_DIR`
  - `FEISHU_IMAGE_MAX_BYTES`
- 文档更新：
  - `.env.example` 增加图片处理相关参数
  - `README.md` 补充图片支持说明
  - 新增 `RELEASE_NOTES_v0.1.0.md`

涉及文件：
- src/bridge/feishu.mjs
- src/config.mjs
- .env.example
- README.md
- RELEASE_NOTES_v0.1.0.md

验证记录：
- node --check src/bridge/feishu.mjs
- node --check src/config.mjs
- 结果：通过

---

### 9) 统一共享 Copilot Session + 飞书 Markdown 回发

关联提交：`5af26f5`

变更目标：
- 将 copilot 会话复用从“按 job 复用”统一为“进程内共享 session 复用”。
- 飞书回发支持 Markdown 渲染，避免 copilot 文案在飞书中退化为纯文本。

主要改动：
- Copilot 会话复用：
  - 新增 `COPILOT_REUSE_SESSION` 配置（默认开启）。
  - 会话复用逻辑下沉到工具层，统一使用共享 `sharedCopilotSessionId`。
  - gateway `copilot` 与 cron `copilot` 执行器都改为走同一共享 session 入口。
  - 新增调用日志，打印 `gh copilot` 实际参数、耗时、退出状态。
- 飞书 Markdown 回发：
  - 新增 `FEISHU_REPLY_MARKDOWN` 配置（默认开启）。
  - 回发时自动识别 Copilot 输出；纯文本走 `text`，Markdown 内容走 `interactive` + `markdown` 卡片渲染。

涉及文件：
- src/tool/copilot.mjs
- src/gateway/server.mjs
- src/index.mjs
- src/config.mjs
- src/bridge/feishu.mjs
- .env.example
- README.md

验证记录：
- node --check src/tool/copilot.mjs
- node --check src/gateway/server.mjs
- node --check src/index.mjs
- node --check src/bridge/feishu.mjs
- node --check src/config.mjs
- 结果：通过

---

### 10) Feishu 文件消息处理（md/txt）接入 Copilot

关联提交：`5d23282`

变更目标：
- 支持飞书 `message_type=file`，可下载文件并将 markdown/text 内容传给 copilot 处理。

主要改动：
- Feishu bridge 新增文件消息链路：
  - 识别 `message_type=file` 并解析 `file_key`、`file_name`
  - 通过飞书资源接口下载文件到本地临时目录
  - 对 `md/markdown/txt/text/*` 文件读取文本并按阈值截断后传给 copilot
  - 非文本文件则传递文件路径与元信息，提示模型给出可执行建议
  - 在 `finally` 中统一清理下载的临时文件
- 配置新增：
  - `FEISHU_FILE_TEMP_DIR`
  - `FEISHU_FILE_MAX_BYTES`
  - `FEISHU_FILE_MAX_TEXT_CHARS`
- 文档同步：
  - `.env.example` 增加文件处理相关参数
  - `README.md` 补充 `file` 消息支持与配置说明

涉及文件：
- src/bridge/feishu.mjs
- src/config.mjs
- .env.example
- README.md

验证记录：
- node --check src/bridge/feishu.mjs
- node --check src/config.mjs
- 结果：通过

---

## 2026-04-07

### 11) Feishu 回发格式自动识别（纯文本 / Markdown）

关联提交：`ed52f3a`

变更目标：
- 避免所有开启 `FEISHU_REPLY_MARKDOWN` 的回复都强制走卡片渲染，让普通文本继续使用 Feishu `text` 消息类型。

主要改动：
- 新增 `src/bridge/reply-format.mjs`：
  - 提取飞书回复 payload 构造逻辑。
  - 基于标题、列表、代码块、链接、行内代码等特征识别 Markdown 内容。
- `src/bridge/feishu.mjs` 改为复用 `buildFeishuReplyPayload`：
  - 普通文本 -> `text`
  - Markdown 内容 -> `interactive` + `markdown`
- 文档同步更新：
  - `README.md`
  - `RELEASE_NOTES_v0.2.0.md`

涉及文件：
- src/bridge/reply-format.mjs
- src/bridge/feishu.mjs
- README.md
- RELEASE_NOTES_v0.2.0.md

验证记录：
- node --check src/bridge/feishu.mjs
- node --check src/bridge/reply-format.mjs
- 结果：通过

---

## 2026-04-10

### 12) Copilot 执行链路切换到 GitHub Copilot SDK

关联提交：`e307450`

变更目标：
- 用 `@github/copilot-sdk` 替换原 `gh copilot` 子进程调用，统一走 SDK 会话接口。
- 保持 gateway / feishu / cron 上层调用接口不变，降低迁移风险。

主要改动：
- `src/tool/copilot.mjs` 从 `execFile("gh", ...)` 改为 `CopilotClient + session.sendAndWait(...)`。
- 保留并兼容原有导出方法：
  - `runCopilot`
  - `runCopilotWithSession`
  - `runCopilotWithSharedSession`
- 共享会话模式下继续保留串行锁，避免并发复用会话时上下文竞争。
- 新增 `stopCopilotClient`，用于进程退出时优雅释放 SDK 连接与会话。
- `src/index.mjs` 在 shutdown 流程中调用 `stopCopilotClient`。
- 新增依赖：`@github/copilot-sdk`。

涉及文件：
- src/tool/copilot.mjs
- src/index.mjs
- package.json
- package-lock.json
- README.md

验证记录：
- node --check src/tool/copilot.mjs
- node --check src/index.mjs
- node --check src/gateway/server.mjs
- node --check src/bridge/feishu.mjs
- node --input-type=module -e "import { CopilotClient } from '@github/copilot-sdk'; ..."
- 结果：通过

---

### 13) 清理 Feishu /skill 与本地技能注入逻辑

关联提交：`d9ef395`

变更目标：
- 删除飞书桥接层本地 `/skill` 文件管理与 prompt 注入逻辑，简化命令面。

主要改动：
- 删除 `/skill` 命令分支。
- 删除 `skillDir` 相关配置项。
- 清理帮助文案与相关调用参数。

涉及文件：
- src/bridge/feishu.mjs
- src/config.mjs

---

### 14) 共享会话增加串行锁

关联提交：`2cecd9e`

变更目标：
- `reuseSession=true` 时同一时刻仅允许一个 copilot 任务执行，减少并发冲突导致的失败。

主要改动：
- 在 `src/tool/copilot.mjs` 增加队列锁封装，复用会话调用串行化。

---

### 15) Copilot 输出缓冲上限调整

关联提交：`2051ba3`

变更目标：
- 降低大输出场景下缓冲溢出概率。

主要改动：
- `maxBuffer` 从 8MB 调整为 64MB。

