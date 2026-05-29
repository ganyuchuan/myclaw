#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { requestInterceptDecisionByApi } from "./agent-runtime/intercept-decision.js";
import { reportInterceptEventByApi } from "./agent-runtime/intercept-event.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type PairingTokenPayload = {
  ok?: boolean;
  pairingCode?: string;
  authToken?: string;
  userId?: string;
  username?: string;
  expiresAtMs?: number;
};

function toInt(value: string | undefined, fallback: number) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readTextIfExists(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function loadEnvExampleTemplate(cwd: string) {
  const localPath = path.resolve(cwd, ".env.example");
  const localText = readTextIfExists(localPath);
  if (localText.trim()) {
    return localText;
  }

  const bundledPath = path.resolve(__dirname, "../.env.example");
  const bundledText = readTextIfExists(bundledPath);
  if (bundledText.trim()) {
    return bundledText;
  }

  return [
    "PORT=18789",
    "GATEWAY_TOKEN=dev-token",
    "FEISHU_GATEWAY_TOKEN=dev-token",
    "FEISHU_INTERCEPT_AUTH_TOKEN=",
    "COPILOT_INTERCEPT_AUTH_TOKEN=",
    "COPILOT_INTERCEPT_SERVER_URL=http://127.0.0.1:18790",
    "FEISHU_INTERCEPT_SERVER_URL=http://127.0.0.1:18790",
  ].join("\n");
}

function updateEnvContent(baseText: string, overrides: Record<string, string>) {
  const lines = String(baseText ?? "").split(/\r?\n/);
  const seen = new Set<string>();
  const output = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) {
      return line;
    }
    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) {
      return line;
    }
    seen.add(key);
    return `${key}=${overrides[key]}`;
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (!seen.has(key)) {
      output.push(`${key}=${value}`);
    }
  }

  return `${output.join("\n").replace(/\n+$/g, "")}\n`;
}

async function fetchJson(url: string, options: RequestInit = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String((payload as any)?.error ?? response.statusText ?? "request failed"));
  }
  return payload as any;
}

async function resolveTokenByPairingCode({ cloudBaseUrl, pairingCode }: { cloudBaseUrl: string; pairingCode: string }) {
  const payload = await fetchJson(`${cloudBaseUrl}/auth/pairing-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ pairingCode }),
  }) as PairingTokenPayload;

  const token = String(payload?.authToken ?? "").trim();
  if (!token) {
    throw new Error("empty auth token returned by /auth/pairing-token");
  }

  return payload;
}

async function waitForGatewayHealth({ baseUrl, timeoutMs }: { baseUrl: string; timeoutMs: number }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await fetchJson(`${baseUrl}/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (payload?.ok === true) {
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(`gateway health check timeout after ${timeoutMs}ms`);
}

async function verifyInterceptDecisionApi({
  cloudBaseUrl,
  authToken,
  workDir,
}: {
  cloudBaseUrl: string;
  authToken: string;
  workDir: string;
}) {
  const result = await requestInterceptDecisionByApi({
    interceptServerUrl: cloudBaseUrl,
    interceptAuthToken: authToken,
    interceptTimeoutMs: 20000,
    interceptPollIntervalMs: 3000,
    interceptMaxWaitMs: 60000,
    logPrefix: "[alimbo-setup][intercept]",
    request: {
      requestIdCandidates: [`setup_${Date.now()}`],
      toolName: "setup.healthcheck",
      hint: "setup decision api connectivity check",
      msg: "Setup intercept decision connectivity check",
      sessionId: "setup",
      workDir,
      input: {
        toolName: "setup.healthcheck",
        source: "alimbo-setup",
      },
    },
  });

  const decision = String(result?.decision ?? "").trim().toLowerCase() || "deny";
  const reason = String(result?.reason ?? "").trim();
  console.log(`[alimbo-setup] Intercept decision API reachable (decision=${decision}${reason ? `, reason=${reason}` : ""})`);

  return {
    requestId: String(result?.requestId ?? `setup_${Date.now()}`),
    decision,
    reason,
  };
}

async function reportSetupInterceptVerificationEvent({
  cloudBaseUrl,
  authToken,
  workDir,
  verification,
}: {
  cloudBaseUrl: string;
  authToken: string;
  workDir: string;
  verification: {
    requestId: string;
    decision: string;
    reason: string;
  };
}) {
  await reportInterceptEventByApi({
    interceptServerUrl: cloudBaseUrl,
    interceptAuthToken: authToken,
    interceptTimeoutMs: 5000,
    event: {
      msg: "Setup intercept verification completed",
      entry: `Setup intercept verification: decision=${verification.decision}`,
      prompt: {
        id: verification.requestId,
        tool: "setup.healthcheck",
        hint: verification.reason || "setup decision api connectivity check",
      },
      session: {
        id: "setup",
        phase: "setup-intercept-verify",
        ts: Date.now(),
        workDir,
      },
      completed: true,
    },
  });
}

function startGatewayDetached(cwd: string) {
  const target = path.resolve(__dirname, "index.js");
  const child = spawn(process.execPath, [target], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "inherit",
  });
  child.unref();
}

function listListeningPidsByPort(port: number) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return [] as number[];
  }

  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function stopGatewayProcessesOnPort(port: number) {
  const pids = listListeningPidsByPort(port);
  if (!pids.length) {
    return;
  }

  console.log(`[alimbo-setup] Stop existing process(es) on :${port} -> ${pids.join(", ")}`);

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have exited already.
    }
  }

  const startedAt = Date.now();
  const timeoutMs = 5_000;
  while (Date.now() - startedAt < timeoutMs) {
    if (!listListeningPidsByPort(port).length) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const remaining = listListeningPidsByPort(port);
  if (remaining.length) {
    throw new Error(`failed to stop existing gateway process on :${port}; still listening pid(s): ${remaining.join(", ")}`);
  }
}

