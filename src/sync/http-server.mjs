import crypto from "node:crypto";
import { createServer } from "node:http";
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
const dbFile = process.env.SYNC_DB_FILE?.trim() || "data/cron-jobs-sync.json";
const interceptAuthToken = process.env.SYNC_INTERCEPT_AUTH_TOKEN?.trim() || "";
const interceptDefaultDecision = normalizeDecision(process.env.SYNC_INTERCEPT_DEFAULT_DECISION, "allow");
const interceptManualQueueEnabled = toBool(process.env.SYNC_INTERCEPT_MANUAL_QUEUE_ENABLED, false);
const interceptManualQueueTools = new Set(toList(process.env.SYNC_INTERCEPT_MANUAL_QUEUE_TOOLS, []));
const interceptAutoAllowTools = new Set(toList(process.env.SYNC_INTERCEPT_AUTO_ALLOW_TOOLS, []));
const interceptAutoDenyTools = new Set(toList(process.env.SYNC_INTERCEPT_AUTO_DENY_TOOLS, []));
const interceptWaitTimeoutMs = toInt(process.env.SYNC_INTERCEPT_WAIT_TIMEOUT_MS, 60000);
const interceptPollAfterMs = toInt(process.env.SYNC_INTERCEPT_POLL_AFTER_MS, 1000);

function maskToken(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= 6) {
    return "***";
  }
  return `${text.slice(0, 3)}***${text.slice(-2)}`;
}

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
      authTokenConfigured: Boolean(interceptAuthToken),
      authTokenMasked: maskToken(interceptAuthToken),
    },
    envRaw: {
      SYNC_INTERCEPT_DEFAULT_DECISION: process.env.SYNC_INTERCEPT_DEFAULT_DECISION ?? "",
      SYNC_INTERCEPT_MANUAL_QUEUE_ENABLED: process.env.SYNC_INTERCEPT_MANUAL_QUEUE_ENABLED ?? "",
      SYNC_INTERCEPT_MANUAL_QUEUE_TOOLS: process.env.SYNC_INTERCEPT_MANUAL_QUEUE_TOOLS ?? "",
      SYNC_INTERCEPT_AUTO_ALLOW_TOOLS: process.env.SYNC_INTERCEPT_AUTO_ALLOW_TOOLS ?? "",
      SYNC_INTERCEPT_AUTO_DENY_TOOLS: process.env.SYNC_INTERCEPT_AUTO_DENY_TOOLS ?? "",
      SYNC_INTERCEPT_WAIT_TIMEOUT_MS: process.env.SYNC_INTERCEPT_WAIT_TIMEOUT_MS ?? "",
      SYNC_INTERCEPT_POLL_AFTER_MS: process.env.SYNC_INTERCEPT_POLL_AFTER_MS ?? "",
      SYNC_INTERCEPT_AUTH_TOKEN: process.env.SYNC_INTERCEPT_AUTH_TOKEN ? "<set>" : "",
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
    tokens_day: dayKey(),
    last_completed_at_ms: 0,
  };
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
    entries: Array.isArray(raw.entries) ? raw.entries.slice(-8).map((item) => String(item ?? "")).filter(Boolean) : [],
    prompt: raw.prompt && typeof raw.prompt === "object"
      ? {
          id: String(raw.prompt.id ?? "").trim(),
          tool: String(raw.prompt.tool ?? "").trim(),
          hint: String(raw.prompt.hint ?? "").trim(),
        }
      : null,
    tokens_day: String(raw.tokens_day ?? fallback.tokens_day),
    last_completed_at_ms: Number.isFinite(raw.last_completed_at_ms)
      ? raw.last_completed_at_ms
      : fallback.last_completed_at_ms,
  };
}

function ensureInterceptsShape(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      state: makeDefaultInterceptState(),
      requests: {},
    };
  }

  return {
    state: ensureInterceptState(raw.state),
    requests: raw.requests && typeof raw.requests === "object" ? raw.requests : {},
  };
}

function ensureStoreShape(raw) {
  if (!raw || typeof raw !== "object") {
    return { jobs: {}, runs: [], intercepts: ensureInterceptsShape(null) };
  }

  const jobs = raw.jobs && typeof raw.jobs === "object" ? raw.jobs : {};
  const runs = Array.isArray(raw.runs) ? raw.runs : [];
  const intercepts = ensureInterceptsShape(raw.intercepts);
  return { jobs, runs, intercepts };
}

