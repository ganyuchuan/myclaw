import dotenv from "dotenv";

dotenv.config();

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toBool = (value, fallback = false) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
};

export const config = {
  port: toInt(process.env.PORT, 18789),
  gatewayToken: process.env.GATEWAY_TOKEN?.trim() || "dev-token",
  llm: {
    provider: process.env.LLM_PROVIDER?.trim().toLowerCase() || "openai",
    protocol: process.env.LLM_PROTOCOL?.trim().toLowerCase() || "responses",
    endpoint: process.env.LLM_ENDPOINT?.trim() || "https://api.openai.com/v1/responses",
    model: process.env.LLM_MODEL?.trim() || "gpt-4.1-mini",
    apiKey: process.env.LLM_API_KEY?.trim() || "",
    stream: process.env.LLM_STREAM?.trim() || "false",
  },
  copilot: {
    enabled: toBool(process.env.COPILOT_ENABLED, true),
    timeoutMs: toInt(process.env.COPILOT_TIMEOUT_MS, 120000),
    model: process.env.COPILOT_MODEL?.trim() || "",
    allowAllTools: toBool(process.env.COPILOT_ALLOW_ALL_TOOLS, true),
    workDir: process.env.COPILOT_WORK_DIR?.trim() || "",
  },
  cron: {
    enabled: toBool(process.env.CRON_ENABLED, true),
    jobsFile: process.env.CRON_JOBS_FILE?.trim() || "data/cron-jobs.json",
    jobTimeoutMs: toInt(process.env.CRON_JOB_TIMEOUT_MS, 600000),
    maxConcurrent: toInt(process.env.CRON_MAX_CONCURRENT, 1),
  },
  sync: {
    enabled: toBool(process.env.SYNC_ENABLED, false),
    serverUrl: process.env.SYNC_SERVER_URL?.trim() || "http://127.0.0.1:18790",
    timeoutMs: toInt(process.env.SYNC_TIMEOUT_MS, 5000),
    nodeId: process.env.SYNC_NODE_ID?.trim() || "myclaw-local",
  },
  feishu: {
    enabled: toBool(process.env.FEISHU_ENABLED, false),
    appId: process.env.FEISHU_APP_ID?.trim() || "",
    appSecret: process.env.FEISHU_APP_SECRET?.trim() || "",
    domain: process.env.FEISHU_DOMAIN?.trim().toLowerCase() || "feishu",
    connectionMode: process.env.FEISHU_CONNECTION_MODE?.trim().toLowerCase() || "websocket",
    requireMentionInGroup: toBool(process.env.FEISHU_REQUIRE_MENTION_IN_GROUP, true),
    logReply: toBool(process.env.FEISHU_LOG_REPLY, false),
    gatewayUrl: process.env.FEISHU_GATEWAY_URL?.trim() || "ws://127.0.0.1:18789/ws",
    gatewayToken: process.env.FEISHU_GATEWAY_TOKEN?.trim() || process.env.GATEWAY_TOKEN?.trim() || "dev-token",
    clientId: process.env.FEISHU_CLIENT_ID?.trim() || "myclaw-feishu-bridge",
    requestTimeoutMs: toInt(process.env.FEISHU_REQUEST_TIMEOUT_MS, 15000),
    imageTempDir: process.env.FEISHU_IMAGE_TEMP_DIR?.trim() || "data/feishu-images",
    imageMaxBytes: toInt(process.env.FEISHU_IMAGE_MAX_BYTES, 10 * 1024 * 1024),
  },
  maxPayloadBytes: 1024 * 1024,
};
