import { CopilotClient, approveAll } from "@github/copilot-sdk";
import crypto from "node:crypto";
import path from "node:path";
import { getSkillDirectoriesForSession } from "./skills.js";
import { loadMcpServersForCopilot } from "./mcp.js";

const DEFAULT_SHARED_SESSION_KEY = "__global__";

let sharedSessionQueues = new Map();
let sdkClient = null;
let sdkClientCwd = "";
let sharedSessions = new Map();
let sharedCopilotSessionIds = new Map();
let sharedSkillSignatures = new Map();
const sessionLifecycleState = {
  total: 0,
  running: 0,
  waiting: 0,
  completed: false,
};

function normalizeSessionKey(sessionKey) {
  const normalized = String(sessionKey ?? "").trim();
  return normalized || DEFAULT_SHARED_SESSION_KEY;
}

function getSharedSessionIdForKey(sessionKey) {
  return sharedCopilotSessionIds.get(normalizeSessionKey(sessionKey)) || "";
}

function setSharedSessionIdForKey(sessionKey, sessionId) {
  const key = normalizeSessionKey(sessionKey);
  const normalizedSessionId = String(sessionId ?? "").trim();
  if (normalizedSessionId) {
    sharedCopilotSessionIds.set(key, normalizedSessionId);
  } else {
    sharedCopilotSessionIds.delete(key);
  }
}

async function disconnectSharedSessionForKey(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  const existing = sharedSessions.get(key);
  if (existing) {
    await existing.disconnect().catch(() => {});
  }
  sharedSessions.delete(key);
  sharedSkillSignatures.delete(key);
  sharedSessionQueues.delete(key);
  sharedCopilotSessionIds.delete(key);
}

async function resetAllSharedSessions() {
  const keys = new Set([
    ...sharedSessions.keys(),
    ...sharedCopilotSessionIds.keys(),
    ...sharedSkillSignatures.keys(),
    ...sharedSessionQueues.keys(),
  ]);

  for (const key of keys) {
    await disconnectSharedSessionForKey(key);
  }

  sharedSessions = new Map();
  sharedCopilotSessionIds = new Map();
  sharedSkillSignatures = new Map();
  sharedSessionQueues = new Map();
}

function withSharedSessionLock(sessionKey, task) {
  const key = normalizeSessionKey(sessionKey);
  const queue = sharedSessionQueues.get(key) || Promise.resolve();
  const run = queue.then(task, task);
  // Keep queue alive even when one task fails.
  sharedSessionQueues.set(key, run.catch(() => {}));
  return run;
}

function denyAllPermissions() {
  return { kind: "denied-by-rules" };
}

function resolvePermissionHandler(config) {
  const mode = String(config?.permissionRequestMode ?? "auto").trim().toLowerCase();

  if (mode === "approve") {
    return approveAll;
  }

  if (mode === "deny") {
    return denyAllPermissions;
  }

  if (mode === "delegate") {
    return undefined;
  }

  return config.allowAllTools ? approveAll : denyAllPermissions;
}

const DEFAULT_RESTRICTED_DIR_TOOLS = [
  "read_file",
  "create_file",
  "edit_file",
  "delete_file",
  "file_search",
  "list_dir",
  "view_image",
];

const DEFAULT_DESTRUCTIVE_TOOLS = [
  "delete_file",
  "edit_file",
  "create_file",
  "run_in_terminal",
  "run_command",
  "shell",
  "bash",
];

type HttpErrorPayload = {
  error?: string;
};

type InterceptDecisionPayload = {
  status?: string;
  decision?: string;
  reason?: string;
  msg?: string;
};

function normalizeSet(values, fallback = []) {
  const source = Array.isArray(values) && values.length > 0 ? values : fallback;
  return new Set(source.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean));
}

