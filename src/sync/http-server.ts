import crypto from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

dotenv.config();

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toBool(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function toList(value, fallback = []) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [...fallback];
  }
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeDecision(value, fallback = "deny") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["allow", "deny", "wait", "approved", "denied", "expired", "timeout", "waiting"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function dayKey(ts = Date.now()) {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const port = toInt(process.env.SYNC_PORT, 18790);
const dbFile = process.env.SYNC_DB_FILE?.trim() || "data/sync.db";
const interceptDefaultDecision = normalizeDecision(process.env.SYNC_INTERCEPT_DEFAULT_DECISION, "allow");
const interceptManualQueueEnabled = toBool(process.env.SYNC_INTERCEPT_MANUAL_QUEUE_ENABLED, false);
const interceptManualQueueTools = new Set(toList(process.env.SYNC_INTERCEPT_MANUAL_QUEUE_TOOLS, []));
const interceptAutoAllowTools = new Set(toList(process.env.SYNC_INTERCEPT_AUTO_ALLOW_TOOLS, []));
const interceptAutoDenyTools = new Set(toList(process.env.SYNC_INTERCEPT_AUTO_DENY_TOOLS, []));
const interceptWaitTimeoutMs = toInt(process.env.SYNC_INTERCEPT_WAIT_TIMEOUT_MS, 60000);
const interceptPollAfterMs = toInt(process.env.SYNC_INTERCEPT_POLL_AFTER_MS, 1000);
const maxStateEntries = 50;
const maxToolCalls = 100;

function setToArray(setLike) {
  return Array.isArray(setLike) ? setLike : [...setLike];
}

function buildInterceptPolicySnapshot() {
  return {
    effective: {
      defaultDecision: interceptDefaultDecision,
      manualQueueEnabled: interceptManualQueueEnabled,
      manualQueueTools: setToArray(interceptManualQueueTools),
      autoAllowTools: setToArray(interceptAutoAllowTools),
      autoDenyTools: setToArray(interceptAutoDenyTools),
      waitTimeoutMs: interceptWaitTimeoutMs,
      pollAfterMs: interceptPollAfterMs,
    },
    envRaw: {
      SYNC_INTERCEPT_DEFAULT_DECISION: process.env.SYNC_INTERCEPT_DEFAULT_DECISION ?? "",
      SYNC_INTERCEPT_MANUAL_QUEUE_ENABLED: process.env.SYNC_INTERCEPT_MANUAL_QUEUE_ENABLED ?? "",
      SYNC_INTERCEPT_MANUAL_QUEUE_TOOLS: process.env.SYNC_INTERCEPT_MANUAL_QUEUE_TOOLS ?? "",
      SYNC_INTERCEPT_AUTO_ALLOW_TOOLS: process.env.SYNC_INTERCEPT_AUTO_ALLOW_TOOLS ?? "",
      SYNC_INTERCEPT_AUTO_DENY_TOOLS: process.env.SYNC_INTERCEPT_AUTO_DENY_TOOLS ?? "",
      SYNC_INTERCEPT_WAIT_TIMEOUT_MS: process.env.SYNC_INTERCEPT_WAIT_TIMEOUT_MS ?? "",
      SYNC_INTERCEPT_POLL_AFTER_MS: process.env.SYNC_INTERCEPT_POLL_AFTER_MS ?? "",
    },
  };
}

function getLanIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const ips = new Set();

  for (const records of Object.values(interfaces)) {
    for (const item of records ?? []) {
      if (!item) {
        continue;
      }
      const family = String(item.family);
      if (family !== "IPv4" || item.internal) {
        continue;
      }
      if (item.address) {
        ips.add(item.address);
      }
    }
  }

  return [...ips];
}

function makeDefaultInterceptState() {
  return {
    total: 0,
    running: 0,
    waiting: 0,
    completed: false,
    tokens: 0,
    tokens_today: 0,
    msg: "",
    entries: [],
    prompt: null,
    last_token_estimate: null,
    tokens_day: dayKey(),
    last_completed_at_ms: 0,
  };
}

function parseJsonText(raw, fallback) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return fallback;
  }

  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback = "null") {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return fallback;
  }
}

function ensureInterceptState(raw) {
  const fallback = makeDefaultInterceptState();
  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  return {
    total: Number.isFinite(raw.total) ? raw.total : fallback.total,
    running: Number.isFinite(raw.running) ? raw.running : fallback.running,
    waiting: Number.isFinite(raw.waiting) ? raw.waiting : fallback.waiting,
    completed: Boolean(raw.completed),
    tokens: Number.isFinite(raw.tokens) ? raw.tokens : fallback.tokens,
    tokens_today: Number.isFinite(raw.tokens_today) ? raw.tokens_today : fallback.tokens_today,
    msg: String(raw.msg ?? fallback.msg),
    entries: Array.isArray(raw.entries) ? raw.entries.slice(-50).map((item) => String(item ?? "")).filter(Boolean) : [],
    prompt: raw.prompt && typeof raw.prompt === "object"
      ? {
          id: String(raw.prompt.id ?? "").trim(),
          tool: String(raw.prompt.tool ?? "").trim(),
          hint: String(raw.prompt.hint ?? "").trim(),
        }
      : null,
    last_token_estimate: raw.last_token_estimate && typeof raw.last_token_estimate === "object"
      ? {
          sessionId: String(raw.last_token_estimate.sessionId ?? "").trim(),
          promptTokens: Number.isFinite(raw.last_token_estimate.promptTokens) ? raw.last_token_estimate.promptTokens : 0,
          outputTokens: Number.isFinite(raw.last_token_estimate.outputTokens) ? raw.last_token_estimate.outputTokens : 0,
          totalTokens: Number.isFinite(raw.last_token_estimate.totalTokens) ? raw.last_token_estimate.totalTokens : 0,
          promptPreview: String(raw.last_token_estimate.promptPreview ?? ""),
          outputPreview: String(raw.last_token_estimate.outputPreview ?? ""),
          estimatedAtMs: Number.isFinite(raw.last_token_estimate.estimatedAtMs)
            ? raw.last_token_estimate.estimatedAtMs
            : 0,
        }
      : null,
    tokens_day: String(raw.tokens_day ?? fallback.tokens_day),
    last_completed_at_ms: Number.isFinite(raw.last_completed_at_ms)
      ? raw.last_completed_at_ms
      : fallback.last_completed_at_ms,
  };
}

