import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

function countTotalFromDb(database, tableName, userId = "") {
  if (userId) {
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${tableName} WHERE user_id = ?`).get(userId);
    return Number.isFinite(row?.total) ? row.total : 0;
  }

  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get();
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

function generateIssuedAuthToken() {
  // 128-bit random token encoded as hex.
  return crypto.randomBytes(16).toString("hex");
}

function generateUserId() {
  return `user_${crypto.randomUUID()}`;
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

function openDatabase(dbFile) {
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

class InterceptStore {
  dbFile;
  db;
  maxToolCalls;

  constructor() {
    this.dbFile = process.env.CLOUD_DB_FILE?.trim() || "data/cloud.db";
    this.maxToolCalls = 100;
    this.db = openDatabase(this.dbFile);
  }

  getDbFile() {
    return this.dbFile;
  }

  withTransaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures after the primary error.
      }
      throw error;
    }
  }

  loadState(userId) {
    const row = this.db.prepare(`
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

  saveState(userId, state) {
    const normalized = ensureInterceptState(state);
    this.db.prepare(`
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

  getRequestById(userId, id) {
    const row = this.db.prepare(`
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

  listRequests(userId, { status = "", limit = 100 } = {}) {
    const normalizedLimit = Math.max(1, toInt(limit, 100));
    const rows = status
      ? this.db.prepare(`
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
      : this.db.prepare(`
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

  saveRequest(userId, request) {
    const normalized = normalizeRequestRecord(request);
    if (!normalized?.id) {
      return;
    }

    this.db.prepare(`
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

  listToolCalls(userId, limit = this.maxToolCalls) {
    const normalizedLimit = Math.max(1, Math.min(toInt(limit, this.maxToolCalls), 500));
    const rows = this.db.prepare(`
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

  countToolCalls(userId) {
    return countTotalFromDb(this.db, "intercept_tool_calls", userId);
  }

  insertToolCall(userId, toolCall) {
    const normalized = normalizeToolCallRecord(toolCall);
    if (!normalized?.id) {
      return;
    }

    this.db.prepare(`
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

    this.db.prepare(`
      DELETE FROM intercept_tool_calls
      WHERE user_id = ? AND id NOT IN (
        SELECT id
        FROM intercept_tool_calls
        WHERE user_id = ?
        ORDER BY ts DESC, id DESC
        LIMIT ?
      )
    `).run(userId, userId, this.maxToolCalls);
  }

  countRequests(userId) {
    return countTotalFromDb(this.db, "intercept_requests", userId);
  }

  createUserTokenRecord({ username, now = Date.now() }) {
    const normalizedUsername = String(username ?? "").trim();

    for (let i = 0; i < 6; i += 1) {
      const userId = generateUserId();
      const authToken = generateIssuedAuthToken();
      try {
        this.db.prepare(`
          INSERT INTO users (user_id, user_name, auth_token, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?)
        `).run(userId, normalizedUsername, authToken, now, now);

        return {
          userId,
          authToken,
          username: normalizedUsername,
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

  getUserByAuthToken(authToken) {
    const row = this.db.prepare(`
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
      username: String(row.user_name ?? "").trim(),
      authToken: String(row.auth_token ?? "").trim(),
      source: "user",
    };
  }

  listUsers(limit = 100) {
    const normalizedLimit = Math.max(1, Math.min(toInt(limit, 100), 500));
    const rows = this.db.prepare(`
      SELECT user_id, user_name, auth_token, created_at_ms, updated_at_ms
      FROM users
      ORDER BY updated_at_ms DESC, created_at_ms DESC
      LIMIT ?
    `).all(normalizedLimit);

    return rows.map((row) => ({
      userId: String(row.user_id ?? "").trim(),
      username: String(row.user_name ?? "").trim(),
      authToken: String(row.auth_token ?? "").trim(),
      createdAtMs: Number.isFinite(row.created_at_ms) ? row.created_at_ms : 0,
      updatedAtMs: Number.isFinite(row.updated_at_ms) ? row.updated_at_ms : 0,
    }));
  }
}

export const interceptStore = new InterceptStore();
