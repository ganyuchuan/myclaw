# Cloud Auth API 接入文档

本文档用于客户端对接首登授权流程，覆盖 `/auth/token` 与 `/auth/pairing-token`。

## 总体流程

1. 客户端调用 `POST /auth/token` 申请授权 token 与 4 位配对码。
2. 用户在另一端输入 4 位配对码。
3. 客户端调用 `POST /auth/pairing-token` 用配对码换取 token。
4. 客户端将返回的 `authToken` 作为 Bearer Token 调用 `/api/copilot/intercepts/*`。

## 1) 申请授权

### POST /auth/token

- URL: `http://<cloud-host>:18790/auth/token`
- Method: `POST`
- Content-Type: `application/json`

Request Body:

```json
{
  "username": "alice"
}
```

参数说明：

- `username`：必填，用户展示名/登录名。

Success Response (200):

```json
{
  "ok": true,
  "userId": "u_xxx",
  "authToken": "xxxxxxxx",
  "username": "alice",
  "pairingCode": "9035",
  "pairingCodeExpiresAtMs": 1760000000000,
  "pairingCodeTtlMs": 1800000,
  "onboardingUrl": "http://127.0.0.1:18790/"
}
```

字段说明：

- `authToken`：后续接口 Bearer Token。
- `pairingCode`：4 位数字配对码。
- `pairingCodeExpiresAtMs`：配对码过期时间戳（毫秒）。
- `pairingCodeTtlMs`：配对码有效时长，当前默认 30 分钟。
- `onboardingUrl`：安装/引导页地址。

Error Response:

- `400`：`username is required`

Curl 示例：

```bash
curl -sS -X POST "http://127.0.0.1:18790/auth/token" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice"}'
```

## 2) 配对码换 Token

### POST /auth/pairing-token

- URL: `http://<cloud-host>:18790/auth/pairing-token`
- Method: `POST`
- Content-Type: `application/json`

Request Body:

```json
{
  "pairingCode": "9035"
}
```

Success Response (200):

```json
{
  "ok": true,
  "pairingCode": "9035",
  "userId": "u_xxx",
  "username": "alice",
  "authToken": "xxxxxxxx",
  "expiresAtMs": 1760000000000
}
```

Error Response:

- `400`：`pairingCode must be 4 digits`
- `404`：`pairingCode not found or expired`

Curl 示例：

```bash
curl -sS -X POST "http://127.0.0.1:18790/auth/pairing-token" \
  -H "Content-Type: application/json" \
  -d '{"pairingCode":"9035"}'
```

## 3) 使用 authToken 访问拦截接口

Headers:

```http
Authorization: Bearer <authToken>
```

示例（读取状态）：

```bash
curl -sS "http://127.0.0.1:18790/api/copilot/intercepts/state" \
  -H "Authorization: Bearer <authToken>"
```

## 接入注意事项

- `/api/copilot/intercepts/*` 只接受 Bearer Token，不支持 query 透传 token。
- 建议客户端在 `pairingCodeTtlMs` 到期前完成配对；超时后应重新调用 `/auth/token`。
- 返回字段为 `username`（不是 `userName`），客户端请按接口字段名解析。
