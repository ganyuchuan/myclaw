# Development Log

## 2026-05-28

### 24) cloud 鉴权字段统一 + setup 稳定性修复 + API 文档拆分

变更目标：
- 统一 cloud 用户字段命名为 `username`，避免前后端混用 `userName` 导致的解析歧义。
- 修复 setup 在重复执行时的稳定性问题（端口占用、WS 首帧顺序约束）。
- 将 cloud auth 接口说明拆分为 docs 独立文档，降低 README 维护负担。

主要改动：
- cloud 鉴权字段统一
  - `src/cloud/intercept-server.ts`
    - `/auth/token` 请求字段从 `userName` 调整为 `username`。
    - `/auth/token`、`/auth/pairing-token` 返回字段统一为 `username`。
    - `requireInterceptAuth` 中 principal 字段由 `userName` 统一为 `username`。
  - `src/cloud/intercept-store.ts`
    - `createUserTokenRecord` 入参改为 `username`。
    - users 相关读取返回字段统一为 `username`。
  - `src/cloud/pairing-code-registry.ts`
    - issue/resolve 类型与数据字段统一为 `username`。
  - `src/cloud/intercept-approval.html`
    - token 签发请求体改为 `{ username }`。
    - users 表渲染字段改为 `username`。
- setup 稳定性修复
  - `src/setup.ts`
    - ESM 路径兼容：使用 `fileURLToPath(import.meta.url)` 计算 `__dirname`。
    - 启动前端口治理：新增占用 `18789` 监听进程探测与停止逻辑，避免旧网关残留导致冲突。
    - 调试可见性：后台启动网关 `stdio` 改为 `inherit`，便于直接观察子进程报错。
    - WS 协议顺序修复：`connect` 与 `intercept.ping` 改为同一连接内按序发送，修复 `first method must be connect`。
    - 输出字段同步改为 `username`。
- 文档拆分
  - 新增 `docs/CLOUD_AUTH_API.md`，集中维护 `/auth/token`、`/auth/pairing-token` 接入说明。
  - `README.md` 对应章节改为指向 docs 的入口链接。

验证记录：
- `npm run build`：通过
- `node dist/setup.js`：通过

## 2026-05-25

### 23) 配对码引导安装流程最小落地（cloud onboarding + setup 向导）

变更目标：
- 打通“移动/穿戴端发码 -> 电脑端打开引导页 -> 本地安装配置 -> 网关回传验收事件”的最小闭环。
- 在不破坏现有审批链路的前提下，新增 onboarding 能力并保持最小改造成本。

主要改动：
- Cloud onboarding 页面与文档
  - 新增 `src/cloud/index.html`，作为 cloud 根路径引导页。
  - 新增 `src/cloud/SKILL.md`，由页面通过 `loadSkill` 从 `/SKILL.md` 加载展示。
  - `src/cloud/intercept-server.ts` 新增静态路由：
    - `GET /` 和 `GET /index.html` 返回 onboarding 页面
    - `GET /SKILL.md` 返回技能文档
- 配对码与 onboarding URL
  - `/auth/token` 返回体新增 `onboardingUrl`，与 `pairingCode` 同时下发。
  - `src/cloud/intercept-approval.html` 在发码后解析并展示 `onboardingUrl`。
- CLI 与安装向导
  - `src/cli.ts` 新增 `alimbo setup` 命令入口。
  - 新增 `src/setup.ts`：
    - 输入配对码并请求 `/auth/pairing-token`
    - 将 token 绑定到 `GATEWAY_TOKEN`、`FEISHU_GATEWAY_TOKEN`、`FEISHU_INTERCEPT_AUTH_TOKEN`、`COPILOT_INTERCEPT_AUTH_TOKEN`
    - 以 `.env.example` 生成/更新 `.env`
    - 后台启动 gateway 并做健康检查
    - 通过网关发送 `intercept.ping` 做 cloud 事件链路验收
- 网关验收方法
  - `src/gateway/gateway-server.ts` 新增 `intercept.ping` 方法并加入 methods 列表。
  - `intercept.ping` 会调用 cloud `/api/copilot/intercepts/event`，用于安装完成后的最小验收。
- 打包与文档同步
  - `package.json`：`postbuild` 增加复制 `src/cloud/index.html`、`src/cloud/SKILL.md`。
  - `README.md`：补充 onboarding 与 `alimbo setup` 流程说明。
  - 根目录历史 `SKILL.md` 删除，改为 cloud 模块内聚管理。

验证记录：
- `npm run build`：通过

## 2026-05-24

### 22) npm 全局安装发布最小流程落地（alimbo CLI）

变更目标：
- 让项目满足 `npm i -g alimbo` 的最小发布前提。
- 提供全局命令入口，统一转发到现有网关/飞书桥接/云端进程。

主要改动：
- `package.json`
  - `private: true` 调整为 `private: false`，允许发布。
  - 新增 `bin.alimbo = dist/cli.js`，声明全局命令。
  - 新增 `files` 白名单（`dist`、`README.md`），收敛发布内容。
  - 新增 `prepack` 脚本，打包前自动构建。
- `src/cli.ts`
  - 新增 Node CLI 入口（含 shebang）。
  - 支持 `alimbo start`、`alimbo bridge:feishu`、`alimbo cloud`。
  - 支持 `alimbo --help`、`alimbo --version`。

验证记录：
- `npm run build`：通过
- `npm pack`：通过
- `npm publish --dry-run`：通过
- `npm publish --access public`：通过

## 2026-05-19

## 2026-05-23

### 21) sync 子系统重命名为 cloud + agent runtime 目录迁移

变更目标：
- 将原 `sync` 目录与命名语义统一替换为 `cloud`，降低与 cron 同步历史概念混淆。
- 将 agent 运行时相关实现聚合到独立目录，明确与通用工具模块的边界。

主要改动：
- 目录与入口重命名
  - `src/sync/*` -> `src/cloud/*`
  - `src/sync/intercept-server.ts` -> `src/cloud/intercept-server.ts`
  - `src/sync/intercept-store.ts` -> `src/cloud/intercept-store.ts`
  - `src/sync/intercept-approval.html` -> `src/cloud/intercept-approval.html`
- 包脚本与构建产物路径
  - `package.json` 中 `sync-server` 脚本改为 `cloud-server`
  - `postbuild` 拷贝路径由 `dist/sync` 改为 `dist/cloud`
- 云端配置命名统一
  - `.env.example` 中 `SYNC_*` 变量改为 `CLOUD_*`
  - `intercept-server` 与 `intercept-store` 读取环境变量切换到 `CLOUD_*`
  - 默认 DB 从 `data/sync.db` 调整为 `data/cloud.db`
- agent runtime 目录迁移
  - `src/tool/agent.ts` -> `src/agent-runtime/agent.ts`
  - `src/tool/copilot.ts` -> `src/agent-runtime/copilot.ts`
  - `src/tool/claude.ts` -> `src/agent-runtime/claude.ts`
  - `src/tool/token-estimate.ts` -> `src/agent-runtime/token-estimate.ts`
  - 同步修复 `src/index.ts`、`src/gateway/gateway-server.ts`、`src/tool/cron.ts`、`src/tool/sql.ts` 等引用

文档同步：
- `README.md` 中 `sync-server`、`SYNC_*`、`alimbo-sync-server` 统一更新为 cloud 对应命名。

验证记录：
- `npm run typecheck`：通过
- `npm run build`：通过

### 20) http-server 数据逻辑抽离到单例 store

变更目标：
- 将 `http-server` 中全部数据层职责（SQLite 初始化/迁移/事务/CRUD）从路由逻辑中剥离。
- 通过单例 store 集中管理数据访问，降低文件复杂度并提升可维护性。

主要改动：
- `src/sync/intercept-store.ts`
  - 新增 `interceptStore` 单例，统一封装数据访问。
  - 承载数据库打开、建表、索引初始化与兼容迁移逻辑。
  - 提供 users、intercept_state、intercept_requests、intercept_tool_calls 的读写与计数接口。
  - 提供统一事务入口 `withTransaction`。