async function main() {
  const cwd = process.cwd();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("[alimbo-setup] Start desktop onboarding setup");

    const cloudInput = await rl.question("Cloud URL (default http://127.0.0.1:18790): ");
    const cloudBaseUrl = String(cloudInput || "").trim() || "http://127.0.0.1:18790";

    const pairingCodeInput = await rl.question("Pairing code (4 digits): ");
    const pairingCode = String(pairingCodeInput || "").trim();
    if (!/^\d{4}$/.test(pairingCode)) {
      throw new Error("pairing code must be 4 digits");
    }

    console.log("[alimbo-setup] Resolve token via /auth/pairing-token ...");
    const pairingPayload = await resolveTokenByPairingCode({ cloudBaseUrl, pairingCode });
    const token = String(pairingPayload.authToken ?? "").trim();

    const envExample = loadEnvExampleTemplate(cwd);
    const envPath = path.resolve(cwd, ".env");
    const envBase = readTextIfExists(envPath).trim() ? readTextIfExists(envPath) : envExample;
    const envText = updateEnvContent(envBase, {
      GATEWAY_TOKEN: token,
      FEISHU_GATEWAY_TOKEN: token,
      FEISHU_INTERCEPT_AUTH_TOKEN: token,
      COPILOT_INTERCEPT_AUTH_TOKEN: token,
      COPILOT_INTERCEPT_SERVER_URL: cloudBaseUrl,
      FEISHU_INTERCEPT_SERVER_URL: cloudBaseUrl,
      COPILOT_INTERCEPT_ENABLED: "true",
      COPILOT_INTERCEPT_TOOLS: "bash,run_in_terminal,edit_file,create_file,delete_file",
    });
    fs.writeFileSync(envPath, envText, "utf8");
    console.log(`[alimbo-setup] Wrote ${envPath}`);

    const gatewayPort = toInt(process.env.PORT, 18789);
    await stopGatewayProcessesOnPort(gatewayPort);

    console.log("[alimbo-setup] Start gateway in background ...");
    startGatewayDetached(cwd);

    await waitForGatewayHealth({
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      timeoutMs: 20_000,
    });
    console.log("[alimbo-setup] Gateway is healthy");

    const verification = await verifyInterceptDecisionApi({
      cloudBaseUrl,
      authToken: token,
      workDir: cwd,
    });

    await reportSetupInterceptVerificationEvent({
      cloudBaseUrl,
      authToken: token,
      workDir: cwd,
      verification,
    });

    console.log("[alimbo-setup] Success");
    console.log(JSON.stringify({
      ok: true,
      userId: pairingPayload.userId,
      username: pairingPayload.username,
      pairingCode,
      cloudBaseUrl,
    }, null, 2));
  } catch (error) {
    console.error(`[alimbo-setup] Failed: ${String((error as any)?.message ?? error)}`);
    console.error("[alimbo-setup] Please request a new pairing code on mobile/wearable and run `alimbo setup` again.");
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