function isPathInsideAllowedDirs(filePath, allowedDirs) {
  const normalizedPath = path.resolve(filePath);
  return allowedDirs.some((dirPath) => {
    const normalizedDir = path.resolve(dirPath);
    return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}${path.sep}`);
  });
}

function collectPathCandidates(toolArgs) {
  const candidates = [];
  const seen = new Set();
  const keys = new Set([
    "path",
    "filePath",
    "targetPath",
    "directory",
    "dirPath",
    "cwd",
    "workingDirectory",
    "source",
    "destination",
  ]);

  const walk = (value) => {
    if (!value) {
      return;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) {
        return;
      }
      seen.add(trimmed);
      candidates.push(trimmed);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        if (keys.has(key)) {
          walk(nested);
        }
      }
    }
  };

  walk(toolArgs);
  return candidates;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDecision(value, fallback = "deny") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["allow", "deny", "ask", "wait", "waiting", "approved", "denied", "expired", "timeout"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function trimTrailingSlash(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

function createInterceptRequestId(input) {
  const candidates = [
    input?.requestId,
    input?.permissionRequestId,
    input?.toolCallId,
    input?.id,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return `perm_${crypto.randomUUID()}`;
}

function truncateString(value, maxLength = 240) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function estimateTextTokens(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return 0;
  }

  const cjkChars = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
  const asciiChars = text.length - cjkChars;
  const asciiTokens = Math.ceil(Math.max(0, asciiChars) / 4);
  return Math.max(1, cjkChars + asciiTokens);
}

function estimateConversationTokens({ prompt, output, entries = [] }) {
  const promptTokens = estimateTextTokens(prompt);
  const outputTokens = estimateTextTokens(output);
  const entryTokens = Array.isArray(entries)
    ? entries.reduce((total, item) => total + estimateTextTokens(item), 0)
    : 0;

  // Prefer the explicit prompt and final output. Entries are used only as a fallback
  // because they can overlap with prompt/output content depending on the hook payload.
  const baseTokens = promptTokens + outputTokens;
  if (baseTokens > 0) {
    return baseTokens;
  }

  return entryTokens;
}

function estimateConversationTokenBreakdown({ prompt, output, entries = [] }) {
  const promptText = String(prompt ?? "").trim();
  const outputText = String(output ?? "").trim();
  const promptTokens = estimateTextTokens(promptText);
  const outputTokens = estimateTextTokens(outputText);
  const totalTokens = promptTokens + outputTokens;

  if (totalTokens > 0) {
    return {
      promptTokens,
      outputTokens,
      totalTokens,
      promptPreview: truncateString(promptText, 160),
      outputPreview: truncateString(outputText, 160),
    };
  }

  const fallbackEntries = Array.isArray(entries)
    ? entries.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const fallbackText = fallbackEntries.join("\n");
  const fallbackTokens = estimateConversationTokens({ prompt, output, entries });
  return {
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: fallbackTokens,
    promptPreview: "",
    outputPreview: truncateString(fallbackText, 160),
  };
}

function truncateForViewPath(value) {
  const text = String(value ?? "").trim();
  return text;
}

function truncateForHintValue(value) {
  const text = String(value ?? "").trim();
  return text;
}

function summarizeHintArgsForLog(toolArgs) {
  if (toolArgs === null || toolArgs === undefined) {
    return "null";
  }

  if (typeof toolArgs === "string") {
    return `string(len=${toolArgs.length}): ${truncateString(toolArgs, 80)}`;
  }

  if (Array.isArray(toolArgs)) {
    return `array(len=${toolArgs.length})`;
  }

  if (typeof toolArgs === "object") {
    const keys = Object.keys(toolArgs);
    const shown = keys.slice(0, 8).join(",");
    const suffix = keys.length > 8 ? ",..." : "";
    return `object(keys=${shown}${suffix})`;
  }

  return String(typeof toolArgs);
}

function parseHintArgs(toolArgs) {
  if (!toolArgs) {
    return {};
  }

  if (typeof toolArgs === "string") {
    try {
      return JSON.parse(toolArgs);
    } catch {
      console.warn(
        `[copilot-sdk][intercept][hint] parse args failed raw=${truncateString(toolArgs, 80)}`,
      );
      return {};
    }
  }

  if (typeof toolArgs === "object") {
    return toolArgs;
  }

  return {};
}

function extractPatchBody(toolArgs) {
  const text = String(toolArgs ?? "");
  const beginMarker = "*** Begin Patch";
  const endMarker = "*** End Patch";
  const beginIndex = text.indexOf(beginMarker);
  const endIndex = text.lastIndexOf(endMarker);

  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    return truncateForHintValue(text);
  }

  const start = beginIndex + beginMarker.length;
  const body = text.slice(start, endIndex).trim();
  return truncateForHintValue(body);
}

function buildViewHint(toolArgs) {
  const args = parseHintArgs(toolArgs);
  const pathValue = truncateForViewPath(args.path);
  const rangeValue = args.view_range;

  if (Array.isArray(rangeValue) && rangeValue.length > 0) {
    const rangeText = truncateForHintValue(JSON.stringify(rangeValue));
    if (pathValue) {
      return `${pathValue} ${rangeText}`;
    }
    return rangeText;
  }

  return pathValue;
}

function buildBashHint(toolArgs) {
  const args = parseHintArgs(toolArgs);
  const commandValue = truncateForHintValue(args.command);
  const descriptionValue = truncateForHintValue(args.description);

  if (commandValue && descriptionValue) {
    return `${commandValue}\n${descriptionValue}`;
  }
  if (commandValue) {
    return commandValue;
  }
  return descriptionValue;
}

function generateInterceptHintWithTemplate(toolName, toolArgs) {
  const normalizedTool = String(toolName ?? "").trim().toLowerCase();
  const argsSummary = summarizeHintArgsForLog(toolArgs);

  if (normalizedTool === "view") {
    const hint = buildViewHint(toolArgs) || truncateForHintValue(JSON.stringify(toolArgs ?? {}));
    console.log(
      `[copilot-sdk][intercept][hint] tool=${normalizedTool} strategy=view args=${argsSummary} hint=${JSON.stringify(hint)}`,
    );
    return hint;
  }
  if (normalizedTool === "bash") {
    const hint = buildBashHint(toolArgs) || truncateForHintValue(JSON.stringify(toolArgs ?? {}));
    console.log(
      `[copilot-sdk][intercept][hint] tool=${normalizedTool} strategy=bash args=${argsSummary} hint=${JSON.stringify(hint)}`,
    );
    return hint;
  }
  if (normalizedTool === "apply_patch") {
    const hint = extractPatchBody(toolArgs) || truncateForHintValue(JSON.stringify(toolArgs ?? {}));
    console.log(
      `[copilot-sdk][intercept][hint] tool=${normalizedTool} strategy=apply_patch args=${argsSummary} hint=${JSON.stringify(hint)}`,
    );
    return hint;
  }

  const fallbackHint = truncateForHintValue(JSON.stringify(toolArgs ?? {}));
  console.log(
    `[copilot-sdk][intercept][hint] tool=${normalizedTool || "-"} strategy=fallback args=${argsSummary} hint=${JSON.stringify(fallbackHint)}`,
  );
  return fallbackHint;
}

function collectHumanReadableHint(toolName, toolArgs) {
  return generateInterceptHintWithTemplate(toolName, toolArgs);
}

function safeCloneToolArgs(toolArgs) {
  if (!toolArgs || typeof toolArgs !== "object") {
    return toolArgs ?? null;
  }

  const sensitive = ["token", "secret", "password", "apiKey", "apikey", "authorization", "auth"];
  const walk = (value) => {
    if (value === null || value === undefined) {
      return value ?? null;
    }

    if (typeof value === "string") {
      return value.length > 500 ? `${value.slice(0, 497)}...` : value;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => walk(item));
    }

    if (typeof value === "object") {
      const result = {};
      for (const [key, nested] of Object.entries(value)) {
        const lowered = String(key ?? "").toLowerCase();
        if (sensitive.some((item) => lowered.includes(item.toLowerCase()))) {
          result[key] = "***";
        } else {
          result[key] = walk(nested);
        }
      }
      return result;
    }

    return value;
  };

  return walk(toolArgs);
}

async function fetchJsonWithTimeout(
  url,
  { method = "GET", headers = {}, body = undefined, timeoutMs = 5000 } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), toPositiveInt(timeoutMs, 5000));
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const typedPayload = payload as HttpErrorPayload | null;
      throw new Error(`http ${response.status}: ${String(typedPayload?.error ?? response.statusText)}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function mapInterceptDecisionToPermission(result, fallbackReason) {
  const decision = normalizeDecision(result?.decision, "deny");
  const reason = String(result?.reason ?? fallbackReason ?? "intercept decision").trim() || "intercept decision";

  if (decision === "allow" || decision === "approved") {
    return {
      permissionDecision: "allow",
      permissionDecisionReason: reason,
    };
  }

  if (decision === "ask") {
    return {
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    };
  }

  return {
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function shortId(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "-";
  }
  return text.length <= 14 ? text : `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function safeStringify(value, fallback = "{}") {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function normalizeMessageEntry(value) {
  if (typeof value === "string") {
    return truncateString(value, 500);
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const role = String(value.role ?? "").trim();
  const content = String(value.content ?? value.text ?? value.message ?? "").trim();
  if (!content) {
    return "";
  }

  return truncateString(role ? `${role}: ${content}` : content, 500);
}

function collectSessionEntries(input, invocation) {
  const sourceArrays = [
    input?.messages,
    input?.session?.messages,
    invocation?.messages,
    invocation?.session?.messages,
  ];

  const result = [];
  for (const source of sourceArrays) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const item of source) {
      const normalized = normalizeMessageEntry(item);
      if (normalized) {
        result.push(normalized);
      }
    }
  }

  if (result.length === 0) {
    const fallbackPrompt = String(input?.prompt ?? invocation?.prompt ?? "").trim();
    if (fallbackPrompt) {
      result.push(truncateString(fallbackPrompt, 500));
    }
  }

  return result.slice(-50);
}

function snapshotLifecycleState() {
  return {
    total: sessionLifecycleState.total,
    running: sessionLifecycleState.running,
    waiting: sessionLifecycleState.waiting,
    completed: sessionLifecycleState.completed,
  };
}

function markSessionStart() {
  sessionLifecycleState.total += 1;
  sessionLifecycleState.running += 1;
  sessionLifecycleState.completed = false;
  return snapshotLifecycleState();
}

function markSessionEnd() {
  sessionLifecycleState.running = Math.max(0, sessionLifecycleState.running - 1);
  sessionLifecycleState.completed = true;
  return snapshotLifecycleState();
}

function createPostToolRequestId(input, invocation) {
  const candidates = [
    input?.requestId,
    input?.permissionRequestId,
    input?.toolCallId,
    input?.id,
    invocation?.requestId,
    invocation?.toolCallId,
    invocation?.id,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }

  return `post_${crypto.randomUUID()}`;
}

async function reportPostToolUseEvent({ input, invocation, config, workDir }) {
  const interceptServerUrl = trimTrailingSlash(config.interceptServerUrl);
  if (!config.interceptEnabled || !interceptServerUrl) {
    return;
  }

  const interceptAuthToken = String(config.interceptAuthToken ?? "").trim();
  const interceptTimeoutMs = toPositiveInt(config.interceptTimeoutMs, 5000);
  const toolName = String(input?.toolName ?? "").trim().toLowerCase();
  if (!toolName) {
    return;
  }

  const requestId = createPostToolRequestId(input, invocation);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (interceptAuthToken) {
    headers.Authorization = `Bearer ${interceptAuthToken}`;
  }

  const safeArgs = safeCloneToolArgs(input?.toolArgs);
  const safeResult = safeCloneToolArgs(input?.toolResult);
  const sessionId = String(invocation?.sessionId ?? input?.sessionId ?? "").trim();

  await fetchJsonWithTimeout(`${interceptServerUrl}/api/copilot/intercepts/event`, {
    method: "POST",
    headers,
    timeoutMs: interceptTimeoutMs,
    body: JSON.stringify({
      event: {
        msg: `Tool ${toolName} completed`,
        entry: `Tool result: ${toolName} (${requestId})`,
        prompt: {
          id: requestId,
          tool: toolName,
          hint: collectHumanReadableHint(toolName, safeArgs),
        },
        toolCall: {
          id: requestId,
          sessionId,
          tool: toolName,
          args: safeArgs,
          result: safeResult,
          ts: Date.now(),
          workDir,
        },
      },
    }),
  });
}

async function reportSessionLifecycleEvent({ phase, input, invocation, config, workDir }) {
  const interceptServerUrl = trimTrailingSlash(config.interceptServerUrl);
  if (!config.interceptEnabled || !interceptServerUrl) {
    return;
  }

  const interceptAuthToken = String(config.interceptAuthToken ?? "").trim();
  const interceptTimeoutMs = toPositiveInt(config.interceptTimeoutMs, 5000);
  const requestId = createPostToolRequestId(input, invocation);
  const sessionId = String(invocation?.sessionId ?? input?.sessionId ?? "").trim();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (interceptAuthToken) {
    headers.Authorization = `Bearer ${interceptAuthToken}`;
  }

  const state = phase === "start" ? markSessionStart() : markSessionEnd();
  const entries = collectSessionEntries(input, invocation);

  await fetchJsonWithTimeout(`${interceptServerUrl}/api/copilot/intercepts/event`, {
    method: "POST",
    headers,
    timeoutMs: interceptTimeoutMs,
    body: JSON.stringify({
      event: {
        msg: `Session ${phase}: ${sessionId || shortId(requestId)}`,
        entry: `Session ${phase}: ${sessionId || shortId(requestId)}`,
        state,
        entries,
        prompt: {
          id: sessionId || requestId,
          tool: "session",
          hint: `Copilot session ${phase}`,
        },
        session: {
          id: sessionId,
          phase,
          ts: Date.now(),
          workDir,
        },
      },
    }),
  });
}

async function reportSessionTokenEstimateEvent({
  sessionId,
  prompt,
  output,
  config,
  workDir,
  entries = [],
}) {
  const interceptServerUrl = trimTrailingSlash(config.interceptServerUrl);
  if (!config.interceptEnabled || !interceptServerUrl) {
    return;
  }

  const breakdown = estimateConversationTokenBreakdown({ prompt, output, entries });
  const tokens = breakdown.totalTokens;
  if (tokens <= 0) {
    return;
  }

  const interceptAuthToken = String(config.interceptAuthToken ?? "").trim();
  const interceptTimeoutMs = toPositiveInt(config.interceptTimeoutMs, 5000);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (interceptAuthToken) {
    headers.Authorization = `Bearer ${interceptAuthToken}`;
  }

  await fetchJsonWithTimeout(`${interceptServerUrl}/api/copilot/intercepts/event`, {
    method: "POST",
    headers,
    timeoutMs: interceptTimeoutMs,
    body: JSON.stringify({
      event: {
        msg: `Session tokens estimated: ${sessionId || "-"}`,
        entry: `Session tokens estimated: ${sessionId || "-"} (${tokens})`,
        tokens,
        tokenEstimate: {
          sessionId,
          promptTokens: breakdown.promptTokens,
          outputTokens: breakdown.outputTokens,
          totalTokens: breakdown.totalTokens,
          promptPreview: breakdown.promptPreview,
          outputPreview: breakdown.outputPreview,
          estimatedAtMs: Date.now(),
        },
        prompt: {
          id: sessionId || `tokens_${crypto.randomUUID()}`,
          tool: "session",
          hint: `Estimated tokens for completed Copilot session: ${tokens}`,
        },
        session: {
          id: sessionId,
          phase: "token-estimate",
          ts: Date.now(),
          workDir,
        },
      },
    }),
  });
}

async function pollInterceptDecision({
  interceptServerUrl,
  interceptAuthToken,
  requestId,
  interceptTimeoutMs,
  interceptPollIntervalMs,
  interceptMaxWaitMs,
}) {
  const startedAt = Date.now();
  let attempts = 0;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (interceptAuthToken) {
    headers.Authorization = `Bearer ${interceptAuthToken}`;
  }

  console.log(
    `[copilot-sdk][intercept] poll start requestId=${shortId(requestId)} intervalMs=${interceptPollIntervalMs} maxWaitMs=${interceptMaxWaitMs}`,
  );

  while (Date.now() - startedAt < interceptMaxWaitMs) {
    attempts += 1;
    const params = new URLSearchParams({ id: requestId });
    const payload = await fetchJsonWithTimeout(
      `${interceptServerUrl}/api/copilot/intercepts/decision?${params.toString()}`,
      {
        method: "GET",
        headers,
        timeoutMs: interceptTimeoutMs,
      },
    ) as InterceptDecisionPayload;

    const status = normalizeDecision(payload?.status, "waiting");
    const decision = normalizeDecision(payload?.decision, "wait");
    if (attempts === 1 || attempts % 5 === 0 || status !== "waiting") {
      console.log(
        `[copilot-sdk][intercept] poll tick requestId=${shortId(requestId)} attempt=${attempts} status=${status} decision=${decision}`,
      );
    }

    if (["allow", "approved"].includes(decision) || status === "approved") {
      console.log(
        `[copilot-sdk][intercept] poll resolved allow requestId=${shortId(requestId)} attempts=${attempts} elapsedMs=${Date.now() - startedAt}`,
      );
      return {
        decision: "allow",
        reason: payload?.reason || "approved by intercept server",
      };
    }

    if (["deny", "denied", "expired", "timeout"].includes(decision) || ["denied", "expired", "timeout"].includes(status)) {
      console.log(
        `[copilot-sdk][intercept] poll resolved deny requestId=${shortId(requestId)} attempts=${attempts} status=${status} elapsedMs=${Date.now() - startedAt}`,
      );
      return {
        decision: "deny",
        reason: payload?.reason || `intercept ${status}`,
      };
    }

    await sleep(interceptPollIntervalMs);
  }

  console.warn(
    `[copilot-sdk][intercept] poll timeout requestId=${shortId(requestId)} attempts=${attempts} elapsedMs=${Date.now() - startedAt}`,
  );

  return {
    decision: "deny",
    reason: `intercept decision timeout after ${interceptMaxWaitMs}ms`,
  };
}

async function requestInterceptDecision({ input, toolName, config, workDir }) {
  const interceptServerUrl = trimTrailingSlash(config.interceptServerUrl);
  const interceptAuthToken = String(config.interceptAuthToken ?? "").trim();
  const interceptTimeoutMs = toPositiveInt(config.interceptTimeoutMs, 5000);
  const interceptPollIntervalMs = toPositiveInt(config.interceptPollIntervalMs, 1000);
  const interceptMaxWaitMs = toPositiveInt(config.interceptMaxWaitMs, 30000);
  const requestId = createInterceptRequestId(input);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (interceptAuthToken) {
    headers.Authorization = `Bearer ${interceptAuthToken}`;
  }

  console.log(
    `[copilot-sdk][intercept] pretool send requestId=${shortId(requestId)} tool=${toolName} server=${interceptServerUrl}`,
  );

  const payload = await fetchJsonWithTimeout(`${interceptServerUrl}/api/copilot/intercepts/pretool`, {
    method: "POST",
    headers,
    timeoutMs: interceptTimeoutMs,
    body: JSON.stringify({
      request: {
        id: requestId,
        tool: toolName,
        hint: collectHumanReadableHint(toolName, input?.toolArgs),
        msg: `Intercepted tool ${toolName}`,
        sessionId: String(input?.sessionId ?? "").trim() || null,
        workDir,
        input: {
          toolName,
          toolArgs: safeCloneToolArgs(input?.toolArgs),
          metadata: safeCloneToolArgs(input?.metadata),
        },
        ts: Date.now(),
      },
    }),
  }) as InterceptDecisionPayload;

  const decision = normalizeDecision(payload?.decision, "deny");
  console.log(
    `[copilot-sdk][intercept] pretool decision requestId=${shortId(requestId)} tool=${toolName} decision=${decision}`,
  );
  if (decision !== "wait") {
    return {
      decision,
      reason: payload?.reason || payload?.msg || "intercept decision",
    };
  }

  console.log(
    `[copilot-sdk][intercept] pretool queued requestId=${shortId(requestId)} tool=${toolName} entering=poll`,
  );

  return pollInterceptDecision({
    interceptServerUrl,
    interceptAuthToken,
    requestId,
    interceptTimeoutMs,
    interceptPollIntervalMs,
    interceptMaxWaitMs,
  });
}

function buildCopilotHooks(config) {
  if (!config?.hookEnabled) {
    return undefined;
  }

  const workDir = path.resolve(config.workDir || process.cwd());
  const blockedTools = normalizeSet(config.blockedTools, []);
  const restrictedDirTools = normalizeSet(config.restrictedDirTools, DEFAULT_RESTRICTED_DIR_TOOLS);
  const destructiveTools = normalizeSet(config.destructiveTools, DEFAULT_DESTRUCTIVE_TOOLS);
  const interceptTools = normalizeSet(config.interceptTools, []);
  const interceptServerUrl = trimTrailingSlash(config.interceptServerUrl);
  const interceptEnabled = Boolean(config.interceptEnabled && interceptServerUrl && interceptTools.size > 0);
  const allowedDirs = (Array.isArray(config.allowedDirs) ? config.allowedDirs : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .map((item) => path.resolve(path.isAbsolute(item) ? item : path.resolve(workDir, item)));

  return {
    onPreToolUse: async (input) => {
      const toolName = String(input?.toolName ?? "").trim().toLowerCase();
      if (!toolName) {
        return null;
      }

      console.log(`[copilot-sdk][intercept] onPreToolUse will match tool=${toolName}`);

      if (interceptEnabled && interceptTools.has(toolName)) {
        try {
          console.log(`[copilot-sdk][intercept] onPreToolUse matched tool=${toolName}`);
          const interceptResult = await requestInterceptDecision({
            input,
            toolName,
            config,
            workDir,
          });
          const permission = mapInterceptDecisionToPermission(interceptResult, `tool ${toolName} intercepted`);
          console.log(
            `[copilot-sdk][intercept] onPreToolUse resolved tool=${toolName} permission=${permission.permissionDecision}`,
          );
          return permission;
        } catch (error) {
          const reason = `intercept request failed: ${String(error?.message ?? error)}`;
          console.warn(`[copilot-sdk][intercept] onPreToolUse failed tool=${toolName} reason=${reason}`);
          if (config.interceptFailOpen) {
            console.warn(`[copilot-sdk][intercept] fail-open allow tool=${toolName}`);
            return {
              permissionDecision: "allow",
              permissionDecisionReason: `${reason}; fail-open enabled`,
            };
          }
          return {
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          };
        }
      }

      if (blockedTools.has(toolName)) {
        return {
          permissionDecision: "deny",
          permissionDecisionReason: `Tool \"${toolName}\" is blocked by COPILOT_BLOCKED_TOOLS`,
        };
      }

      if (allowedDirs.length > 0 && restrictedDirTools.has(toolName)) {
        const pathCandidates = collectPathCandidates(input?.toolArgs);
        const blocked = pathCandidates.find((candidate) => {
          const resolved = path.isAbsolute(candidate)
            ? path.resolve(candidate)
            : path.resolve(workDir, candidate);
          return !isPathInsideAllowedDirs(resolved, allowedDirs);
        });

        if (blocked) {
          return {
            permissionDecision: "deny",
            permissionDecisionReason: `Path \"${blocked}\" is outside COPILOT_ALLOWED_DIRS`,
          };
        }
      }

      if (config.askBeforeDestructive && destructiveTools.has(toolName)) {
        return { permissionDecision: "ask" };
      }

      return { permissionDecision: "allow" };
    },
    onPostToolUse: async (input, invocation) => {
      const toolName = String(input?.toolName ?? "").trim().toLowerCase() || "unknown";
      const safeArgs = safeCloneToolArgs(input?.toolArgs);
      const safeResult = safeCloneToolArgs(input?.toolResult);
      const sessionId = String(invocation?.sessionId ?? input?.sessionId ?? "").trim() || "-";

      console.log(`[${sessionId}] Tool: ${toolName}`);
      console.log(`  Args: ${safeStringify(safeArgs)}`);
      console.log(`  Result: ${safeStringify(safeResult)}`);

      try {
        await reportPostToolUseEvent({
          input,
          invocation,
          config,
          workDir,
        });
      } catch (error) {
        console.warn(
          `[copilot-sdk][intercept] onPostToolUse upload failed tool=${toolName} reason=${String(error?.message ?? error)}`,
        );
      }

      return null;
    },
    onSessionStart: async (input, invocation) => {
      const sessionId = String(invocation?.sessionId ?? input?.sessionId ?? "").trim() || "-";
      console.log(`[copilot-sdk][session] start sessionId=${sessionId}`);
      try {
        await reportSessionLifecycleEvent({
          phase: "start",
          input,
          invocation,
          config,
          workDir,
        });
      } catch (error) {
        console.warn(
          `[copilot-sdk][intercept] onSessionStart upload failed sessionId=${sessionId} reason=${String(error?.message ?? error)}`,
        );
      }
      return null;
    },
    onSessionEnd: async (input, invocation) => {
      const sessionId = String(invocation?.sessionId ?? input?.sessionId ?? "").trim() || "-";
      console.log(`[copilot-sdk][session] end sessionId=${sessionId}`);
      try {
        await reportSessionLifecycleEvent({
          phase: "end",
          input,
          invocation,
          config,
          workDir,
        });
      } catch (error) {
        console.warn(
          `[copilot-sdk][intercept] onSessionEnd upload failed sessionId=${sessionId} reason=${String(error?.message ?? error)}`,
        );
      }
      return null;
    },
  };
}