- `src/sync/http-server.ts`
  - 删除内嵌的数据库与数据处理函数（包含 `openDatabase`、迁移、SQL CRUD、事务封装等）。
  - 所有数据读写改为调用 `interceptStore` 单例方法。
  - 启动日志中的 db 文件路径改为由 store 提供。

验证记录：
- `npm run typecheck`：通过

### 17) 移除 LLM 会话链路 + 清理 /agent 与文档配置残留

变更目标：
- 不再使用历史 `LLM_*` 会话链路，统一走 `agent.ts` 路由（Copilot/Claude provider）。
- 删除飞书 `/agent` 指令及相关回退逻辑，避免出现双通道行为不一致。
- 清理 `.env.example` 与 README 中过时的 LLM / `send` / `agent` 协议描述。

主要改动：
- `src/gateway/server.ts`
  - 删除 `generateAssistantReply` 依赖。
  - 删除 WebSocket `send` / `agent` 方法分支。
  - `METHODS` 中移除 `send`、`agent`，保留统一 `copilot` 入口。
- `src/model/client.ts`
  - 删除历史 LLM 客户端模块（chat_completions/responses 适配与回退逻辑）。
- `src/bridge/feishu.ts`
  - 删除 `/agent` 命令帮助与路由分支。
  - 删除与 `/agent` 相关的无用参数传递（`sessionId` 命令链路）。
  - 非 copilot 模式下保留明确提示，不再走旧会话回退。
- `.env.example`
  - 删除全部 `LLM_*` 配置项。
- `README.md`
  - 删除 LLM 相关环境变量说明与示例。
  - 删除 WebSocket 协议中旧 `send` / `agent` 请求示例。

补充改动：
- `src/tool/claude.ts`
  - 接入与 Copilot 同口径 token 估算（工具调用、失败路径、carry-over、overhead 维度）。

验证记录：
- `npm run build`：通过

### 18) 删除 sync authType 透传，统一改为服务端签发 token

变更目标：
- 彻底移除 `authType` 在 sync 鉴权链路中的透传与存储逻辑。
- 审批页改为通过 `/auth/token` 动态签发 token，不再手工维护 auth type。
- 收敛遗留的 `SYNC_INTERCEPT_AUTH_TOKEN` 配置，避免继续依赖旧静态 token。

主要改动：
- `src/sync/http-server.ts`
  - 删除 `Principal` / `AuthTokenBody` 中的 `authType` 字段。
  - `/auth/token` 仅接收 `username`，由服务端生成 128-bit auth token。
  - `requireInterceptAuth` 仅返回 `userId` / `authToken` / `username`。
  - `users` 表继续保留 `auth_type` 列定义，但不再在运行逻辑中使用。
- `src/sync/intercept-approval.html`
  - 删除 auth type 输入框。
  - 改为先签发 token，再自动带入后续审批请求。
- `.env.example`
  - 删除 `SYNC_INTERCEPT_AUTH_TOKEN` 示例项，避免继续作为主路径配置。

验证记录：
- `npm run build`：通过

## 2026-05-21

### 19) 审批页拆分 Token 管理模块 + users 表展示 + Bearer-only 鉴权头

变更目标：
- 将 auth token 签发能力从审批区中独立出来，形成单独的 token 管理模块。
- 在页面中直接展示 `users` 表，便于运维与调试。
- 清理遗留 header 兼容，拦截鉴权仅保留标准 Bearer 路径。

主要改动：
- `src/sync/http-server.ts`
  - 新增 `listUsersFromDb`，按更新时间倒序读取 users 数据。
  - 新增 `GET /auth/users` 接口（支持 `limit`）。
  - `requireInterceptAuth` 删除 `x-intercept-token` 兜底读取，仅使用 Authorization Bearer。
- `src/sync/intercept-approval.html`
  - 新增 `Auth Token Manager` 面板：`username` + `Issue Token` + `Refresh Users`。
  - 新增 users 表展示（`userId/username/authToken/updatedAt`）。
  - `Intercept Waiting Approval` 面板移除 `username`，改为支持手动输入 `auth token`。

验证记录：
- `npm run build`：通过

### 16) Token 估算模块化 + 缺口补齐（含工具调用 token）

变更目标：
- 将 token 估算从 copilot 工具实现中抽离为可复用模块，便于后续在 claude 路径复用。
- 补齐剩余估算缺口，重点覆盖工具调用参数/结果 token、失败路径、重试上下文与会话上下文累计。

主要改动：
- `src/tool/token-estimate.ts`
  - 新增独立估算模块，统一承载文本与结构化内容估算。
  - 新增 `estimateContentTokens`：支持从对象/数组递归提取可读文本并估算 token。
  - 新增 `estimateToolCallTokens`：分别估算工具调用的 args/result token，并输出预览摘要。
  - 保留 `estimateConversationTokenBreakdown` 作为会话级 prompt/output 基线估算。
- `src/tool/copilot.ts`
  - 接入新模块，移除本地重复估算实现。
  - 新增会话级 token 跟踪：
    - 每轮工具调用次数与 args/result token 累计。
    - 会话上下文 carry-over token 累计。
    - 请求固定开销与每次工具调用额外开销估算。
  - 扩展 token 上报字段：
    - `toolCallCount`、`toolArgsTokens`、`toolResultTokens`、`toolTokens`
    - `contextCarryoverTokens`、`requestOverheadTokens`、`turnTokens`
    - `totalEstimatedTokens`（总估算）
  - 失败路径/重试路径补齐 token 上报，包含 `attempt`、`retryPlanned`、`failureReason`。
  - `streaming` 回退补齐：即使未注册 `onDelta`，也会累计 delta 作为输出回退来源。
  - 会话断开/stop 时清理 token 跟踪状态，避免跨会话污染。

验证记录：
- `npm run build`：通过

## 2026-05-16

### 15) sync server 存储从 JSON 切换到 SQLite

变更目标：
- 将 sync server 的 intercept 存储从整文件 JSON 读改写切换为 SQLite，降低并发写覆盖风险。
- 保持现有 Copilot 对接 HTTP 协议不变，调用方无需改造。

主要改动：
- `src/sync/http-server.ts`
  - 引入 `node:sqlite`（`DatabaseSync`）并初始化 SQLite 数据库。
  - 新增三张表：`intercept_state`、`intercept_requests`、`intercept_tool_calls`。
  - 将 `/api/copilot/intercepts/*` 的读写改为表级 SQL 操作。
  - 所有写操作改为事务提交（`BEGIN IMMEDIATE` / `COMMIT`，异常回滚）。
  - 保留原有请求/响应结构与路径，不改变接口契约。
  - 增加 legacy JSON 迁移逻辑：旧 JSON 文件可自动备份并导入 SQLite。
- `.env.example`
  - `SYNC_DB_FILE` 默认值调整为 `data/sync.db`（SQLite 文件）。

验证记录：
- `npm run typecheck`：通过

### 14) 移除 jobs/runs 同步接口与 sync client

变更目标：
- 删除已不再需要的 `/api/jobs`、`/api/runs` REST 接口及其本地同步链路。
- 清理 `createSyncClient`、`config.sync` 与对应环境变量，收敛 sync server 职责到 intercept 审批与事件聚合。

主要改动：
- `src/sync/http-server.ts`
  - 删除 `jobs`、`runs` 数据结构与相关请求体类型。
  - 删除 `/api/jobs`、`/api/jobs/:id`、`/api/runs` 路由与读写逻辑。
  - `/health` 返回中移除 `jobs`、`runs` 统计，仅保留 intercept 相关状态。
- `src/sync/client.ts`
  - 删除整个同步客户端文件。
- `src/index.ts`
  - 删除 `createSyncClient` 接入。
  - 删除 cron job 变更同步、run 记录上报与启动时全量同步逻辑。
- `src/config.ts`
  - 删除 `config.sync` 配置段。