function loadStore() {
  try {
    const raw = fs.readFileSync(dbFile, "utf8");
    return ensureStoreShape(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return ensureStoreShape(null);
    }
    throw error;
  }
}

function saveStore(store) {
  const dir = path.dirname(dbFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${dbFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, dbFile);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function renderInterceptApprovalPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyClaw Intercept Approval</title>
    <style>
      :root {
        --bg: #f4f6f8;
        --card: #ffffff;
        --border: #d9dee4;
        --text: #22303a;
        --muted: #5f7280;
        --accent: #0d8ddb;
        --danger: #c4382b;
      }
      body {
        margin: 0;
        font-family: "SF Mono", Menlo, Consolas, monospace;
        background: linear-gradient(120deg, #eef4fb 0%, #f8fafc 55%, #f4f7ef 100%);
        color: var(--text);
      }
      .wrap {
        max-width: 980px;
        margin: 24px auto;
        padding: 0 16px 24px;
      }
      .panel {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 14px;
        margin-bottom: 14px;
        box-shadow: 0 6px 20px rgba(17, 29, 45, 0.05);
      }
      .title {
        margin: 0 0 10px;
        font-size: 18px;
      }
      .row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      input {
        padding: 7px 8px;
        border: 1px solid var(--border);
        border-radius: 7px;
        min-width: 200px;
      }
      button {
        padding: 7px 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #fff;
        cursor: pointer;
      }
      button.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      button.danger {
        background: var(--danger);
        border-color: var(--danger);
        color: #fff;
      }
      .meta {
        color: var(--muted);
        font-size: 12px;
      }
      .stat {
        display: inline-block;
        margin-right: 16px;
      }
      .item {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px;
        margin-bottom: 8px;
      }
      .tool {
        font-weight: 700;
      }
      .empty {
        color: var(--muted);
      }
      .error {
        color: var(--danger);
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="panel">
        <h1 class="title">Intercept Waiting Approval</h1>
        <div class="row">
          <label>Auth Token <input id="token" type="password" placeholder="optional" /></label>
          <label>Operator <input id="operator" value="web-ui" /></label>
          <button id="refresh" class="primary">Refresh</button>
          <button id="auto">Auto 3s: ON</button>
        </div>
        <p class="meta" id="status">Loading...</p>
      </div>

      <div class="panel" id="summary"></div>

      <div class="panel">
        <div id="list"></div>
      </div>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);
      const tokenInput = $("token");
      const operatorInput = $("operator");
      const statusEl = $("status");
      const listEl = $("list");
      const summaryEl = $("summary");
      const refreshBtn = $("refresh");
      const autoBtn = $("auto");
      let timer = null;

      function headers() {
        const token = String(tokenInput.value || "").trim();
        const base = { "Content-Type": "application/json", "Accept": "application/json" };
        if (token) {
          base.Authorization = "Bearer " + token;
        }
        return base;
      }

      function ts(ms) {
        if (!ms) return "-";
        return new Date(ms).toLocaleString();
      }

      async function fetchJson(path, options = {}) {
        const response = await fetch(path, {
          ...options,
          headers: {
            ...(options.headers || {}),
            ...headers(),
          },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || response.statusText || "request failed");
        }
        return payload;
      }

      async function decide(id, decision) {
        const operator = String(operatorInput.value || "").trim() || "web-ui";
        await fetchJson("/api/copilot/intercepts/decision", {
          method: "POST",
          body: JSON.stringify({
            id,
            decision,
            operator,
            reason: "manual " + decision + " from web ui",
          }),
        });
        await refresh();
      }

      function renderState(state) {
        summaryEl.innerHTML =
          '<span class="stat"><strong>Total:</strong> ' + (state.total ?? 0) + '</span>' +
          '<span class="stat"><strong>Waiting:</strong> ' + (state.waiting ?? 0) + '</span>' +
          '<span class="stat"><strong>Running:</strong> ' + (state.running ?? 0) + '</span>' +
          '<span class="stat"><strong>Msg:</strong> ' + (state.msg || "-") + '</span>';
      }

      function renderList(items) {
        if (!Array.isArray(items) || items.length === 0) {
          listEl.innerHTML = '<p class="empty">No waiting requests.</p>';
          return;
        }

        listEl.innerHTML = "";
        for (const item of items) {
          const card = document.createElement("div");
          card.className = "item";
          card.innerHTML =
            '<div class="tool">' + (item.tool || "unknown") + ' <span class="meta">(' + item.id + ')</span></div>' +
            '<div>' + (item.hint || "-") + '</div>' +
            '<div class="meta">created: ' + ts(item.createdAtMs) + ' | expires: ' + ts(item.expiresAtMs) + '</div>' +
            '<div class="row" style="margin-top:8px;">' +
              '<button class="primary" data-action="allow">Allow</button>' +
              '<button class="danger" data-action="deny">Deny</button>' +
            '</div>';
          const allowBtn = card.querySelector('[data-action="allow"]');
          const denyBtn = card.querySelector('[data-action="deny"]');
          allowBtn.addEventListener("click", async () => {
            allowBtn.disabled = true;
            denyBtn.disabled = true;
            try {
              await decide(item.id, "allow");
            } catch (error) {
              statusEl.textContent = String(error.message || error);
              statusEl.className = "error";
              allowBtn.disabled = false;
              denyBtn.disabled = false;
            }
          });
          denyBtn.addEventListener("click", async () => {
            allowBtn.disabled = true;
            denyBtn.disabled = true;
            try {
              await decide(item.id, "deny");
            } catch (error) {
              statusEl.textContent = String(error.message || error);
              statusEl.className = "error";
              allowBtn.disabled = false;
              denyBtn.disabled = false;
            }
          });
          listEl.appendChild(card);
        }
      }

      async function refresh() {
        statusEl.className = "meta";
        statusEl.textContent = "Refreshing...";
        try {
          const [stateRes, queueRes] = await Promise.all([
            fetchJson("/api/copilot/intercepts/state"),
            fetchJson("/api/copilot/intercepts/queue?status=waiting&limit=100"),
          ]);
          renderState(stateRes.state || {});
          renderList(queueRes.items || []);
          statusEl.textContent = "Updated at " + new Date().toLocaleTimeString();
        } catch (error) {
          statusEl.textContent = String(error.message || error);
          statusEl.className = "error";
        }
      }

      function toggleAuto() {
        if (timer) {
          clearInterval(timer);
          timer = null;
          autoBtn.textContent = "Auto 3s: OFF";
          return;
        }
        timer = setInterval(refresh, 3000);
        autoBtn.textContent = "Auto 3s: ON";
      }

      refreshBtn.addEventListener("click", refresh);
      autoBtn.addEventListener("click", toggleAuto);
      refresh();
      timer = setInterval(refresh, 3000);
    </script>
  </body>
</html>`;
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function parseBody(req) {
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
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
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
  if (state.entries.length > 8) {
    state.entries = state.entries.slice(-8);
  }
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

function updateStateCounters(intercepts) {
  const requests = Object.values(intercepts.requests ?? {});
  const waiting = requests.filter((item) => item?.status === "waiting").length;
  const running = requests.filter((item) => item?.status === "running").length;
  intercepts.state.waiting = waiting;
  intercepts.state.running = running;
}

function maybeExpireRequest(intercepts, id) {
  const request = intercepts.requests[id];
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
    intercepts.state.msg = `Request ${request.id} timed out`;
    appendEntry(intercepts.state, `Timeout: ${request.tool} (${request.id})`);
    updateStateCounters(intercepts);
  }

  return request;
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
  if (!interceptAuthToken) {
    return true;
  }

  const authorization = String(req.headers.authorization ?? "").trim();
  const tokenFromAuth = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";
  const tokenFromHeader = String(req.headers["x-intercept-token"] ?? "").trim();
  const provided = tokenFromAuth || tokenFromHeader;

  if (!provided || provided !== interceptAuthToken) {
    console.warn(
      `[sync-server][intercept] unauthorized ${String(req.method ?? "") || "-"} ${String(req.url ?? "") || "-"}`,
    );
    json(res, 401, { error: "unauthorized" });
    return false;
  }

  return true;
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
      const store = loadStore();
      return json(res, 200, {
        ok: true,
        service: "myclaw-sync-server",
        jobs: Object.keys(store.jobs).length,
        runs: store.runs.length,
        intercepts: Object.keys(store.intercepts.requests).length,
      });
    }

    if (pathname.startsWith("/api/copilot/intercepts/")) {
      if (!requireInterceptAuth(req, res)) {
        return;
      }

      if (req.method === "GET" && pathname === "/api/copilot/intercepts/state") {
        const store = loadStore();
        refreshTodayTokens(store.intercepts.state);
        updateStateCounters(store.intercepts);
        saveStore(store);
        return json(res, 200, {
          state: toPublicInterceptState(store.intercepts.state),
        });
      }

      if (req.method === "GET" && pathname === "/api/copilot/intercepts/queue") {
        const statusFilter = String(url.searchParams.get("status") ?? "").trim().toLowerCase();
        const limit = toInt(url.searchParams.get("limit"), 100);
        const store = loadStore();
        const items = Object.values(store.intercepts.requests)
          .map((item) => maybeExpireRequest(store.intercepts, item?.id))
          .filter(Boolean)
          .filter((item) => !statusFilter || String(item.status ?? "").toLowerCase() === statusFilter)
          .sort((a, b) => Number(b.createdAtMs ?? 0) - Number(a.createdAtMs ?? 0))
          .slice(0, limit)
          .map((item) => ({
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
          }));
        updateStateCounters(store.intercepts);
        saveStore(store);
        return json(res, 200, { items });
      }

      if (req.method === "POST" && pathname === "/api/copilot/intercepts/pretool") {
        const body = await parseBody(req);
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

        const store = loadStore();
        refreshTodayTokens(store.intercepts.state);

        let item = maybeExpireRequest(store.intercepts, id);
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
          store.intercepts.requests[id] = item;
          store.intercepts.state.total += 1;
          appendEntry(store.intercepts.state, `Intercepted: ${tool} (${id})`);
          console.log(`[sync-server][intercept] queued id=${id} tool=${tool} total=${store.intercepts.state.total}`);
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
        store.intercepts.state.prompt = {
          id,
          tool,
          hint: item.hint,
        };
        store.intercepts.state.msg = item.msg;

        if (!isNew) {
          appendEntry(store.intercepts.state, `Re-intercepted: ${tool} (${id})`);
        }

        if (item.status === "approved") {
          appendEntry(store.intercepts.state, `Auto allow: ${tool} (${id})`);
        }
        if (item.status === "denied") {
          appendEntry(store.intercepts.state, `Auto deny: ${tool} (${id})`);
        }

        updateStateCounters(store.intercepts);
        saveStore(store);

        return json(res, 200, {
          ok: true,
          id,
          decision: item.decision,
          status: item.status,
          reason: item.reason,
          pollAfterMs: interceptPollAfterMs,
          expiresInMs: Math.max(0, Number(item.expiresAtMs ?? now) - now),
          msg: item.msg,
          state: toPublicInterceptState(store.intercepts.state),
        });
      }

      if (req.method === "GET" && pathname === "/api/copilot/intercepts/decision") {
        const id = String(url.searchParams.get("id") ?? "").trim();
        if (!id) {
          return json(res, 400, { error: "id is required" });
        }

        const store = loadStore();
        const item = maybeExpireRequest(store.intercepts, id);
        if (!item) {
          return notFound(res);
        }

        updateStateCounters(store.intercepts);
        saveStore(store);
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
        const body = await parseBody(req);
        const id = String(body?.id ?? "").trim();
        const decision = normalizeDecision(body?.decision, "deny");
        if (!id) {
          return json(res, 400, { error: "id is required" });
        }
        if (!["allow", "deny", "approved", "denied"].includes(decision)) {
          return json(res, 400, { error: "decision must be allow or deny" });
        }

        const store = loadStore();
        const item = maybeExpireRequest(store.intercepts, id);
        if (!item) {
          return notFound(res);
        }

        const now = Date.now();
        const finalDecision = ["allow", "approved"].includes(decision) ? "allow" : "deny";
        item.status = finalDecision === "allow" ? "approved" : "denied";
        item.decision = finalDecision;
        item.reason = String(body?.reason ?? "").trim() || `manual ${finalDecision}`;
        item.decidedBy = String(body?.operator ?? "").trim() || "manual";
        item.decidedAtMs = now;
        item.updatedAtMs = now;

        console.log(
          `[sync-server][intercept] manual decision id=${item.id} tool=${item.tool} decision=${finalDecision} by=${item.decidedBy}`,
        );

        store.intercepts.state.msg = `Manual ${finalDecision}: ${item.tool}`;
        store.intercepts.state.prompt = {
          id: item.id,
          tool: item.tool,
          hint: item.hint,
        };
        appendEntry(store.intercepts.state, `Manual ${finalDecision}: ${item.tool} (${item.id})`);

        updateStateCounters(store.intercepts);
        saveStore(store);
        return json(res, 200, {
          ok: true,
          id: item.id,
          status: item.status,
          decision: item.decision,
          reason: item.reason,
          state: toPublicInterceptState(store.intercepts.state),
        });
      }

      if (req.method === "POST" && pathname === "/api/copilot/intercepts/event") {
        const body = await parseBody(req);
        const event = body?.event;
        if (!event || typeof event !== "object") {
          return json(res, 400, { error: "invalid event payload" });
        }

        const store = loadStore();
        refreshTodayTokens(store.intercepts.state);

        const msg = String(event.msg ?? "").trim();
        if (msg) {
          store.intercepts.state.msg = msg;
        }

        const entry = String(event.entry ?? "").trim();
        if (entry) {
          appendEntry(store.intercepts.state, entry);
        }

        if (event.prompt && typeof event.prompt === "object") {
          store.intercepts.state.prompt = {
            id: String(event.prompt.id ?? "").trim(),
            tool: String(event.prompt.tool ?? "").trim(),
            hint: String(event.prompt.hint ?? "").trim(),
          };
        }

        const tokens = Number.parseInt(String(event.tokens ?? "0"), 10);
        if (Number.isFinite(tokens) && tokens > 0) {
          store.intercepts.state.tokens += tokens;
          store.intercepts.state.tokens_today += tokens;
        }

        if (event.completed === true) {
          store.intercepts.state.completed = true;
          store.intercepts.state.last_completed_at_ms = Date.now();
        }

        updateStateCounters(store.intercepts);
        saveStore(store);
        return json(res, 200, { ok: true, state: toPublicInterceptState(store.intercepts.state) });
      }

      return notFound(res);
    }

    if (req.method === "GET" && pathname === "/api/jobs") {
      const store = loadStore();
      return json(res, 200, { jobs: Object.values(store.jobs) });
    }

    if (req.method === "GET" && pathname.startsWith("/api/jobs/")) {
      const id = decodeURIComponent(pathname.slice("/api/jobs/".length));
      const store = loadStore();
      const job = store.jobs[id];
      if (!job) {
        return notFound(res);
      }
      return json(res, 200, { job });
    }

    if (req.method === "PUT" && pathname.startsWith("/api/jobs/")) {
      const id = decodeURIComponent(pathname.slice("/api/jobs/".length));
      const body = await parseBody(req);
      const job = body?.job;
      if (!job || typeof job !== "object") {
        return json(res, 400, { error: "invalid job payload" });
      }

      const store = loadStore();
      store.jobs[id] = {
        ...job,
        id,
        syncedAtMs: Date.now(),
      };
      saveStore(store);
      return json(res, 200, { ok: true, job: store.jobs[id] });
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/jobs/")) {
      const id = decodeURIComponent(pathname.slice("/api/jobs/".length));
      const store = loadStore();
      delete store.jobs[id];
      saveStore(store);
      return json(res, 200, { ok: true, id });
    }

    if (req.method === "GET" && pathname === "/api/runs") {
      const jobId = url.searchParams.get("jobId") || "";
      const limit = toInt(url.searchParams.get("limit"), 100);
      const store = loadStore();
      let runs = store.runs;
      if (jobId) {
        runs = runs.filter((item) => item?.jobId === jobId);
      }
      return json(res, 200, { runs: runs.slice(-limit).reverse() });
    }

    if (req.method === "POST" && pathname === "/api/runs") {
      const body = await parseBody(req);
      const run = body?.run;
      if (!run || typeof run !== "object") {
        return json(res, 400, { error: "invalid run payload" });
      }

      const store = loadStore();
      store.runs.push({ ...run, syncedAtMs: Date.now() });
      if (store.runs.length > 5000) {
        store.runs = store.runs.slice(-5000);
      }
      saveStore(store);
      return json(res, 200, { ok: true });
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
