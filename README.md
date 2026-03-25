# MyClaw MVP (Gateway v1)

This is a minimal Gateway-only MVP inspired by OpenClaw.

## Features

- WebSocket gateway at `/ws`
- First-frame `connect` handshake with token auth
- Minimal methods: `connect`, `health`, `send`, `agent`
- In-memory sessions
- Generic LLM adapter with one unified entrypoint
- Supports `responses` and `chat_completions` protocols
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
- `LLM_PROVIDER`: provider label (example: `openai`, `doubao`)
- `LLM_PROTOCOL`: request protocol (`responses` or `chat_completions`)
- `LLM_ENDPOINT`: API endpoint URL
- `LLM_MODEL`: model name
- `LLM_API_KEY`: API key (optional; empty means fallback echo reply)
- `LLM_STREAM`: stream mode for `chat_completions` (`true`/`false`)

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

## Notes

- This is intentionally minimal and not production hardened.
- Sessions are kept in memory and reset on restart.