- `.env.example`
  - 删除 `SYNC_ENABLED`、`SYNC_SERVER_URL`、`SYNC_TIMEOUT_MS`、`SYNC_NODE_ID`。

验证记录：
- `npm run typecheck`：通过

### 13) Intercept hint 组装取消字符截断

变更目标：
- 在 `generateInterceptHintWithTemplate` 组装 hint 时，不再按固定字符长度截断。
- 保留更完整的 `view/bash/apply_patch` hint 内容，便于审批端查看原始意图。

主要改动：
- `src/tool/copilot.ts`
  - 调整 `truncateForViewPath`：改为仅做字符串归一化（`String(...).trim()`），不再执行 `前9...后9` 截断。
  - 调整 `truncateForHintValue`：改为仅做字符串归一化（`String(...).trim()`），不再执行 `前18...` 截断。
  - `generateInterceptHintWithTemplate` 下游 `view/bash/apply_patch` hint 输出改为完整内容（仅去首尾空白）。

验证记录：
- `npm run build`：通过

### 12) Intercept hint 生成日志增强 + 飞书审核完成卡片 hint 修复

变更目标：
- 为 intercept hint 生成链路补充可排查日志，便于定位规则命中与输出结果。
- 修复飞书审批卡片在“审核已完成”状态下 hint 丢失的问题，保证与“审核请求”阶段一致可见。

主要改动：
- `src/tool/copilot.ts`
  - 为 hint 生成逻辑增加分支日志：记录 tool、strategy、参数摘要与最终 hint。
  - 为参数 JSON 解析失败增加告警日志，便于排查异常输入。
  - 日志默认输出摘要而非完整敏感参数。
- `src/bridge/feishu.ts`
  - 扩展审批决策与卡片跟踪结构，保存并回写 `hint/msg`。
  - 修复“审核已完成”卡片此前固定显示 `hint: -` 的问题。
  - 卡片更新时优先使用决策结果中的 `hint/msg`，缺失时回退使用本地跟踪值。

验证记录：
- `npm run build`：通过

## 2026-05-11

### 11) Feishu 图片/文件监听模式

变更目标：
- 飞书收到图片或文件时，不再立即组装 prompt 发给 Copilot。
- 先进入会话级监听缓存，在窗口期内持续收集后续图片/文件。
- 一旦收到文本消息，将缓存的所有附件整理到该文本前方，再统一提交给 Copilot。

主要改动：
- `src/bridge/feishu.ts`
  - 新增会话级附件缓存与 5 分钟监听窗口。
  - 图片/文件消息先下载到本地临时目录并入队，不立即触发 Copilot。
  - 下一条文本消息到来时，把缓存附件按顺序整理为上下文，再拼接原文本一起发送。
  - 上下文消费完成后清理临时文件，避免磁盘残留。

验证记录：
- `node` 级文件检查：通过
- `npm run typecheck`：未完全通过，项目里已有 `src/tool/claude.ts` 缺少 `@anthropic-ai/claude-agent-sdk` 依赖的问题

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

  ---

  ## 2026-05-02

  ### 10) Copilot 会话状态同步与 Token 估算展示

  关联提交：`16230be`

  变更目标：
  - 将 Copilot 会话生命周期状态同步到 sync server。
  - 在每次 Copilot 响应完成后估算 token 消耗，并通过 event 上报。
  - 在审批页和状态接口中展示最近一次 token 估算明细。

  主要改动：
  - `src/tool/copilot.mjs`
    - 新增 `onSessionStart` / `onSessionEnd` 钩子，上报 session start/end 生命周期事件。
    - 新增会话消息归一化与 entries 收集逻辑，用于同步最近会话内容。
    - 新增 token 估算逻辑：按 prompt/output 文本近似估算 token。
    - 在普通会话和共享会话路径中，均在拿到最终响应后通过 `POST /api/copilot/intercepts/event` 上报 token 估算结果。

  ---

  ## 2026-05-06

  ### 11) 多 Provider Agent 架构接入 Claude Agent SDK

  变更目标：
  - 在保持原有 Copilot 兼容的前提下，支持通过 `AGENT_PROVIDER` 在 Copilot 与 Claude 间切换。

  主要改动：
  - 新增 Provider 路由层：`src/tool/agent.ts`
    - 提供统一入口：`runAgentWithSharedSession` / `runAgentWithSession`。
  - 新增 Claude 适配层：`src/tool/claude.ts`
    - 基于 `@anthropic-ai/claude-agent-sdk` 的 `query` 接口。
    - 支持共享会话复用、流式 delta 回调、完成回调、超时处理。
    - 增加与 Copilot 对齐的 hook 映射：`PreToolUse` / `PostToolUse` / `SessionStart` / `SessionEnd`。
  - 网关/工具调用统一改走 agent 路由：
    - `src/gateway/server.ts`
    - `src/index.ts`
    - `src/tool/sql.ts`
  - 配置扩展：`src/config.ts`
    - 新增 `AGENT_PROVIDER`、`CLAUDE_API_KEY`、`CLAUDE_MODEL`、`CLAUDE_MAX_TURNS` 等映射。
  - 依赖切换：
    - `package.json` / `package-lock.json`
    - 从 `@anthropic-ai/claude-code` 迁移为 `@anthropic-ai/claude-agent-sdk`。

  涉及文件：
  - src/tool/agent.ts
  - src/tool/claude.ts
  - src/gateway/server.ts
  - src/index.ts
  - src/tool/sql.ts
  - src/config.ts
  - package.json
  - package-lock.json

  ### 12) Feishu 消息反应 emoji 按 agent/provider 区分（最小改动版）

  变更目标：
  - 不增加新配置项，直接硬编码按当前 provider 选择 `emoji_type`。
  - 对命令消息（`/xxx`）不贴表情。

  主要改动：
  - `src/bridge/feishu.ts`
    - 新增 `resolveReactionEmojiType`，基于 `copilotCfg.agentProvider` 返回不同 emoji。
    - 命令消息返回空字符串；调用 `messageReaction.create` 前增加空值判断，避免无效请求。

  涉及文件：
  - src/bridge/feishu.ts

  验证记录：
  - `npm run typecheck`
  - 结果：通过
  - `src/sync/http-server.mjs`
    - 拦截状态模型精简为 `total/running/waiting/completed` 主状态，由客户端 event 驱动更新。
    - 支持通过 event 写入 `entries`、状态字段与 `last_token_estimate`。
    - `GET /api/copilot/intercepts/state` 现返回最近一次 token 估算明细。
  - `src/sync/intercept-approval.html`
    - summary 区域新增 `tokens` 和 `tokens_today` 展示。
    - 新增 `Latest Token Estimate` 区块，展示最近一次估算的 session、prompt/output/total token 和预览文本。

  涉及文件：
  - src/tool/copilot.mjs
  - src/sync/http-server.mjs
  - src/sync/intercept-approval.html

  验证记录：
  - node --check src/tool/copilot.mjs
  - node --check src/sync/http-server.mjs
  - 结果：通过
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

---

## 2026-04-24

### 10) Copilot 工具拦截 + 人工审批队列（wait/poll）

变更目标：
- 在 Copilot SDK `onPreToolUse` 中增加可配置工具拦截、上报、服务端决策与 wait/poll。
- 支持服务端维护拦截状态（prompt/msg/entries）并提供人工审批接口。

主要改动：
- Copilot 客户端侧：
  - 新增 `interceptTools` 匹配后上报 `/api/copilot/intercepts/pretool`。
  - 服务端返回 `wait` 时进入 `/api/copilot/intercepts/decision` 轮询。
  - 增加拦截链路关键日志（pretool send/decision、poll start/tick/resolved/timeout）。
- Sync server 侧：
  - 新增拦截 API：
    - `GET /api/copilot/intercepts/state`
    - `GET /api/copilot/intercepts/queue`
    - `POST /api/copilot/intercepts/pretool`
    - `GET /api/copilot/intercepts/decision`
    - `POST /api/copilot/intercepts/decision`
    - `POST /api/copilot/intercepts/event`
  - 新增拦截状态聚合（total/running/waiting/prompt/msg/entries/tokens）。
  - 新增队列过期逻辑与人工决策日志。