async function buildSessionConfig(config) {
  const skillDirectories = await getSkillDirectoriesForSession({
    workDir: config.workDir || process.cwd(),
    skillsFile: config.skillsFile,
  });
  const { mcpServers } = await loadMcpServersForCopilot({
    workDir: config.workDir || process.cwd(),
    mcpConfigFile: config.mcpConfigFile,
  });

  const sessionConfig: any = {
    onPermissionRequest: resolvePermissionHandler(config),
    workingDirectory: config.workDir || process.cwd(),
    streaming: true,
    skillDirectories,
    mcpServers,
    hooks: buildCopilotHooks(config),
  };

  if (config.model) {
    sessionConfig.model = config.model;
  }

  return sessionConfig;
}

function makeSessionSignature({ skillDirectories, mcpServers }) {
  return JSON.stringify({
    skillDirectories: Array.isArray(skillDirectories) ? skillDirectories : [],
    mcpServers: mcpServers && typeof mcpServers === "object" ? mcpServers : {},
  });
}

async function ensureSdkClient(config) {
  const cwd = config.workDir || process.cwd();

  if (sdkClient && sdkClientCwd === cwd) {
    return sdkClient;
  }

  if (sdkClient) {
    await stopCopilotClient();
  }

  sdkClient = new CopilotClient({
    cwd,
    autoStart: true,
    useLoggedInUser: true,
    logLevel: "info",
  });
  await sdkClient.start();
  sdkClientCwd = cwd;
  console.log(`[copilot-sdk] client started cwd=${cwd}`);
  return sdkClient;
}

