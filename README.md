# MyClaw MVP (Gateway v1)

This is a minimal Gateway-only MVP inspired by OpenClaw.

## Features

- WebSocket gateway at `/ws`
- First-frame `connect` handshake with token auth
- Minimal methods: `connect`, `health`, `send`, `agent`
- In-memory sessions
- Optional OpenAI call via Responses API
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
- `OPENAI_API_KEY`: optional, if empty uses fallback echo reply
- `OPENAI_MODEL`: default `gpt-4.1-mini`

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
  "params": { "sessionId": "main", "text": "hello" }
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