涉及文件：
- src/tool/copilot.mjs
- src/sync/http-server.mjs
- src/config.mjs
- .env.example
- README.md

验证记录：
- node --check src/tool/copilot.mjs
- node --check src/sync/http-server.mjs
- node --check src/config.mjs
- 拦截链路 smoke test：pretool -> wait -> manual allow -> decision 查询通过

---

### 11) 轻量审批页面（Waiting 列表 + Allow/Deny）

变更目标：
- 提供一个最小可用审批页，直接操作现有拦截接口。

主要改动：
- 新增页面路由：`GET /intercepts/approve`
- 页面能力：
  - 展示 waiting 队列
  - 手工触发 allow/deny
  - 自动刷新（3s）
  - 可输入 auth token 与 operator

涉及文件：
- src/sync/http-server.mjs

验证记录：
- 页面可访问，能拉取 waiting 列表并执行人工审批。

---

### 12) Sync Server 启动策略快照与 dotenv 初始化

变更目标：
- 启动时打印“当前生效策略快照”，用于快速定位环境变量是否生效。
- 让 sync server 进程直接读取 `.env`。

主要改动：
- 启动日志新增：`[sync-server][intercept] policy snapshot ...`
  - 输出解析后的 effective 策略
  - 输出 envRaw（原始环境变量读取值）
  - token 脱敏显示
- 在 sync server 文件顶部加入 `dotenv.config()`。

涉及文件：
- src/sync/http-server.mjs

验证记录：
- node --check src/sync/http-server.mjs
- 启动日志可见策略快照。
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

---

### 16) Copilot 流式事件打通到 Gateway 与 Feishu

关联提交：`acaa04f`

变更目标：
- 基于 Copilot SDK 流式事件，在响应尚未完成时即可将增量内容实时推送到 gateway 与 feishu，提升交互即时性。

主要改动：
- `src/tool/copilot.mjs`
  - 开启 `streaming: true`。
  - `runSessionPrompt` 增加 `onDelta/onDone` 回调。
  - 订阅 `assistant.message_delta`，实时转发增量片段。
  - 在最终输出为空时，回退使用累积的流式文本。
- `src/gateway/server.mjs`
  - `copilot` 方法支持 `stream` 与 `streamId` 参数。
  - 新增 `event` 帧下发能力，推送：
    - `copilot.delta`
    - `copilot.done`
- `src/gateway/protocol.mjs`
  - `hello.features.events` 增加：`copilot.delta`、`copilot.done`。
- `src/bridge/gateway-client.mjs`
  - 支持 `event` 帧分发与 `onEvent` 订阅。
- `src/bridge/feishu.mjs`
  - 新增流式管理器（按 `streamId` 跟踪、聚合、节流 flush）。
  - 订阅 gateway 事件并将流式片段增量推送回飞书。
  - `/copilot` 与默认 copilot 路由统一走带 `stream=true` 的请求链路。

验证记录：
- node --check src/tool/copilot.mjs
- node --check src/gateway/server.mjs
- node --check src/gateway/protocol.mjs
- node --check src/bridge/gateway-client.mjs
- node --check src/bridge/feishu.mjs
- 结果：通过

---

### 17) Feishu Copilot 流式开关与节流参数可配置化

关联提交：`e38c538`

变更目标：
- 将飞书侧 copilot 流式推送从硬编码改为环境变量可配置，便于按不同群聊负载调优实时性与消息频率。

主要改动：
- `src/config.mjs`
  - 新增配置项：
    - `FEISHU_COPILOT_STREAM_ENABLED`（默认 `true`）
    - `FEISHU_COPILOT_STREAM_FLUSH_INTERVAL_MS`（默认 `800`）
    - `FEISHU_COPILOT_STREAM_MIN_CHUNK_CHARS`（默认 `120`）
- `src/bridge/feishu.mjs`
  - 流式管理器改为读取可配置 `flushIntervalMs` 与 `minChunkChars`。
  - 当 `FEISHU_COPILOT_STREAM_ENABLED=false` 时：
    - 不处理 `copilot.delta/done` 事件。
    - `copilot` 请求改为非流式（等待完整响应后回发）。
  - 启动日志打印当前流式配置，便于线上排查。
- `.env.example`
  - 增加上述 3 个参数示例值。
- `README.md`
  - 补充 3 个参数的用途、推荐配置与调优建议。

验证记录：
- node --check src/config.mjs
- node --check src/bridge/feishu.mjs
- 结果：通过

---

### 18) Copilot Session not found 自动恢复重试

关联提交：`a6fe792`

变更目标：
- 解决飞书触发 copilot 时偶发的 `Session not found` 导致请求失败问题，提升会话复用稳定性。

主要改动：
- `src/tool/copilot.mjs`
  - 新增 `isSessionNotFoundError`，用于识别会话失效错误。
  - `runCopilotWithSession` 增加一次性重试：
    - 命中 `Session not found` 时清空 `resumeSessionId`，改为新建会话重试一次。
  - `runCopilotWithSharedSession` 增加一次性重试：
    - 命中 `Session not found` 时断开并清空 `sharedSession/sharedCopilotSessionId`，重建会话后重试一次。
  - 仅对 `Session not found` 触发自愈，不吞掉其他错误。

验证记录：
- node --check src/tool/copilot.mjs
- 结果：通过

---

### 19) 新增 Git 工具（Gateway 指令帧 + 飞书 /git）

关联提交：`d137ebf`

变更目标：
- 为 myclaw 增加基础 git 远程执行能力，支持通过 gateway `git` 方法和飞书 `/git` 命令在当前目录执行 allowlist 内的 git 指令。

主要改动：
- `src/tool/git.mjs`
  - 新增 git 工具执行模块，基于 `execFile("git", args)` 非 shell 执行。
  - 支持输入：
    - `command` 字符串（内部解析为 args）
    - `args` 数组
  - 增加子命令 allowlist 校验与超时控制。
  - 输出统一结构：`ok/subcommand/output/stdout/stderr/exitCode`。
- `src/gateway/server.mjs`
  - 新增 gateway 方法：`git`。
  - `METHODS` 宣告加入 `git`，`hello.features.methods` 可见。
  - 调用 git 工具执行后返回结构化结果；失败返回 `TOOL_ERROR`。
- `src/bridge/feishu.mjs`
  - `/help` 新增 `/git <args>`。
  - 新增 `/git` 命令路由，透传到 gateway `git` 方法。
- `src/config.mjs`
  - 新增配置组：`git`：
    - `GIT_ENABLED`
    - `GIT_WORK_DIR`
    - `GIT_TIMEOUT_MS`
    - `GIT_ALLOWED_COMMANDS`
- `.env.example`
  - 增加 git 工具相关示例配置。
- `README.md`
  - 更新方法列表与环境变量说明。
  - 增加 `git` gateway 指令帧示例。
  - 增加飞书 `/git` 使用说明。

验证记录：
- node --check src/tool/git.mjs
- node --check src/gateway/server.mjs
- node --check src/bridge/feishu.mjs
- node --check src/config.mjs
- node --input-type=module -e "import { runGitCommand } from './src/tool/git.mjs'; ..."
- 结果：通过

---

### 20) 新增 Service Restart 工具（仅支持 restart）

关联提交：`7b8b01c`

变更目标：
- 支持通过 gateway 指令帧与飞书命令远程触发服务重启。
- 按约束仅提供 `restart` 能力，不开放其他 service 操作。

主要改动：
- `src/tool/service.mjs`
  - 新增服务工具 `restartService`，仅支持目标：`gateway|bridge|all`。
  - 通过 PM2 执行：`pm2 restart <name> --update-env`。
  - 返回结构化结果：`ok/target/serviceNames/results/output`。