function normalizeOutput(event) {
  return String(event?.data?.content ?? "").trim();
}

function isSessionNotFoundError(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return message.includes("session not found");
}

async function createOrResumeSession({ client, config, resumeSessionId = "" }) {
  const sessionConfig = await buildSessionConfig(config);

  if (resumeSessionId) {
    return client.resumeSession(resumeSessionId, sessionConfig);
  }

  return client.createSession(sessionConfig);
}

async function runSessionPrompt({ session, prompt, timeoutMs, onDelta, onDone }) {
  const startedAt = Date.now();
  console.log(
    `[copilot-sdk] send prompt sessionId=${session.sessionId} timeoutMs=${timeoutMs}`,
  );

  let streamedOutput = "";
  const unsubscribeDelta = typeof onDelta === "function"
    ? session.on("assistant.message_delta", (event) => {
        const delta = String(event?.data?.deltaContent ?? "");
        if (!delta) {
          return;
        }
        streamedOutput += delta;
        onDelta(delta);
      })
    : null;

  try {
    const event = await session.sendAndWait({ prompt }, timeoutMs);
    const output = normalizeOutput(event) || streamedOutput.trim();
    const elapsedMs = Date.now() - startedAt;

    console.log(
      `[copilot-sdk] done sessionId=${session.sessionId} elapsedMs=${elapsedMs} outputChars=${output.length}`,
    );

    const result = { output, sessionId: session.sessionId };
    if (typeof onDone === "function") {
      onDone(result);
    }
    return result;
  } finally {
    if (unsubscribeDelta) {
      unsubscribeDelta();
    }
  }
}

