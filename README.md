# MyClaw MVP (Gateway v1)

This is a minimal Gateway-only MVP inspired by OpenClaw.

## Features

- WebSocket gateway at `/ws`
- First-frame `connect` handshake with token auth
- Minimal methods: `connect`, `health`, `send`, `agent`
- In-memory sessions
- Optional OpenAI call via Responses API
- Optional Doubao call via ChatCompletions streaming API
- HTTP health endpoint at `/health`

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

## Environment Variables

- `PORT`: gateway port (default `18789`)
- `GATEWAY_TOKEN`: required token for websocket connect
- `LLM_PROVIDER`: model provider for `agent` (default `openai`, supports `openai` or `doubao`)
- `OPENAI_API_KEY`: optional, if empty uses fallback echo reply
- `OPENAI_MODEL`: default `gpt-4.1-mini`
- `DOUBAO_API_KEY`: optional, if empty uses fallback echo reply
- `DOUBAO_MODEL`: default `doubao-1-5-pro-32k-250115`
- `DOUBAO_ENDPOINT`: default `https://ark.cn-beijing.volces.com/api/v3/chat/completions`
- Strict mode: `agent` requests do not allow `params.provider` or `params.model`; provider/model are fixed by `.env` at server startup.

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
  "params": { "sessionId": "main", "text": "你好" }
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

## Notes

- This is intentionally minimal and not production hardened.
- Sessions are kept in memory and reset on restart.