type InterceptPretoolRequest = {
  id?: string;
  tool?: string;
  hint?: string;
  msg?: string;
  input?: Record<string, unknown> | null;
  sessionId?: string;
  workDir?: string;
};

type InterceptPretoolBody = {
  request?: InterceptPretoolRequest;
};

type InterceptDecisionBody = {
  id?: string;
  decision?: string;
  reason?: string;
  decidedBy?: string;
  operator?: string;
};

type InterceptEventPayload = {
  msg?: string;
  entry?: string;
  prompt?: {
    id?: string;
    tool?: string;
    hint?: string;
  };
  entries?: string[];
  state?: {
    total?: number | string;
    running?: number | string;
    waiting?: number | string;
    completed?: boolean;
  };
  toolCall?: Record<string, unknown>;
  tokens?: number | string;
  tokenEstimate?: {
    sessionId?: string;
    promptTokens?: number | string;
    outputTokens?: number | string;
    totalTokens?: number | string;
    promptPreview?: string;
    outputPreview?: string;
    estimatedAtMs?: number | string;
  };
  completed?: boolean;
};

type InterceptEventBody = {
  event?: InterceptEventPayload;
};

type Principal = {
  userId: string;
  authToken: string;
  userName: string;
  source: "user";
};

type AuthTokenBody = {
  userName?: string;
};

function generateIssuedAuthToken() {
  // 128-bit random token encoded as hex.
  return crypto.randomBytes(16).toString("hex");
}

function generateUserId() {
  return `user_${crypto.randomUUID()}`;
}

function normalizeRequestRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    id: String(raw.id ?? "").trim(),
    tool: String(raw.tool ?? "").trim(),
    hint: String(raw.hint ?? "").trim(),
    msg: String(raw.msg ?? "").trim(),
    input: raw.input && typeof raw.input === "object" ? raw.input : null,
    sessionId: String(raw.sessionId ?? "").trim(),
    workDir: String(raw.workDir ?? "").trim(),
    status: String(raw.status ?? "waiting").trim(),
    decision: normalizeDecision(raw.decision, "wait"),
    reason: String(raw.reason ?? "").trim(),
    createdAtMs: Number.isFinite(raw.createdAtMs) ? raw.createdAtMs : 0,
    updatedAtMs: Number.isFinite(raw.updatedAtMs) ? raw.updatedAtMs : 0,
    expiresAtMs: Number.isFinite(raw.expiresAtMs) ? raw.expiresAtMs : 0,
    decidedBy: String(raw.decidedBy ?? "").trim(),
    decidedAtMs: Number.isFinite(raw.decidedAtMs) ? raw.decidedAtMs : 0,
  };
}

function normalizeToolCallRecord(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    id: String(raw.id ?? "").trim(),
    userId: String(raw.userId ?? "").trim(),
    sessionId: String(raw.sessionId ?? "").trim(),
    tool: String(raw.tool ?? "").trim(),
    args: raw.args && typeof raw.args === "object" ? raw.args : null,
    result: raw.result && typeof raw.result === "object" ? raw.result : raw.result ?? null,
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    workDir: String(raw.workDir ?? "").trim(),
  };
}

function loadStateFromDb(database, userId) {
  const row = database.prepare(`
    SELECT
      total,
      running,
      waiting,
      completed,
      tokens,
      tokens_today,
      msg,
      entries_json,
      prompt_json,
      last_token_estimate_json,
      tokens_day,
      last_completed_at_ms
    FROM intercept_state
    WHERE user_id = ?
  `).get(userId);

  if (!row) {
    return makeDefaultInterceptState();
  }

  return ensureInterceptState({
    total: row.total,
    running: row.running,
    waiting: row.waiting,
    completed: Boolean(row.completed),
    tokens: row.tokens,
    tokens_today: row.tokens_today,
    msg: row.msg,
    entries: parseJsonText(row.entries_json, []),
    prompt: parseJsonText(row.prompt_json, null),
    last_token_estimate: parseJsonText(row.last_token_estimate_json, null),
    tokens_day: row.tokens_day,
    last_completed_at_ms: row.last_completed_at_ms,
  });
}