/**
 * Run copilot using SDK and return text output.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {object} options.config
 * @param {string} [options.resumeSessionId]
 * @returns {Promise<string>}
 */
export async function runCopilot({ prompt, config, resumeSessionId = "" }) {
  const { output } = await runCopilotWithSession({
    prompt,
    config,
    resumeSessionId,
  });
  return output;
}

/**
 * Run copilot using SDK and return both output and sessionId.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {object} options.config
 * @param {string} [options.resumeSessionId]
 * @returns {Promise<{ output: string, sessionId: string }>}
 */
export async function runCopilotWithSession({
  prompt,
  config,
  resumeSessionId = "",
  onDelta = undefined,
  onDone = undefined,
}) {
  const client = await ensureSdkClient(config);
  let effectiveResumeSessionId = resumeSessionId;
  let retried = false;

  while (true) {
    const session = await createOrResumeSession({
      client,
      config,
      resumeSessionId: effectiveResumeSessionId,
    });

    try {
      const result = await runSessionPrompt({
        session,
        prompt,
        timeoutMs: config.timeoutMs,
        onDelta,
        onDone,
      });

      try {
        await reportSessionTokenEstimateEvent({
          sessionId: result.sessionId,
          prompt,
          output: result.output,
          config,
          workDir: config.workDir || process.cwd(),
          entries: [prompt, result.output],
        });
      } catch (error) {
        console.warn(
          `[copilot-sdk][intercept] token estimate upload failed sessionId=${result.sessionId} reason=${String(error?.message ?? error)}`,
        );
      }

      return result;
    } catch (error) {
      if (!retried && isSessionNotFoundError(error)) {
        retried = true;
        effectiveResumeSessionId = "";
        console.warn("[copilot-sdk] session not found, retry once with a new session");
      } else {
        throw error;
      }
    } finally {
      await session.disconnect().catch(() => {});
    }
  }
}

