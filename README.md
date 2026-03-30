# MyClaw MVP (Gateway v1)

This is a minimal Gateway-only MVP inspired by OpenClaw.

## Features

- WebSocket gateway at `/ws`
- First-frame `connect` handshake with token auth
- Minimal methods: `connect`, `health`, `send`, `agent`, `copilot`
- In-memory sessions
- Generic LLM adapter with one unified entrypoint
- Supports `responses` and `chat_completions` protocols
- HTTP health endpoint at `/health`
- `copilot` method: call `gh copilot` CLI in non-interactive mode

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
- `FEISHU_GATEWAY_URL`: myclaw gateway websocket url
- `FEISHU_GATEWAY_TOKEN`: gateway token used by feishu bridge
- `FEISHU_CLIENT_ID`: feishu bridge client id used in gateway connect
- `FEISHU_REQUEST_TIMEOUT_MS`: gateway request timeout for feishu bridge
- `COPILOT_ENABLED`: enable gh copilot tool (`true`/`false`, default `true`)
- `COPILOT_TIMEOUT_MS`: timeout for gh copilot execution (default `120000`)
- `COPILOT_MODEL`: model to use (empty = copilot default)
- `COPILOT_ALLOW_ALL_TOOLS`: allow copilot to use all tools unattended (`true`/`false`, default `true`)
- `COPILOT_WORK_DIR`: working directory for copilot (empty = process cwd)

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
- Text message only (`message_type=text`).
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