function saveStateToDb(database, userId, state) {
  const normalized = ensureInterceptState(state);
  database.prepare(`
    INSERT INTO intercept_state (
      user_id,
      total,
      running,
      waiting,
      completed,
      tokens,
      tokens_today,
      msg,
      entries_json,
      prompt_json,
      last_token_estimate_json,
      tokens_day,
      last_completed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      total = excluded.total,
      running = excluded.running,
      waiting = excluded.waiting,
      completed = excluded.completed,
      tokens = excluded.tokens,
      tokens_today = excluded.tokens_today,
      msg = excluded.msg,
      entries_json = excluded.entries_json,
      prompt_json = excluded.prompt_json,
      last_token_estimate_json = excluded.last_token_estimate_json,
      tokens_day = excluded.tokens_day,
      last_completed_at_ms = excluded.last_completed_at_ms
  `).run(
    userId,
    normalized.total,
    normalized.running,
    normalized.waiting,
    normalized.completed ? 1 : 0,
    normalized.tokens,
    normalized.tokens_today,
    normalized.msg,
    stringifyJson(normalized.entries, "[]"),
    stringifyJson(normalized.prompt, "null"),
    stringifyJson(normalized.last_token_estimate, "null"),
    normalized.tokens_day,
    normalized.last_completed_at_ms,
  );
}

function getRequestById(database, userId, id) {
  const row = database.prepare(`
    SELECT
      id,
      tool,
      hint,
      msg,
      input_json,
      session_id,
      work_dir,
      status,
      decision,
      reason,
      created_at_ms,
      updated_at_ms,
      expires_at_ms,
      decided_by,
      decided_at_ms
    FROM intercept_requests
    WHERE user_id = ? AND id = ?
  `).get(userId, id);

  if (!row) {
    return null;
  }

  return normalizeRequestRecord({
    id: row.id,
    tool: row.tool,
    hint: row.hint,
    msg: row.msg,
    input: parseJsonText(row.input_json, null),
    sessionId: row.session_id,
    workDir: row.work_dir,
    status: row.status,
    decision: row.decision,
    reason: row.reason,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    expiresAtMs: row.expires_at_ms,
    decidedBy: row.decided_by,
    decidedAtMs: row.decided_at_ms,
  });
}

function listRequestsFromDb(database, userId, { status = "", limit = 100 } = {}) {
  const normalizedLimit = Math.max(1, toInt(limit, 100));
  const rows = status
    ? database.prepare(`
        SELECT
          id,
          tool,
          hint,
          msg,
          input_json,
          session_id,
          work_dir,
          status,
          decision,
          reason,
          created_at_ms,
          updated_at_ms,
          expires_at_ms,
          decided_by,
          decided_at_ms
        FROM intercept_requests
        WHERE user_id = ? AND status = ?
        ORDER BY created_at_ms DESC
        LIMIT ?
      `).all(userId, status, normalizedLimit)
    : database.prepare(`
        SELECT
          id,
          tool,
          hint,
          msg,
          input_json,
          session_id,
          work_dir,
          status,
          decision,
          reason,
          created_at_ms,
          updated_at_ms,
          expires_at_ms,
          decided_by,
          decided_at_ms
        FROM intercept_requests
        WHERE user_id = ?
        ORDER BY created_at_ms DESC
        LIMIT ?
      `).all(userId, normalizedLimit);

  return rows.map((row) => normalizeRequestRecord({
    id: row.id,
    tool: row.tool,
    hint: row.hint,
    msg: row.msg,
    input: parseJsonText(row.input_json, null),
    sessionId: row.session_id,
    workDir: row.work_dir,
    status: row.status,
    decision: row.decision,
    reason: row.reason,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    expiresAtMs: row.expires_at_ms,
    decidedBy: row.decided_by,
    decidedAtMs: row.decided_at_ms,
  }));
}

function saveRequestToDb(database, userId, request) {
  const normalized = normalizeRequestRecord(request);
  if (!normalized?.id) {
    return;
  }

  database.prepare(`
    INSERT INTO intercept_requests (
      id,
      user_id,
      tool,
      hint,
      msg,
      input_json,
      session_id,
      work_dir,
      status,
      decision,
      reason,
      created_at_ms,
      updated_at_ms,
      expires_at_ms,
      decided_by,
      decided_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tool = excluded.tool,
      user_id = excluded.user_id,
      hint = excluded.hint,
      msg = excluded.msg,
      input_json = excluded.input_json,
      session_id = excluded.session_id,
      work_dir = excluded.work_dir,
      status = excluded.status,
      decision = excluded.decision,
      reason = excluded.reason,
      created_at_ms = excluded.created_at_ms,
      updated_at_ms = excluded.updated_at_ms,
      expires_at_ms = excluded.expires_at_ms,
      decided_by = excluded.decided_by,
      decided_at_ms = excluded.decided_at_ms
  `).run(
    normalized.id,
    userId,
    normalized.tool,
    normalized.hint,
    normalized.msg,
    stringifyJson(normalized.input, "null"),
    normalized.sessionId,
    normalized.workDir,
    normalized.status,
    normalized.decision,
    normalized.reason,
    normalized.createdAtMs,
    normalized.updatedAtMs,
    normalized.expiresAtMs,
    normalized.decidedBy,
    normalized.decidedAtMs,
  );
}

function listToolCallsFromDb(database, userId, limit = maxToolCalls) {
  const normalizedLimit = Math.max(1, Math.min(toInt(limit, maxToolCalls), 500));
  const rows = database.prepare(`
    SELECT id, user_id, session_id, tool, args_json, result_json, ts, work_dir
    FROM intercept_tool_calls
    WHERE user_id = ?
    ORDER BY ts DESC, id DESC
    LIMIT ?
  `).all(userId, normalizedLimit);

  return rows
    .map((row) => normalizeToolCallRecord({
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      tool: row.tool,
      args: parseJsonText(row.args_json, null),
      result: parseJsonText(row.result_json, null),
      ts: row.ts,
      workDir: row.work_dir,
    }))
    .filter(Boolean);
}