export function getSharedCopilotSessionId() {
  return getSharedSessionIdForKey(DEFAULT_SHARED_SESSION_KEY);
}

export function setSharedCopilotSessionId(sessionId, sessionKey = DEFAULT_SHARED_SESSION_KEY) {
  setSharedSessionIdForKey(sessionKey, sessionId);
  sharedSessions.delete(normalizeSessionKey(sessionKey));
}

export function resetSharedCopilotSessionId(sessionKey = "") {
  if (sessionKey) {
    void disconnectSharedSessionForKey(sessionKey);
    return;
  }

  void resetAllSharedSessions();
}

async function getOrCreateSharedSession(config, sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  const client = await ensureSdkClient(config);
  const sessionConfig = await buildSessionConfig(config);
  const nextSkillSignature = makeSessionSignature({
    skillDirectories: sessionConfig.skillDirectories,
    mcpServers: sessionConfig.mcpServers,
  });

  const existingSession = sharedSessions.get(key) || null;
  const existingSignature = sharedSkillSignatures.get(key) || "";
  if (existingSession && existingSignature !== nextSkillSignature) {
    await disconnectSharedSessionForKey(key);
  }

  const currentSession = sharedSessions.get(key) || null;
  if (currentSession) {
    return currentSession;
  }

  const resumeSessionId = getSharedSessionIdForKey(key);
  const session = resumeSessionId
    ? await client.resumeSession(resumeSessionId, sessionConfig)
    : await client.createSession(sessionConfig);

  sharedSessions.set(key, session);
  setSharedSessionIdForKey(key, session.sessionId);
  sharedSkillSignatures.set(key, nextSkillSignature);
  return session;
}