- `src/gateway/server.mjs`
  - 新增 gateway 方法：`service.restart`。
  - `METHODS` 列表加入 `service.restart`。
  - 执行失败返回 `TOOL_ERROR`。
- `src/bridge/feishu.mjs`
  - `/help` 新增 `/service restart <gateway|bridge|all>`。
  - 新增 `/service` 命令路由，仅允许 `restart` 子命令并透传至 gateway。
- `src/config.mjs`
  - 新增配置组：`service`：
    - `SERVICE_ENABLED`
    - `SERVICE_WORK_DIR`
    - `SERVICE_TIMEOUT_MS`
    - `SERVICE_PM2_BIN`
    - `SERVICE_PM2_GATEWAY_NAME`
    - `SERVICE_PM2_BRIDGE_NAME`
- `.env.example`
  - 增加 `SERVICE_*` 示例配置。
- `README.md`
  - 更新方法列表与环境变量。
  - 新增 Service Restart（PM2）使用说明、gateway 请求示例、飞书命令示例。
  - 补充本地 PM2 二进制路径说明。
- `package.json` / `package-lock.json`
  - 增加 `pm2` 依赖，支持本地托管与重启调用。

验证记录：
- node --check src/tool/service.mjs
- node --check src/gateway/server.mjs
- node --check src/bridge/feishu.mjs
- node --check src/config.mjs
- node --input-type=module -e "import { restartService } from './src/tool/service.mjs'; ..."
- 结果：通过（若 PM2 进程名未注册会返回 not found，属于运行态配置问题）

---

## 2026-04-12

### 21) 新增 Copilot Skills 管理（skills.list/add/remove）

关联提交：`e23b4bd`

变更目标：
- 支持通过网关与飞书命令动态管理 Copilot SDK `skillDirectories`。
- 在会话创建与恢复时自动加载已登记技能目录。

主要改动：
- `src/tool/skills.mjs`
  - 新增技能目录持久化模块。
  - 提供 `listSkills/addSkill/removeSkill/getSkillDirectoriesForSession`。
  - 默认持久化文件：`data/copilot-skills.json`（原子写：tmp + rename）。
- `src/tool/copilot.mjs`
  - `createSession/resumeSession` 前动态读取 `skillDirectories`。
  - 增加技能签名比对；当技能目录变化时重建共享 session。
- `src/gateway/server.mjs`
  - 新增网关方法：`skills.list`、`skills.add`、`skills.remove`。
  - 在 add/remove 后重置共享 copilot session，确保后续请求加载新技能。
- `src/bridge/feishu.mjs`
  - 新增命令：`/skills list|add|remove`。
  - `/help` 同步更新命令说明。
- `src/config.mjs`
  - 新增配置：`COPILOT_SKILLS_FILE`。
- `README.md`
  - 更新 methods、环境变量与 Skills Tool 使用说明。
- `.gitignore`
  - 新增 `skills/` 忽略规则。

涉及文件：
- .gitignore
- README.md
- src/bridge/feishu.mjs
- src/config.mjs
- src/gateway/server.mjs
- src/tool/copilot.mjs
- src/tool/skills.mjs

验证记录：
- node --check src/tool/skills.mjs
- node --check src/tool/copilot.mjs
- node --check src/gateway/server.mjs
- node --check src/bridge/feishu.mjs
- node --check src/config.mjs
- node -e "import('./src/tool/skills.mjs').then(async (m)=>{...add/list/remove...})"
- 结果：通过

---

## 2026-04-14

### 22) Copilot Hooks 安全策略配置化（工具白名单 / 目录限制 / 破坏性操作询问）

关联提交：`fb5bfb4`

变更目标：
- 基于 Copilot SDK hooks，将会话权限策略改为 .env 可配置。
- 实现三类策略：
  - 安全工具白名单
  - 指定目录访问限制
  - 破坏性操作前询问

主要改动：
- `src/tool/copilot.mjs`
  - 新增 hooks 构建逻辑（`onPreToolUse`）：
    - 工具不在 `COPILOT_SAFE_TOOLS` 内则拒绝。
    - 访问路径超出 `COPILOT_ALLOWED_DIRS` 则拒绝。
    - 命中 `COPILOT_DESTRUCTIVE_TOOLS` 且启用询问策略时返回 `ask`。
  - 新增 `resolvePermissionHandler`，支持 `COPILOT_PERMISSION_REQUEST_MODE`：
    - `auto|approve|deny|delegate`。
  - 会话配置中注入 `hooks` 与 `onPermissionRequest`。
- `src/config.mjs`
  - 新增 copilot 配置项：
    - `COPILOT_HOOK_ENABLED`
    - `COPILOT_SAFE_TOOLS`
    - `COPILOT_RESTRICTED_DIR_TOOLS`
    - `COPILOT_ALLOWED_DIRS`
    - `COPILOT_ASK_BEFORE_DESTRUCTIVE`
    - `COPILOT_DESTRUCTIVE_TOOLS`
    - `COPILOT_PERMISSION_REQUEST_MODE`
- `.env.example`
  - 增加上述 hook 策略参数示例。
- `README.md`
  - 补充环境变量说明。
  - 新增 Copilot Hook 安全策略配置示例与行为说明。

验证记录：
- node --check src/tool/copilot.mjs
- node --check src/config.mjs
- 结果：通过

---

### 23) Copilot Hooks 工具策略改为黑名单 + Skills 路径错误提示增强

关联提交：`cd21e13`

变更目标：
- 避免单一 `COPILOT_SAFE_TOOLS` 白名单误伤 MCP 业务工具调用（如腾讯会议技能）。
- 优化 `skills.add` 目录拼写错误时的可诊断性。

主要改动：
- `src/tool/copilot.mjs`
  - 将工具策略从“白名单放行”改为“黑名单拦截”。
  - 命中 `COPILOT_BLOCKED_TOOLS` 时拒绝，其余工具不再因不在白名单而被阻断。
- `src/config.mjs`
  - 配置项由 `COPILOT_SAFE_TOOLS` 调整为 `COPILOT_BLOCKED_TOOLS`。
- `.env.example`
  - 示例变量同步改为 `COPILOT_BLOCKED_TOOLS`。
- `README.md`
  - 环境变量与策略说明同步更新为黑名单语义。
- `src/tool/skills.mjs`
  - `skills path is not accessible` 报错增强：当 ENOENT 时，自动给出同级目录中最接近的候选名称（did you mean）。

验证记录：
- node --check src/tool/copilot.mjs
- node --check src/config.mjs
- node --check src/tool/skills.mjs
- node --input-type=module -e "import { addSkill } from './src/tool/skills.mjs'; ..."
- 结果：通过

---

## 2026-04-15

### 24) MCP 服务配置接入 Copilot SDK，并改造飞书 /mcp add|remove 命令

关联提交：本次提交

变更目标：
- 支持通过网关与飞书命令动态管理 MCP 服务配置。
- 将 `config/mcporter.json` 中的 `mcpServers` 自动注入 Copilot SDK session。
- 将飞书命令从 `/mcp <json_config>` 收敛为显式子命令：`/mcp add <mcp_config>`、`/mcp remove <mcp_name>`。

主要改动：
- `src/tool/mcp.mjs`
  - 新增 MCP 配置管理模块。
  - 提供 `listMcpServers/upsertMcpServers/removeMcpServer`。
  - 支持标准格式：`{"mcpServers": {"name": {...}}}`。
  - 兼容 `baseUrl -> url` 归一化，并自动推断部分 `type`。
- `src/tool/copilot.mjs`
  - 在 `createSession/resumeSession` 前加载 `config/mcporter.json` 的 `mcpServers`。
  - 将 `mcpServers` 注入 Copilot SDK session 配置。
  - 共享会话签名增加 `mcpServers`，配置变化后自动重建 session。
- `src/gateway/server.mjs`
  - 新增网关方法：`mcp.list`、`mcp.add`、`mcp.remove`。
  - 在 add/remove 后重置共享 copilot session，确保后续请求加载最新 MCP 配置。
