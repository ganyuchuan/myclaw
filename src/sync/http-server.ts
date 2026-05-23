import crypto from "node:crypto";
import { createServer } from "node:http";
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import { interceptStore } from "./intercept-store.js";

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
const interceptDefaultDecision = normalizeDecision(process.env.SYNC_INTERCEPT_DEFAULT_DECISION, "allow");
const interceptManualQueueEnabled = toBool(process.env.SYNC_INTERCEPT_MANUAL_QUEUE_ENABLED, false);
const interceptManualQueueTools = new Set(toList(process.env.SYNC_INTERCEPT_MANUAL_QUEUE_TOOLS, []));
const interceptAutoAllowTools = new Set(toList(process.env.SYNC_INTERCEPT_AUTO_ALLOW_TOOLS, []));
const interceptAutoDenyTools = new Set(toList(process.env.SYNC_INTERCEPT_AUTO_DENY_TOOLS, []));
const interceptWaitTimeoutMs = toInt(process.env.SYNC_INTERCEPT_WAIT_TIMEOUT_MS, 60000);
const interceptPollAfterMs = toInt(process.env.SYNC_INTERCEPT_POLL_AFTER_MS, 1000);
const maxStateEntries = 50;

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
    const userPrincipal = interceptStore.getUserByAuthToken(provided);
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
        intercepts: interceptStore.countAllRequests(),
      });
    }

    if (req.method === "POST" && pathname === "/auth/token") {
      const body = await parseBody<AuthTokenBody>(req);
      const userName = String(body?.userName ?? "").trim();
      if (!userName) {
        return json(res, 400, { error: "userName is required" });
      }

      const issued = interceptStore.withTransaction(() => interceptStore.createUserTokenRecord({ userName }));
      return json(res, 200, {
        ok: true,
        userId: issued.userId,
        authToken: issued.authToken,
        userName: issued.userName,
      });
    }

    if (req.method === "GET" && pathname === "/auth/users") {
      const limit = toInt(url.searchParams.get("limit"), 100);
      const users = interceptStore.listUsers(limit);
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
        const state = interceptStore.withTransaction(() => {
          const nextState = interceptStore.loadState(principalUserId);
          refreshTodayTokens(nextState);
          updateStateCounters(nextState);
          interceptStore.saveState(principalUserId, nextState);
          return nextState;
        });

        return json(res, 200, {
          state: toPublicInterceptState(state),
        });
      }

      if (req.method === "GET" && pathname === "/api/copilot/intercepts/queue") {
        const statusFilter = String(url.searchParams.get("status") ?? "").trim().toLowerCase();
        const limit = toInt(url.searchParams.get("limit"), 100);
        const items = interceptStore.withTransaction(() => {
          const state = interceptStore.loadState(principalUserId);
          const waitingItems = interceptStore.listRequests(principalUserId, { status: "waiting", limit: 1000000 });

          for (const item of waitingItems) {
            const previousStatus = item.status;
            const previousUpdatedAtMs = item.updatedAtMs;
            maybeExpireRequest(state, item);
            if (item.status !== previousStatus || item.updatedAtMs !== previousUpdatedAtMs) {
              interceptStore.saveRequest(principalUserId, item);
            }
          }

          updateStateCounters(state);
          interceptStore.saveState(principalUserId, state);

          return interceptStore.listRequests(principalUserId, {
            status: statusFilter,
            limit,
          }).map(toQueueItem);
        });

        return json(res, 200, { items });
      }

      if (req.method === "GET" && pathname === "/api/copilot/intercepts/tool-calls") {
        const requested = toInt(url.searchParams.get("limit"), 100);
        const limit = Math.min(requested, 500);
        const items = interceptStore.listToolCalls(principalUserId, limit).map((item) => ({
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
          total: interceptStore.countToolCalls(principalUserId),
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

        const result = interceptStore.withTransaction(() => {
          const state = interceptStore.loadState(principalUserId);
          refreshTodayTokens(state);

          let item = interceptStore.getRequestById(principalUserId, id);
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
          interceptStore.saveRequest(principalUserId, item);
          interceptStore.saveState(principalUserId, state);

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

        const item = interceptStore.withTransaction(() => {
          const state = interceptStore.loadState(principalUserId);
          const nextItem = interceptStore.getRequestById(principalUserId, id);
          if (!nextItem) {
            return null;
          }

          const previousStatus = nextItem.status;
          const previousUpdatedAtMs = nextItem.updatedAtMs;
          maybeExpireRequest(state, nextItem);
          if (nextItem.status !== previousStatus || nextItem.updatedAtMs !== previousUpdatedAtMs) {
            interceptStore.saveRequest(principalUserId, nextItem);
            interceptStore.saveState(principalUserId, state);
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

        const result = interceptStore.withTransaction(() => {
          const state = interceptStore.loadState(principalUserId);
          const item = interceptStore.getRequestById(principalUserId, id);
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
          interceptStore.saveRequest(principalUserId, item);
          interceptStore.saveState(principalUserId, state);

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

        const state = interceptStore.withTransaction(() => {
          const nextState = interceptStore.loadState(principalUserId);
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
            interceptStore.insertToolCall(principalUserId, event.toolCall);
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
          interceptStore.saveState(principalUserId, nextState);
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
  console.log(`[sync-server] db file: ${interceptStore.getDbFile()}`);
});
