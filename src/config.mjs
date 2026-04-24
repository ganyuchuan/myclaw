import dotenv from "dotenv";

dotenv.config();

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toNonNegativeInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

const toList = (value, fallback = []) => {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [...fallback];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
    reuseSession: toBool(process.env.COPILOT_REUSE_SESSION, true),
    skillsFile: process.env.COPILOT_SKILLS_FILE?.trim() || "data/copilot-skills.json",
    mcpConfigFile: process.env.COPILOT_MCP_CONFIG_FILE?.trim() || "config/mcporter.json",
    hookEnabled: toBool(process.env.COPILOT_HOOK_ENABLED, true),
    blockedTools: toList(process.env.COPILOT_BLOCKED_TOOLS, []),
    restrictedDirTools: toList(process.env.COPILOT_RESTRICTED_DIR_TOOLS, []),
    allowedDirs: toList(process.env.COPILOT_ALLOWED_DIRS, []),
    askBeforeDestructive: toBool(process.env.COPILOT_ASK_BEFORE_DESTRUCTIVE, true),
    destructiveTools: toList(process.env.COPILOT_DESTRUCTIVE_TOOLS, []),
    permissionRequestMode: process.env.COPILOT_PERMISSION_REQUEST_MODE?.trim().toLowerCase() || "auto",
    interceptEnabled: toBool(process.env.COPILOT_INTERCEPT_ENABLED, false),
    interceptTools: toList(process.env.COPILOT_INTERCEPT_TOOLS, []),
    interceptServerUrl: process.env.COPILOT_INTERCEPT_SERVER_URL?.trim() || "",
    interceptAuthToken: process.env.COPILOT_INTERCEPT_AUTH_TOKEN?.trim() || "",
    interceptTimeoutMs: toInt(process.env.COPILOT_INTERCEPT_TIMEOUT_MS, 5000),
    interceptFailOpen: toBool(process.env.COPILOT_INTERCEPT_FAIL_OPEN, false),
    interceptPollIntervalMs: toInt(process.env.COPILOT_INTERCEPT_POLL_INTERVAL_MS, 1000),
    interceptMaxWaitMs: toInt(process.env.COPILOT_INTERCEPT_MAX_WAIT_MS, 30000),
  },
  git: {
    enabled: toBool(process.env.GIT_ENABLED, true),
    workDir: process.env.GIT_WORK_DIR?.trim() || "",
    timeoutMs: toInt(process.env.GIT_TIMEOUT_MS, 30000),
    allowedCommands: toList(process.env.GIT_ALLOWED_COMMANDS, [
      "status",
      "log",
      "diff",
      "add",
      "commit",
      "pull",
      "push",
      "fetch",
      "branch",
      "checkout",
      "switch",
      "restore",
      "show",
      "remote",
      "tag",
      "rev-parse",
    ]),
  },
  sql: {
    enabled: toBool(process.env.SQL_ENABLED, true),
    workDir: process.env.SQL_WORK_DIR?.trim() || "",
    dbFile: process.env.SQL_DB_FILE?.trim() || "data/myclaw.db",
    timeoutMs: toInt(process.env.SQL_TIMEOUT_MS, 30000),
    schemaHint: process.env.SQL_SCHEMA_HINT?.trim() || "",
  },
  service: {
    enabled: toBool(process.env.SERVICE_ENABLED, false),
    workDir: process.env.SERVICE_WORK_DIR?.trim() || "",
    timeoutMs: toInt(process.env.SERVICE_TIMEOUT_MS, 30000),
    pm2Bin: process.env.SERVICE_PM2_BIN?.trim() || "pm2",
    whitelist: toList(process.env.SERVICE_WHITELIST, ["myclaw-gateway", "myclaw-feishu"]),
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
    replyMarkdown: toBool(process.env.FEISHU_REPLY_MARKDOWN, true),
    gatewayUrl: process.env.FEISHU_GATEWAY_URL?.trim() || "ws://127.0.0.1:18789/ws",
    gatewayToken: process.env.FEISHU_GATEWAY_TOKEN?.trim() || process.env.GATEWAY_TOKEN?.trim() || "dev-token",
    clientId: process.env.FEISHU_CLIENT_ID?.trim() || "myclaw-feishu-bridge",
    requestTimeoutMs: toInt(process.env.FEISHU_REQUEST_TIMEOUT_MS, 15000),
    imageTempDir: process.env.FEISHU_IMAGE_TEMP_DIR?.trim() || "data/feishu-images",
    imageMaxBytes: toInt(process.env.FEISHU_IMAGE_MAX_BYTES, 10 * 1024 * 1024),
    fileTempDir: process.env.FEISHU_FILE_TEMP_DIR?.trim() || "data/feishu-files",
    fileMaxBytes: toInt(process.env.FEISHU_FILE_MAX_BYTES, 20 * 1024 * 1024),
    fileMaxTextChars: toInt(process.env.FEISHU_FILE_MAX_TEXT_CHARS, 20000),
    copilotStreamEnabled: toBool(process.env.FEISHU_COPILOT_STREAM_ENABLED, true),
    copilotStreamFlushIntervalMs: toInt(process.env.FEISHU_COPILOT_STREAM_FLUSH_INTERVAL_MS, 800),
    copilotStreamMinChunkChars: toInt(process.env.FEISHU_COPILOT_STREAM_MIN_CHUNK_CHARS, 120),
    routeTotalShards: toInt(process.env.FEISHU_ROUTE_TOTAL_SHARDS, 1),
    routeShardIndex: toNonNegativeInt(process.env.FEISHU_ROUTE_SHARD_INDEX, 0),
    routeSalt: process.env.FEISHU_ROUTE_SALT?.trim() || "myclaw-feishu-route",
  },
  maxPayloadBytes: 1024 * 1024,
};