- `src/bridge/feishu.mjs`
  - 新增命令：`/mcp list`、`/mcp add <mcp_config>`、`/mcp remove <mcp_name>`。
  - 移除旧的 `/mcp <json_config>` 入口。
- `src/config.mjs`
  - 新增配置：`COPILOT_MCP_CONFIG_FILE`。
- `.env.example`
  - 增加 `COPILOT_MCP_CONFIG_FILE=config/mcporter.json` 示例。
- `README.md`
  - 更新 methods、环境变量与 MCP 配置说明。

涉及文件：
- .env.example
- README.md
- src/bridge/feishu.mjs
- src/config.mjs
- src/gateway/server.mjs
- src/tool/copilot.mjs
- src/tool/mcp.mjs

验证记录：
- node --check src/tool/mcp.mjs
- node --check src/tool/copilot.mjs
- node --check src/gateway/server.mjs
- node --check src/bridge/feishu.mjs
- node --check src/config.mjs
- node -e "import('./src/tool/mcp.mjs').then(async (m)=>{...list current mcporter...})"
- node -e "import('./src/tool/mcp.mjs').then(async (m)=>{...upsert/list/remove temp mcporter...})"
- 结果：通过

---

## 2026-04-17

### 25) 新增 SQL 能力（Gateway `sql` + 飞书 `/sql`）并切换为 Copilot 执行

关联提交：`6ca0e8d`

变更目标：
- 支持通过网关 `sql` 方法和飞书 `/sql` 命令处理自然语言 SQL 请求。
- 将 SQL 执行责任下沉到 Copilot（由 Copilot 调用本地工具执行并回传结果），网关侧负责转发与回传。

主要改动：
- `src/tool/sql.mjs`
  - 新增 SQL 请求处理模块。
  - `buildSqlGenerationPrompt` 负责构建“翻译 + 执行 + 返回结果”的任务指令。
  - `runSqlRequest` 改为直接调用 `runCopilotWithSharedSession` 并返回 Copilot 输出。
- `src/gateway/server.mjs`
  - `METHODS` 增加 `sql`。
  - 新增 `sql` 方法分发逻辑，参数支持 `text/prompt`。
- `src/bridge/feishu.mjs`
  - `/help` 增加 `/sql <自然语言查询>`。
  - 新增 `/sql` 命令路由并透传到网关 `sql`。
- `src/config.mjs`
  - 新增 `sql` 配置组：`SQL_ENABLED/SQL_WORK_DIR/SQL_DB_FILE/SQL_TIMEOUT_MS/SQL_SCHEMA_HINT`。
- `.env.example`
  - 增加 `SQL_*` 示例配置。
- `README.md`
  - 更新 methods、环境变量与 SQL Tool 使用说明。

涉及文件：
- src/tool/sql.mjs
- src/gateway/server.mjs
- src/bridge/feishu.mjs
- src/config.mjs
- .env.example
- README.md

验证记录：
- node --check src/tool/sql.mjs
- node --check src/gateway/server.mjs
- node --check src/bridge/feishu.mjs
- node --check src/config.mjs
- 结果：通过

---

## 2026-04-18

### 26) 新增 cron.nl 自然语言调度入口并改为显式 `/cron nl` 命令

关联提交：本次提交

变更目标：
- 增加网关 `cron.nl` 方法，将自然语言转换为结构化 cron 操作后执行。
- 飞书端将隐式自然语言回退改为显式子命令：`/cron nl <自然语言>`。
- 避免自然语言规划 prompt 污染共享会话：cron 规划器改为独立新会话执行。

主要改动：
- `src/tool/cron.mjs`
  - 新增 cron 规划器模块：`planCronOperation`。
  - 通过 `runCopilotWithSession` 执行自然语言规划，并设置 `reuseSession: false`，确保每次规划使用新会话。
  - 解析 Copilot 返回 JSON，限制 action 为 `list/add/update/remove/run`。
- `src/gateway/server.mjs`
  - `METHODS` 增加 `cron.nl`。
  - 新增 `cron.nl` 路由：先调用规划器，再按解释结果分发到 `cron.list/add/update/remove/run`。
- `src/bridge/feishu.mjs`
  - `/help` 增加 `/cron nl <自然语言>`。
  - `/cron` 路由新增 `nl` 子命令分支。
  - 移除“未知子命令自动走自然语言”行为，改为明确 usage 提示。
- `README.md`
  - 方法列表增加 `cron.nl`。
  - 增加 `cron.nl` 网关请求示例与飞书自然语言命令说明。

涉及文件：
- src/tool/cron.mjs
- src/gateway/server.mjs
- src/bridge/feishu.mjs
- README.md

验证记录：
- node --check src/tool/cron.mjs
- node --check src/gateway/server.mjs
- node --check src/bridge/feishu.mjs
- 结果：通过

---

### 27) SQL 工具改为单次会话执行（不复用共享 Copilot 会话）

关联提交：本次提交

变更目标：
- 避免 SQL 任务受历史共享会话上下文影响，确保每次 SQL 请求在新会话中执行。

主要改动：
- `src/tool/sql.mjs`
  - 调用入口从 `runCopilotWithSharedSession` 改为 `runCopilotWithSession`。
  - 调用参数中显式设置 `reuseSession: false`，强制不复用会话。

涉及文件：
- src/tool/sql.mjs

验证记录：
- node --check src/tool/sql.mjs
- 结果：通过

---

### 28) Service 能力升级：多指令 + 可配置 target 映射 + /help 按开关显示

关联提交：本次提交

变更目标：
- 当 `SERVICE_ENABLED=false` 时，飞书 `/help` 不显示任何 `/service` 命令项。
- 将 service 工具从仅 `restart` 升级为 `list/start/stop/restart/logs`。
- 支持通过配置扩展并管理其它子 service（自定义 target -> pm2 进程名映射）。

主要改动：
- `src/bridge/feishu.mjs`
  - `/help` 中的 service 命令按 `serviceCfg.enabled` 动态显示/隐藏。
  - `/service` 路由支持 `list|start|stop|restart|logs`。
  - `logs` 支持可选参数 `lines`（默认由服务端回退）。
- `src/gateway/server.mjs`
  - `METHODS` 增加 `service.list`、`service.start`、`service.stop`、`service.logs`。
  - service 路由改为统一分发到 `runServiceAction`。
- `src/tool/service.mjs`
  - 新增通用执行入口 `runServiceAction`。
  - 统一 PM2 执行逻辑，支持五类 action。
  - 支持从 `config.service.targets` 解析 target 映射。
  - 保留 `restartService` 作为兼容封装。
- `src/config.mjs`
  - 新增 `SERVICE_TARGETS` 解析（JSON），并与默认 `gateway/bridge/all` 合并。
- `README.md`
  - 更新 methods、环境变量、service 使用说明与飞书命令示例。

涉及文件：
- README.md
- src/bridge/feishu.mjs
- src/config.mjs
- src/gateway/server.mjs
- src/tool/service.mjs

验证记录：
- node --check src/config.mjs
- node --check src/tool/service.mjs
- node --check src/gateway/server.mjs
- node --check src/bridge/feishu.mjs
- node --input-type=module -e "import { config } from './src/config.mjs'; import { runServiceAction } from './src/tool/service.mjs'; const result = await runServiceAction({ action: 'list', config: config.service }); console.log(JSON.stringify({ ok: result.ok, action: result.action }, null, 2));"
- 结果：通过

---

### 29) Service 使用方式重构：`<target>` -> `<name>` + 白名单控制

关联提交：本次提交

变更目标：
- 将 service 操作参数从 `/service <action> <target>` 切换为 `/service <action> <name>`。
- 去掉 `SERVICE_PM2_GATEWAY_NAME`、`SERVICE_PM2_BRIDGE_NAME` 和 `SERVICE_TARGETS` 的 target 映射逻辑。
- 新增 service 白名单，只有白名单中的 PM2 服务名允许执行 `start/stop/restart/logs`。