function countToolCallsFromDb(database, userId) {
  const row = database.prepare("SELECT COUNT(*) AS total FROM intercept_tool_calls WHERE user_id = ?").get(userId);
  return Number.isFinite(row?.total) ? row.total : 0;
}

function insertToolCallToDb(database, userId, toolCall) {
  const normalized = normalizeToolCallRecord(toolCall);
  if (!normalized?.id) {
    return;
  }

  database.prepare(`
    INSERT INTO intercept_tool_calls (id, user_id, session_id, tool, args_json, result_json, ts, work_dir)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      session_id = excluded.session_id,
      tool = excluded.tool,
      args_json = excluded.args_json,
      result_json = excluded.result_json,
      ts = excluded.ts,
      work_dir = excluded.work_dir
  `).run(
    normalized.id,
    userId,
    normalized.sessionId,
    normalized.tool,
    stringifyJson(normalized.args, "null"),
    stringifyJson(normalized.result, "null"),
    normalized.ts,
    normalized.workDir,
  );

  database.prepare(`
    DELETE FROM intercept_tool_calls
    WHERE user_id = ? AND id NOT IN (
      SELECT id
      FROM intercept_tool_calls
      WHERE user_id = ?
      ORDER BY ts DESC, id DESC
      LIMIT ?
    )
  `).run(userId, userId, maxToolCalls);
}

function countRequestsFromDb(database, userId) {
  const row = database.prepare("SELECT COUNT(*) AS total FROM intercept_requests WHERE user_id = ?").get(userId);
  return Number.isFinite(row?.total) ? row.total : 0;
}

function countAllRequestsFromDb(database) {
  const row = database.prepare("SELECT COUNT(*) AS total FROM intercept_requests").get();
  return Number.isFinite(row?.total) ? row.total : 0;
}

function tryExecMigration(database, sql) {
  try {
    database.exec(sql);
  } catch (error) {
    const message = String(error?.message ?? error).toLowerCase();
    if (!message.includes("duplicate column name") && !message.includes("already exists")) {
      throw error;
    }
  }
}