/**
 * Run copilot with one shared reusable session across the current process.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {object} options.config
 * @returns {Promise<{ output: string, sessionId: string }>}
 */
export async function runCopilotWithSharedSession({
  prompt,
  config,
  sessionKey = DEFAULT_SHARED_SESSION_KEY,
  onDelta = undefined,
  onDone = undefined,
}) {
  if (!config?.reuseSession) {
    return runCopilotWithSession({
      prompt,
      config,
      onDelta,
      onDone,
    });
  }

  const key = normalizeSessionKey(sessionKey);

  return withSharedSessionLock(key, async () => {
    let retried = false;

    while (true) {
      try {
        const session = await getOrCreateSharedSession(config, key);
        const result = await runSessionPrompt({
          session,
          prompt,
          timeoutMs: config.timeoutMs,
          onDelta,
          onDone,
        });

        try {
          await reportSessionTokenEstimateEvent({
            sessionId: result.sessionId,
            prompt,
            output: result.output,
            config,
            workDir: config.workDir || process.cwd(),
            entries: [prompt, result.output],
          });
        } catch (error) {
          console.warn(
            `[copilot-sdk][intercept] token estimate upload failed sessionId=${result.sessionId} reason=${String(error?.message ?? error)}`,
          );
        }

        setSharedSessionIdForKey(key, result.sessionId);
        return result;
      } catch (error) {
        await disconnectSharedSessionForKey(key);

        if (!retried && isSessionNotFoundError(error)) {
          retried = true;
          console.warn("[copilot-sdk] shared session not found, recreate and retry once");
          continue;
        }

        throw error;
      }
    }
  });
}

export async function stopCopilotClient() {
  await resetAllSharedSessions();

  if (!sdkClient) {
    return;
  }

  const errors = await sdkClient.stop().catch(() => []);
  if (Array.isArray(errors) && errors.length > 0) {
    console.warn(`[copilot-sdk] client stop returned ${errors.length} cleanup errors`);
  }

  sdkClient = null;
  sdkClientCwd = "";
  sharedSessions = new Map();
  sharedCopilotSessionIds = new Map();
  sharedSessionQueues = new Map();
  sharedSkillSignatures = new Map();
}