主要改动：
- `src/tool/service.mjs`
  - 删除 target 映射解析与多服务聚合执行。
  - 新增 `resolveWhitelistedServiceName`，严格校验服务名是否在白名单。
  - `runServiceAction` 参数改为 `name`，并输出 `name/serviceName` 字段。
- `src/config.mjs`
  - 删除 `SERVICE_PM2_GATEWAY_NAME`、`SERVICE_PM2_BRIDGE_NAME`、`SERVICE_TARGETS` 解析。
  - 新增 `SERVICE_WHITELIST`（逗号分隔），默认值为 `myclaw-gateway,myclaw-feishu`。
- `src/gateway/server.mjs`
  - service 路由入参从 `target` 改为 `name`，并调整错误提示。
- `src/bridge/feishu.mjs`
  - `/help` 示例改为 `<name>`。
  - `/service` 解析和 usage 提示改为 `<name>`。
- `README.md`、`.env.example`
  - 同步更新环境变量说明、请求示例、飞书命令示例与默认配置。

涉及文件：
- .env.example
- README.md
- src/bridge/feishu.mjs
- src/config.mjs
- src/gateway/server.mjs
- src/tool/service.mjs

验证记录：
- node --check src/tool/service.mjs
- node --check src/config.mjs
- node --check src/gateway/server.mjs
- node --check src/bridge/feishu.mjs
- 结果：通过

---

### 30) Copilot 会话按飞书复合键隔离 + Feishu 固定路由分片

关联提交：本次提交

变更目标：
- 将 Copilot 共享会话从“单一全局 session”升级为“按 `sessionKey` 复用”。
- Feishu bridge 在 Copilot 模式下按 `appId + 会话类型 + chatId/openId` 生成复合会话键，避免不同飞书会话上下文混用。
- 增加 Feishu 固定路由分片能力，支持同一会话稳定命中同一 bridge 实例处理。

主要改动：
- `src/tool/copilot.mjs`
  - 共享会话状态由单值改为按 key 的 Map 结构（session/queue/sessionId/signature）。
  - `runCopilotWithSharedSession` 新增可选参数 `sessionKey`（默认仍兼容全局 key）。
  - `resetSharedCopilotSessionId` 支持按 key 清理或全量清理。
- `src/gateway/server.mjs`
  - `copilot` 方法支持透传 `params.sessionKey` 给 `runCopilotWithSharedSession`。
- `src/bridge/feishu.mjs`
  - 新增飞书复合会话键生成：`feishu:${appId}:group:${chatId}` 或 `feishu:${appId}:dm:${openId}`。
  - Copilot 请求统一携带 `sessionKey`。
  - 新增固定路由分片逻辑（hash + shard）：
    - `FEISHU_ROUTE_TOTAL_SHARDS`
    - `FEISHU_ROUTE_SHARD_INDEX`
    - `FEISHU_ROUTE_SALT`
  - 非当前 shard 负责的会话将直接跳过处理。
- `src/config.mjs`
  - 新增 Feishu 路由配置读取。
- `.env.example` / `README.md`
  - 新增配置项与行为说明文档。

涉及文件：
- .env.example
- README.md
- DEVELOPMENT_LOG.md
- src/bridge/feishu.mjs
- src/config.mjs
- src/gateway/server.mjs
- src/tool/copilot.mjs

验证记录：
- node --check src/tool/copilot.mjs
- node --check src/gateway/server.mjs
- node --check src/bridge/feishu.mjs
- node --check src/config.mjs
- 结果：通过

---

## 2026-04-25

### 31) 拦截审批页面外置为独立 HTML，并由 Sync Server 加载

关联提交：本次提交

变更目标：
- 将 `renderInterceptApprovalPage` 的内嵌模板迁移到独立 HTML 文件，便于后续单独维护页面样式与脚本。

主要改动：
- 新增审批页面文件：`src/sync/intercept-approval.html`。
- `src/sync/http-server.mjs` 中 `renderInterceptApprovalPage` 改为从文件读取页面内容并返回。
- 增加简单缓存与读取失败兜底页面，避免文件读取异常导致路由崩溃。

涉及文件：
- src/sync/http-server.mjs
- src/sync/intercept-approval.html

验证记录：
- node --check src/sync/http-server.mjs
- 结果：通过

---

## 2026-05-02

### 32) onPostToolUse 结果上报 + Tool Calls 查询 API + 审批页展示

关联提交：本次提交

变更目标：
- 在 Copilot 工具执行后通过 `onPostToolUse` 记录工具参数与结果，并上报到 sync server。
- 提供只读接口查询最近工具调用记录，便于页面和排障使用。
- 在审批页新增“Recent Tool Calls”区域，直接展示最新工具调用数据。

主要改动：
- `src/tool/copilot.mjs`
  - 在 hook 中新增 `onPostToolUse`。
  - 打印工具名、参数、结果（脱敏后）。
  - 调用 `POST /api/copilot/intercepts/event` 上报 `event.toolCall`。
- `src/sync/http-server.mjs`
  - intercepts 存储结构新增 `tool_calls`（保留最近 100 条）。
  - `POST /api/copilot/intercepts/event` 中新增 `event.toolCall` 落盘。
  - 新增只读接口：`GET /api/copilot/intercepts/tool-calls?limit=...`（默认 100，最大 500，倒序返回）。
- `src/sync/intercept-approval.html`
  - 新增“Recent Tool Calls”展示面板。
  - `refresh()` 并行拉取 `/api/copilot/intercepts/tool-calls?limit=20` 并渲染 args/result。

涉及文件：
- src/tool/copilot.mjs
- src/sync/http-server.mjs
- src/sync/intercept-approval.html

验证记录：
- node --check src/tool/copilot.mjs
- node --check src/sync/http-server.mjs
- 结果：通过


---

## 2026-05-02

### 33) 启动 src 目录 TypeScript 迁移（仅核心代码）

关联提交：本次提交

变更目标：
- 将 `src/` 下核心业务代码从 `.mjs` 迁移为 `.ts`。
- 保持 Node ESM 运行形态，产物输出到 `dist/`。

主要改动：
- 新增 `tsconfig.json`：
  - `module/moduleResolution` 使用 `NodeNext`
  - 输出目录 `dist/`
  - 迁移初期使用 `build --noCheck`，先保证可编译可运行
- `src/` 下 18 个 `.mjs` 文件全部重命名为 `.ts`。
- 修正所有内部相对导入后缀：`.mjs` -> `.js`（适配 NodeNext 产物运行）。
- 更新 `package.json`：
  - `main` 切到 `dist/index.js`
  - 新增 `build` / `typecheck` 脚本
  - `start` / `bridge:feishu` / `sync-server` 改为运行 `dist/*`
  - 新增 `postbuild`，复制 `src/sync/intercept-approval.html` 到 `dist/sync/`
- 更新文档中源码后缀示例（README 中 `.mjs` -> `.ts`）。

涉及文件：
- tsconfig.json
- package.json
- src/**/*.ts（由原 src/**/*.mjs 迁移）
- README.md

验证记录：
- `npm run build`（`tsc --noCheck`）
- `node --check dist/index.js`
- `node --check dist/sync/http-server.js`
- 结果：通过

后续计划：
- 逐步清理 `npm run typecheck` 的类型错误（当前迁移阶段已允许先编译后治理类型）。

---

### 34) TypeScript 类型收敛：清理 `as any`、替换宽松输入为 DTO

关联提交：本次提交

变更目标：
- 在不改变业务行为的前提下，逐步将宽泛输入（`unknown`/隐式宽类型）替换为更明确的 request/response DTO。
- 保持 `npm run typecheck` 持续通过。

主要改动：
- `src/tool/sql.ts`
  - 新增 `SqlToolConfig`、`CopilotRuntimeConfig`、`RunSqlRequestInput`。
  - 去除默认 `as any`，改为显式入参类型。