function createUserTokenRecord(database, { userName, now = Date.now() }) {
  const normalizedUserName = String(userName ?? "").trim();

  for (let i = 0; i < 6; i += 1) {
    const userId = generateUserId();
    const authToken = generateIssuedAuthToken();
    try {
      database.prepare(`
        INSERT INTO users (user_id, user_name, auth_token, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, normalizedUserName, authToken, now, now);

      return {
        userId,
        authToken,
        userName: normalizedUserName,
      };
    } catch (error) {
      const message = String(error?.message ?? error).toLowerCase();
      if (!message.includes("constraint")) {
        throw error;
      }
    }
  }

  throw new Error("failed to issue auth token");
}

function getUserByAuthToken(database, authToken) {
  const row = database.prepare(`
    SELECT user_id, user_name, auth_token
    FROM users
    WHERE auth_token = ?
    LIMIT 1
  `).get(authToken);

  if (!row) {
    return null;
  }

  return {
    userId: String(row.user_id ?? "").trim(),
    userName: String(row.user_name ?? "").trim(),
    authToken: String(row.auth_token ?? "").trim(),
    source: "user",
  };
}

function listUsersFromDb(database, limit = 100) {
  const normalizedLimit = Math.max(1, Math.min(toInt(limit, 100), 500));
  const rows = database.prepare(`
    SELECT user_id, user_name, auth_token, created_at_ms, updated_at_ms
    FROM users
    ORDER BY updated_at_ms DESC, created_at_ms DESC
    LIMIT ?
  `).all(normalizedLimit);

  return rows.map((row) => ({
    userId: String(row.user_id ?? "").trim(),
    userName: String(row.user_name ?? "").trim(),
    authToken: String(row.auth_token ?? "").trim(),
    createdAtMs: Number.isFinite(row.created_at_ms) ? row.created_at_ms : 0,
    updatedAtMs: Number.isFinite(row.updated_at_ms) ? row.updated_at_ms : 0,
  }));
}

function migrateInterceptStateTableIfNeeded(database) {
  const columns = database.prepare("PRAGMA table_info(intercept_state)").all();
  const hasUserIdPk = columns.some((column) => column?.name === "user_id" && Number(column?.pk) === 1);
  if (hasUserIdPk) {
    return;
  }

  const hasIdPk = columns.some((column) => column?.name === "id" && Number(column?.pk) === 1);
  if (!hasIdPk) {
    return;
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS intercept_state_v2 (
      user_id TEXT PRIMARY KEY,
      total INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0,
      waiting INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      tokens_today INTEGER NOT NULL DEFAULT 0,
      msg TEXT NOT NULL DEFAULT '',
      entries_json TEXT NOT NULL DEFAULT '[]',
      prompt_json TEXT,
      last_token_estimate_json TEXT,
      tokens_day TEXT NOT NULL,
      last_completed_at_ms INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO intercept_state_v2 (
      user_id,
      total,
      running,
      waiting,
      completed,
      tokens,
      tokens_today,
      msg,
      entries_json,
      prompt_json,
      last_token_estimate_json,
      tokens_day,
      last_completed_at_ms
    )
    SELECT
      '' AS user_id,
      total,
      running,
      waiting,
      completed,
      tokens,
      tokens_today,
      msg,
      entries_json,
      prompt_json,
      last_token_estimate_json,
      tokens_day,
      last_completed_at_ms
    FROM intercept_state;

    DROP TABLE intercept_state;
    ALTER TABLE intercept_state_v2 RENAME TO intercept_state;
  `);
}

function openDatabase() {
  const dir = path.dirname(dbFile);
  fs.mkdirSync(dir, { recursive: true });
  const database = new DatabaseSync(dbFile);

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT '',
      auth_token TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_users_auth_token
      ON users(auth_token);

    CREATE TABLE IF NOT EXISTS intercept_state (
      user_id TEXT PRIMARY KEY,
      total INTEGER NOT NULL DEFAULT 0,
      running INTEGER NOT NULL DEFAULT 0,
      waiting INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      tokens_today INTEGER NOT NULL DEFAULT 0,
      msg TEXT NOT NULL DEFAULT '',
      entries_json TEXT NOT NULL DEFAULT '[]',
      prompt_json TEXT,
      last_token_estimate_json TEXT,
      tokens_day TEXT NOT NULL,
      last_completed_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS intercept_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT '',
      msg TEXT NOT NULL DEFAULT '',
      input_json TEXT,
      session_id TEXT NOT NULL DEFAULT '',
      work_dir TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      expires_at_ms INTEGER NOT NULL DEFAULT 0,
      decided_by TEXT NOT NULL DEFAULT '',
      decided_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_intercept_requests_status_created_at
      ON intercept_requests(status, created_at_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_intercept_requests_user_status_created_at
      ON intercept_requests(user_id, status, created_at_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_intercept_requests_user_created_at
      ON intercept_requests(user_id, created_at_ms DESC);

    CREATE TABLE IF NOT EXISTS intercept_tool_calls (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL DEFAULT '',
      args_json TEXT,
      result_json TEXT,
      ts INTEGER NOT NULL DEFAULT 0,
      work_dir TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_intercept_tool_calls_ts
      ON intercept_tool_calls(ts DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_intercept_tool_calls_user_ts
      ON intercept_tool_calls(user_id, ts DESC, id DESC);
  `);

  migrateInterceptStateTableIfNeeded(database);

  tryExecMigration(database, "ALTER TABLE intercept_state ADD COLUMN user_id TEXT NOT NULL DEFAULT ''; ");
  tryExecMigration(database, "ALTER TABLE intercept_requests ADD COLUMN user_id TEXT NOT NULL DEFAULT ''; ");
  tryExecMigration(database, "ALTER TABLE intercept_tool_calls ADD COLUMN user_id TEXT NOT NULL DEFAULT ''; ");

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_intercept_requests_user_status_created_at
      ON intercept_requests(user_id, status, created_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_intercept_requests_user_created_at
      ON intercept_requests(user_id, created_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_intercept_tool_calls_user_ts
      ON intercept_tool_calls(user_id, ts DESC, id DESC);
  `);

  return database;
}

const storeDb = openDatabase();

function withTransaction(action) {
  storeDb.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    storeDb.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      storeDb.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures after the primary error.
    }
    throw error;
  }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

const interceptApprovalPagePath = new URL("./intercept-approval.html", import.meta.url);
let interceptApprovalPageCache = "";

function renderInterceptApprovalPage() {
  if (interceptApprovalPageCache) {
    return interceptApprovalPageCache;
  }

  try {
    interceptApprovalPageCache = fs.readFileSync(interceptApprovalPagePath, "utf8");
  } catch (error) {
    console.warn(`[sync-server][intercept] failed to load approval page: ${String(error?.message ?? error)}`);
    interceptApprovalPageCache = "<!doctype html><html><body><h1>Approval page unavailable</h1></body></html>";
  }

  return interceptApprovalPageCache;
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function parseBody<T extends Record<string, unknown> = Record<string, unknown>>(req): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function appendEntry(state, text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return;
  }

  state.entries.push(normalized);
  if (state.entries.length > maxStateEntries) {
    state.entries = state.entries.slice(-maxStateEntries);
  }
}

function replaceEntries(state, entries) {
  if (!Array.isArray(entries)) {
    return;
  }

  state.entries = entries
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(-maxStateEntries);
}

function decisionForStatus(status) {
  const normalized = normalizeDecision(status, "waiting");
  if (["allow", "approved"].includes(normalized)) {
    return "allow";
  }
  if (["deny", "denied", "expired", "timeout"].includes(normalized)) {
    return "deny";
  }
  return "wait";
}

function refreshTodayTokens(state) {
  const today = dayKey();
  if (state.tokens_day !== today) {
    state.tokens_day = today;
    state.tokens_today = 0;
  }
}

function updateStateCounters(state) {
  state.total = Number.isFinite(state.total) ? Math.max(0, state.total) : 0;
  state.waiting = Number.isFinite(state.waiting) ? Math.max(0, state.waiting) : 0;
  state.running = Number.isFinite(state.running) ? Math.max(0, state.running) : 0;
}

function maybeExpireRequest(state, request) {
  if (!request || request.status !== "waiting") {
    return request;
  }

  const now = Date.now();
  if (Number.isFinite(request.expiresAtMs) && request.expiresAtMs > 0 && now >= request.expiresAtMs) {
    request.status = "expired";
    request.decision = "deny";
    request.reason = request.reason || "manual decision timeout";
    request.updatedAtMs = now;
    console.warn(
      `[sync-server][intercept] queue timeout id=${request.id} tool=${request.tool} waitedMs=${Math.max(0, now - Number(request.createdAtMs ?? now))}`,
    );
    state.msg = `Request ${request.id} timed out`;
    appendEntry(state, `Timeout: ${request.tool} (${request.id})`);
    updateStateCounters(state);
  }

  return request;
}

function toQueueItem(item) {
  return {
    id: item.id,
    status: item.status,
    decision: item.decision,
    tool: item.tool,
    hint: item.hint,
    msg: item.msg,
    createdAtMs: item.createdAtMs,
    updatedAtMs: item.updatedAtMs,
    expiresAtMs: item.expiresAtMs,
    decidedBy: item.decidedBy || null,
    reason: item.reason || "",
  };
}

function resolvePretoolDecision(tool) {
  const normalizedTool = String(tool ?? "").trim().toLowerCase();

  if (interceptAutoDenyTools.has(normalizedTool)) {
    return "deny";
  }

  if (interceptAutoAllowTools.has(normalizedTool)) {
    return "allow";
  }

  const inManualScope = interceptManualQueueTools.size === 0 || interceptManualQueueTools.has(normalizedTool);
  if (interceptManualQueueEnabled && inManualScope) {
    return "wait";
  }

  return interceptDefaultDecision;
}

function requireInterceptAuth(req, res) {
  const authorization = String(req.headers.authorization ?? "").trim();
  const tokenFromAuth = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";
  const provided = tokenFromAuth;

  if (provided) {
    const userPrincipal = getUserByAuthToken(storeDb, provided);
    if (userPrincipal?.userId) {
      return {
        userId: userPrincipal.userId,
        authToken: provided,
        userName: userPrincipal.userName,
        source: "user",
      };
    }
  }

  if (!provided) {
    console.warn(
      `[sync-server][intercept] unauthorized ${String(req.method ?? "") || "-"} ${String(req.url ?? "") || "-"}`,
    );
    json(res, 401, { error: "unauthorized" });
    return null;
  }

  console.warn(
    `[sync-server][intercept] invalid token ${String(req.method ?? "") || "-"} ${String(req.url ?? "") || "-"}`,
  );
  json(res, 401, { error: "unauthorized" });
  return null;
}

function toPublicInterceptState(state) {
  return {
    total: state.total,
    running: state.running,
    waiting: state.waiting,
    completed: state.completed,
    tokens: state.tokens,
    tokens_today: state.tokens_today,
    msg: state.msg,
    entries: state.entries,
    prompt: state.prompt,
    last_token_estimate: state.last_token_estimate,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/intercepts/approve") {
      return html(res, 200, renderInterceptApprovalPage());
    }

    if (req.method === "GET" && pathname === "/health") {
      return json(res, 200, {
        ok: true,
        service: "myclaw-sync-server",
        intercepts: countAllRequestsFromDb(storeDb),
      });
    }

    if (req.method === "POST" && pathname === "/auth/token") {
      const body = await parseBody<AuthTokenBody>(req);
      const userName = String(body?.userName ?? "").trim();
      if (!userName) {
        return json(res, 400, { error: "userName is required" });
      }

      const issued = withTransaction(() => createUserTokenRecord(storeDb, { userName }));
      return json(res, 200, {
        ok: true,
        userId: issued.userId,
        authToken: issued.authToken,
        userName: issued.userName,
      });
    }

    if (req.method === "GET" && pathname === "/auth/users") {
      const limit = toInt(url.searchParams.get("limit"), 100);
      const users = listUsersFromDb(storeDb, limit);
      return json(res, 200, {
        ok: true,
        items: users,
      });
    }

    if (pathname.startsWith("/api/copilot/intercepts/")) {
      const principal = requireInterceptAuth(req, res);
      if (!principal) {
        return;
      }

      const principalUserId = principal.userId;

      if (req.method === "GET" && pathname === "/api/copilot/intercepts/state") {
        const state = withTransaction(() => {
          const nextState = loadStateFromDb(storeDb, principalUserId);
          refreshTodayTokens(nextState);
          updateStateCounters(nextState);
          saveStateToDb(storeDb, principalUserId, nextState);
          return nextState;
        });

        return json(res, 200, {
          state: toPublicInterceptState(state),
        });
      }

      if (req.method === "GET" && pathname === "/api/copilot/intercepts/queue") {
        const statusFilter = String(url.searchParams.get("status") ?? "").trim().toLowerCase();
        const limit = toInt(url.searchParams.get("limit"), 100);
        const items = withTransaction(() => {
          const state = loadStateFromDb(storeDb, principalUserId);
          const waitingItems = listRequestsFromDb(storeDb, principalUserId, { status: "waiting", limit: 1000000 });

          for (const item of waitingItems) {
            const previousStatus = item.status;
            const previousUpdatedAtMs = item.updatedAtMs;
            maybeExpireRequest(state, item);
            if (item.status !== previousStatus || item.updatedAtMs !== previousUpdatedAtMs) {
              saveRequestToDb(storeDb, principalUserId, item);
            }
          }

          updateStateCounters(state);
          saveStateToDb(storeDb, principalUserId, state);

          return listRequestsFromDb(storeDb, principalUserId, {
            status: statusFilter,
            limit,
          }).map(toQueueItem);
        });

        return json(res, 200, { items });
      }

      if (req.method === "GET" && pathname === "/api/copilot/intercepts/tool-calls") {
        const requested = toInt(url.searchParams.get("limit"), 100);
        const limit = Math.min(requested, 500);
        const items = listToolCallsFromDb(storeDb, principalUserId, limit).map((item) => ({
          id: item.id,
          sessionId: item.sessionId,
          tool: item.tool,
          args: item.args ?? null,
          result: item.result ?? null,
          ts: item.ts,
          workDir: item.workDir,
        }));

        return json(res, 200, {
          items,
          total: countToolCallsFromDb(storeDb, principalUserId),
          limit,
        });
      }

      if (req.method === "POST" && pathname === "/api/copilot/intercepts/pretool") {
        const body = await parseBody<InterceptPretoolBody>(req);
        const request = body?.request;
        if (!request || typeof request !== "object") {
          return json(res, 400, { error: "invalid request payload" });
        }

        const now = Date.now();
        const id = String(request.id ?? "").trim() || `perm_${crypto.randomUUID()}`;
        const tool = String(request.tool ?? "").trim().toLowerCase();
        if (!tool) {
          return json(res, 400, { error: "request.tool is required" });
        }

        console.log(`[sync-server][intercept] pretool received id=${id} tool=${tool}`);

        const result = withTransaction(() => {
          const state = loadStateFromDb(storeDb, principalUserId);
          refreshTodayTokens(state);

          let item = getRequestById(storeDb, principalUserId, id);
          if (item) {
            maybeExpireRequest(state, item);
          }

          const isNew = !item;
          if (!item) {
            item = {
              id,
              tool,
              hint: String(request.hint ?? "").trim(),
              msg: String(request.msg ?? "").trim() || "Intercepted tool call",
              input: request.input && typeof request.input === "object" ? request.input : null,
              sessionId: String(request.sessionId ?? "").trim() || "",
              workDir: String(request.workDir ?? "").trim() || "",
              status: "waiting",
              decision: "wait",
              reason: "",
              createdAtMs: now,
              updatedAtMs: now,
              expiresAtMs: now + interceptWaitTimeoutMs,
              decidedBy: "",
              decidedAtMs: 0,
            };
            appendEntry(state, `Intercepted: ${tool} (${id})`);
            console.log(`[sync-server][intercept] queued id=${id} tool=${tool} total=${state.total}`);
          }

          const preDecision = resolvePretoolDecision(tool);
          if (preDecision === "allow") {
            item.status = "approved";
            item.decision = "allow";
            item.reason = item.reason || "auto allowed by server policy";
            console.log(`[sync-server][intercept] auto allow id=${id} tool=${tool}`);
          } else if (preDecision === "deny") {
            item.status = "denied";
            item.decision = "deny";
            item.reason = item.reason || "auto denied by server policy";
            console.log(`[sync-server][intercept] auto deny id=${id} tool=${tool}`);
          } else {
            item.status = "waiting";
            item.decision = "wait";
            item.reason = item.reason || "waiting for manual decision";
            item.expiresAtMs = now + interceptWaitTimeoutMs;
            console.log(
              `[sync-server][intercept] waiting manual decision id=${id} tool=${tool} expiresInMs=${interceptWaitTimeoutMs}`,
            );
          }

          item.updatedAtMs = now;
          state.prompt = {
            id,
            tool,
            hint: item.hint,
          };
          state.msg = item.msg;

          if (!isNew) {
            appendEntry(state, `Re-intercepted: ${tool} (${id})`);
          }

          if (item.status === "approved") {
            appendEntry(state, `Auto allow: ${tool} (${id})`);
          }
          if (item.status === "denied") {
            appendEntry(state, `Auto deny: ${tool} (${id})`);
          }

          updateStateCounters(state);
          saveRequestToDb(storeDb, principalUserId, item);
          saveStateToDb(storeDb, principalUserId, state);

          return {
            item,
            state,
          };
        });

        return json(res, 200, {
          ok: true,
          id,
          decision: result.item.decision,
          status: result.item.status,
          reason: result.item.reason,
          pollAfterMs: interceptPollAfterMs,
          expiresInMs: Math.max(0, Number(result.item.expiresAtMs ?? now) - now),
          msg: result.item.msg,
          state: toPublicInterceptState(result.state),
        });
      }

      if (req.method === "GET" && pathname === "/api/copilot/intercepts/decision") {
        const id = String(url.searchParams.get("id") ?? "").trim();
        if (!id) {
          return json(res, 400, { error: "id is required" });
        }

        const item = withTransaction(() => {
          const state = loadStateFromDb(storeDb, principalUserId);
          const nextItem = getRequestById(storeDb, principalUserId, id);
          if (!nextItem) {
            return null;
          }

          const previousStatus = nextItem.status;
          const previousUpdatedAtMs = nextItem.updatedAtMs;
          maybeExpireRequest(state, nextItem);
          if (nextItem.status !== previousStatus || nextItem.updatedAtMs !== previousUpdatedAtMs) {
            saveRequestToDb(storeDb, principalUserId, nextItem);
            saveStateToDb(storeDb, principalUserId, state);
          }
          return nextItem;
        });

        if (!item) {
          return notFound(res);
        }

        return json(res, 200, {
          id: item.id,
          status: item.status,
          decision: decisionForStatus(item.status),
          reason: item.reason || "",
          hint: item.hint,
          msg: item.msg,
          expiresAtMs: item.expiresAtMs,
          decidedBy: item.decidedBy || null,
          decidedAtMs: item.decidedAtMs || 0,
        });
      }

      if (req.method === "POST" && pathname === "/api/copilot/intercepts/decision") {
        const body = await parseBody<InterceptDecisionBody>(req);
        const id = String(body?.id ?? "").trim();
        const decision = normalizeDecision(body?.decision, "deny");
        if (!id) {
          return json(res, 400, { error: "id is required" });
        }
        if (!["allow", "deny", "approved", "denied"].includes(decision)) {
          return json(res, 400, { error: "decision must be allow or deny" });
        }

        const result = withTransaction(() => {
          const state = loadStateFromDb(storeDb, principalUserId);
          const item = getRequestById(storeDb, principalUserId, id);
          if (!item) {
            return null;
          }

          maybeExpireRequest(state, item);

          const now = Date.now();
          const finalDecision = ["allow", "approved"].includes(decision) ? "allow" : "deny";
          item.status = finalDecision === "allow" ? "approved" : "denied";
          item.decision = finalDecision;
          item.reason = String(body?.reason ?? "").trim() || `manual ${finalDecision}`;
          item.decidedBy = String(body?.decidedBy ?? body?.operator ?? "").trim() || "manual";
          item.decidedAtMs = now;
          item.updatedAtMs = now;

          console.log(
            `[sync-server][intercept] manual decision id=${item.id} tool=${item.tool} decision=${finalDecision} by=${item.decidedBy}`,
          );

          state.msg = `Manual ${finalDecision}: ${item.tool}`;
          state.prompt = {
            id: item.id,
            tool: item.tool,
            hint: item.hint,
          };
          appendEntry(state, `Manual ${finalDecision}: ${item.tool} (${item.id})`);

          updateStateCounters(state);
          saveRequestToDb(storeDb, principalUserId, item);
          saveStateToDb(storeDb, principalUserId, state);

          return { item, state };
        });

        if (!result) {
          return notFound(res);
        }

        return json(res, 200, {
          ok: true,
          id: result.item.id,
          status: result.item.status,
          decision: result.item.decision,
          reason: result.item.reason,
          state: toPublicInterceptState(result.state),
        });
      }

      if (req.method === "POST" && pathname === "/api/copilot/intercepts/event") {
        const body = await parseBody<InterceptEventBody>(req);
        const event = body?.event;
        if (!event || typeof event !== "object") {
          return json(res, 400, { error: "invalid event payload" });
        }

        const state = withTransaction(() => {
          const nextState = loadStateFromDb(storeDb, principalUserId);
          refreshTodayTokens(nextState);

          const msg = String(event.msg ?? "").trim();
          if (msg) {
            nextState.msg = msg;
          }

          const entry = String(event.entry ?? "").trim();
          if (entry) {
            appendEntry(nextState, entry);
          }

          if (event.prompt && typeof event.prompt === "object") {
            nextState.prompt = {
              id: String(event.prompt.id ?? "").trim(),
              tool: String(event.prompt.tool ?? "").trim(),
              hint: String(event.prompt.hint ?? "").trim(),
            };
          }

          if (Array.isArray(event.entries)) {
            replaceEntries(nextState, event.entries);
          }

          if (event.state && typeof event.state === "object") {
            const nextTotal = Number.parseInt(String(event.state.total ?? ""), 10);
            if (Number.isFinite(nextTotal) && nextTotal >= 0) {
              nextState.total = nextTotal;
            }

            const nextRunning = Number.parseInt(String(event.state.running ?? ""), 10);
            if (Number.isFinite(nextRunning) && nextRunning >= 0) {
              nextState.running = nextRunning;
            }

            const nextWaiting = Number.parseInt(String(event.state.waiting ?? ""), 10);
            if (Number.isFinite(nextWaiting) && nextWaiting >= 0) {
              nextState.waiting = nextWaiting;
            }

            if (typeof event.state.completed === "boolean") {
              nextState.completed = event.state.completed;
            }
          }

          if (event.toolCall && typeof event.toolCall === "object") {
            insertToolCallToDb(storeDb, principalUserId, event.toolCall);
          }

          const tokens = Number.parseInt(String(event.tokens ?? "0"), 10);
          if (Number.isFinite(tokens) && tokens > 0) {
            nextState.tokens += tokens;
            nextState.tokens_today += tokens;
          }

          if (event.tokenEstimate && typeof event.tokenEstimate === "object") {
            nextState.last_token_estimate = {
              sessionId: String(event.tokenEstimate.sessionId ?? "").trim(),
              promptTokens: Number.parseInt(String(event.tokenEstimate.promptTokens ?? "0"), 10) || 0,
              outputTokens: Number.parseInt(String(event.tokenEstimate.outputTokens ?? "0"), 10) || 0,
              totalTokens: Number.parseInt(String(event.tokenEstimate.totalTokens ?? tokens ?? "0"), 10) || 0,
              promptPreview: String(event.tokenEstimate.promptPreview ?? ""),
              outputPreview: String(event.tokenEstimate.outputPreview ?? ""),
              estimatedAtMs: Number.parseInt(String(event.tokenEstimate.estimatedAtMs ?? Date.now()), 10) || Date.now(),
            };
          }

          if (event.completed === true) {
            nextState.completed = true;
            nextState.last_completed_at_ms = Date.now();
          }

          updateStateCounters(nextState);
          saveStateToDb(storeDb, principalUserId, nextState);
          return nextState;
        });

        return json(res, 200, { ok: true, state: toPublicInterceptState(state) });
      }

      return notFound(res);
    }

    return notFound(res);
  } catch (error) {
    return json(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[sync-server] listening on http://0.0.0.0:${port}`);
  console.log(
    `[sync-server][intercept] policy snapshot ${JSON.stringify(buildInterceptPolicySnapshot())}`,
  );
  const lanIps = getLanIPv4Addresses();
  for (const ip of lanIps) {
    console.log(`[sync-server] LAN access: http://${ip}:${port}`);
  }
  console.log(`[sync-server] db file: ${dbFile}`);
});
