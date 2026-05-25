# Alimbo Desktop Onboarding Skill

## Goal

Use this guide to install alimbo on desktop and finish first-time pairing config.

## Steps

1. Install package:

```bash
npm i -g alimbo
```

2. Run setup wizard:

```bash
alimbo setup
```

3. Enter the 4-digit pairing code from your mobile or wearable device.

4. Setup wizard will:
- Resolve auth token from cloud endpoint /auth/pairing-token
- Bind token into env keys:
  - GATEWAY_TOKEN
  - FEISHU_GATEWAY_TOKEN
  - FEISHU_INTERCEPT_AUTH_TOKEN
  - COPILOT_INTERCEPT_AUTH_TOKEN
- Create .env from .env.example when needed
- Start alimbo gateway in background
- Send a gateway intercept ping to verify cloud reporting path

5. If verification fails, request a new pairing code and run setup again.

## Manual Mode

If you do not use the wizard, you can manually:
1. Create .env from .env.example
2. Fill the four token keys with the resolved token
3. Start gateway with `alimbo start`