- `src/tool/cron.ts`
  - 新增 `PlanCronOperationInput`、`CronJobSnapshot`。
  - 去除宽松索引签名与 `jobs?: unknown[]`。
- `src/tool/git.ts`、`src/tool/service.ts`
  - 新增工具配置 DTO（`GitToolConfig`、`ServiceToolConfig`）与对应入参类型。
  - 去除默认 `as any`。
- `src/bridge/feishu.ts`
  - 新增 `TenantAccessTokenResponse`、`GatewayCopilotResponse`、`GatewayAgentResponse`、`ServiceRequestParams`、`WsClientCompat`。
  - 将 service 请求参数与 gateway 返回值转为明确类型。
- `src/model/client.ts`
  - 新增 `ChatCompletionsResponse`、`ResponsesApiResponse`。
  - 将 JSON 响应解析从泛化写法收敛为明确响应结构。
- `src/sync/http-server.ts`
  - 新增请求体 DTO：`InterceptPretoolBody`、`InterceptDecisionBody`、`InterceptEventBody`、`JobUpsertBody`、`RunAppendBody` 等。
  - `parseBody` 升级为泛型函数，在各路由按 DTO 解析请求体。
- `src/tool/copilot.ts`
  - 新增 `InterceptDecisionPayload` 等响应结构类型。
  - 拦截查询/决策链路统一按 DTO 消费返回数据。

验证记录：
- `npm run typecheck`
- 结果：通过（`TYPECHECK_OK`）

---

## 2026-05-05

### 35) Feishu 审核链路改为交互卡片按钮（Approve / Deny）

关联提交：本次提交

变更目标：
- 去掉飞书审核文本命令（`/approve`、`/deny`、`/pending`）和对应命令路由。
- 审核通知从纯文本改为飞书交互卡片，直接在卡片上点击 `Approve` / `Deny` 完成审批。
- 点击按钮后直接回写 `/api/copilot/intercepts/decision`，并把原卡片更新为已审批状态。

主要改动：
- `src/bridge/feishu.ts`
  - 新增审核卡片构造：`buildInterceptReviewCard`，包含请求详情与按钮动作值。
  - 审核 worker 从文本消息通知改为发送 `interactive` 卡片。
  - 新增 `card.action.trigger` 回调处理：
    - 解析按钮动作（approve/deny）与 requestId
    - 调用 decision 接口写回审批结果
    - 返回新卡片内容更新原消息，并回传 toast 提示
  - 删除审核命令处理入口（不再通过 `/approve` / `/deny` 文本命令审批）。
  - 保留审核轮询与去重逻辑（waiting 队列 -> 发卡片）。
- `README.md`
  - 更新 `FEISHU_INTERCEPT_REVIEW_CHAT_ID` 描述为“卡片通知 + 按钮回调”。
  - 审核流程说明改为卡片按钮模式，并增加订阅要求：`card.action.trigger`。
- `.env.example`
  - 保留并沿用现有 `FEISHU_INTERCEPT_REVIEW_*` 配置项，适配卡片审批模式。

涉及文件：
- src/bridge/feishu.ts
- src/config.ts
- README.md
- .env.example
- DEVELOPMENT_LOG.md

验证记录：
- `npm run typecheck`
- `npm run build`
- 结果：通过

---

### 36) 外部审批后自动回刷已发送飞书审核卡片

关联提交：本次提交

变更目标：
- 当审批不是通过飞书卡片按钮触发（例如在网页审批页或其他调用方直接写 decision）时，Feishu bridge 也能及时更新此前已发送的审核卡片状态。

主要改动：
- `src/bridge/feishu.ts`
  - 审核 worker 新增已发送卡片跟踪表（`requestId -> messageId`）。
  - 发送 waiting 卡片时记录 `message_id`，建立请求与卡片映射。
  - 轮询逻辑新增“已发卡片状态同步”步骤：
    - 对不在 waiting 队列中的已跟踪 request，调用 `GET /api/copilot/intercepts/decision?id=...` 查询当前状态。
    - 若状态已变为 `approved/denied`，主动调用飞书消息更新接口（PATCH）回刷原交互卡片。
  - 按钮审批路径保留原有返回卡片更新，并同步标记本地跟踪状态。
  - 新增飞书消息更新 helper：`updateFeishuInteractiveMessage`。
  - `sendFeishuMessage` 调整为返回 create/reply API 结果，便于提取 `message_id`。

涉及文件：
- src/bridge/feishu.ts

验证记录：
- `npm run typecheck`
- `npm run build`
- 结果：通过

---

## 2026-05-12

### 37) Feishu 附件监听模式：缓存图片/文件直到收到文本消息

变更目标：
- 优化飞书消息流程：收到图片或文件时不立即发送给 Copilot，而是进入会话级监听缓存。
- 等待用户在同一会话发送文本消息，此时再将所有缓存的附件整理为上下文，与文本一起提交给 Copilot。
- 改善用户体验：用户可以先发送多个图片/文件，然后发送一条指令，Copilot 会同时看到所有上下文。

主要改动：
- `src/bridge/feishu.ts`
  - 新增 `PendingAttachmentItem` 与 `PendingAttachmentState` 类型定义。
  - 新增 `pendingAttachments` Map 管理会话级缓存，key 为 `copilotSessionKey`，value 为 `{ items, expireAtMs }`。
  - 新增常量 `ATTACHMENT_LISTEN_WINDOW_MS = 5 * 60 * 1000`（5 分钟监听窗口）。
  - 新增辅助函数：
    - `isTextLikeFile(item)`: 识别 `.md` / `.txt` / `text/*` 类型文件。
    - `cleanupAttachmentItems(items)`: 删除临时文件。
    - `clearExpiredPendingAttachments(scopeKey)`: 清理过期缓存。
    - `appendPendingAttachment(scopeKey, item)`: 将附件添加到缓存。
    - `consumePendingAttachmentContext(scopeKey, fileMaxTextChars)`: 消费缓存并返回 `{ context, items }`。
  - 修改消息处理流程：
    - 若收到非文本的图片/文件（`inbound.kind === "image"` 或 `"file"`）：下载到临时目录，调用 `appendPendingAttachment` 入队，回复用户"已缓存，等待文本消息"。
    - 若收到文本消息：调用 `consumePendingAttachmentContext` 取出缓存附件，整理为上下文块，拼接到用户文本前方。

涉及文件：
- src/bridge/feishu.ts

验证记录：
- `npm run typecheck`：通过
- `npm run build`：通过

---

### 38) Bugfix: 修复临时文件过早删除导致 Copilot 无法读取附件

变更目标：
- 修复在附件监听模式中，Copilot 收到附件路径后报错"文件不存在"的问题。
- 根本原因：`consumePendingAttachmentContext()` 内部在编译完上下文后立即调用 `cleanupAttachmentItems()`，此时 Copilot 还未读取这些文件。
- 解决方案：将临时文件清理延迟到 Copilot 处理完成后再执行。

主要改动：
- `src/bridge/feishu.ts`
  - 修改 `consumePendingAttachmentContext()` 返回值：不再调用清理，改为返回 `{ context, items }`。
  - 在消息处理器顶层（try 块外）新增 `let pendingAttachmentCleanupItems = []` 数组。
  - 在获取 pending 内容时（lines ~1706-1707），提取返回的 `items` 并赋值给 `pendingAttachmentCleanupItems`。
  - 新增 finally 块（lines ~1762-1766），在 Copilot 响应完成后统一执行清理：`await cleanupAttachmentItems(pendingAttachmentCleanupItems)`。
  - 确保文件生命周期：下载 -> Copilot 读取 -> 清理。

涉及文件：
- src/bridge/feishu.ts

验证记录：
- `npm run typecheck`：通过（zero errors）
- `npm run build`：通过
- `./node_modules/.bin/pm2 restart 1`：进程 myclaw-feishu 重启成功，状态 online

后续测试：
- 发送图片 -> 文本消息序列，验证 Copilot 能正确读取图片文件。

