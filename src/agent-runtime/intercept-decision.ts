import crypto from "node:crypto";

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(url: unknown) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

function shortId(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "-";
  }
  return text.length <= 14 ? text : `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function normalizeInterceptDecision(value: unknown, fallback = "deny") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["allow", "deny", "ask", "wait", "waiting", "approved", "denied", "expired", "timeout"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

export function createInterceptRequestIdFromCandidates(candidates: unknown[]) {
  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return `perm_${crypto.randomUUID()}`;
}

async function fetchJsonWithTimeout(
  url: string,
  { method = "GET", headers = {}, body = undefined, timeoutMs = 5000 }: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | undefined;
    timeoutMs?: number;
  } = {},
): Promise<any> {
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
      throw new Error(`http ${response.status}: ${String(payload?.error ?? response.statusText)}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollInterceptDecision({
  interceptServerUrl,
  interceptAuthToken,
  requestId,
  interceptTimeoutMs,
  interceptPollIntervalMs,
  interceptMaxWaitMs,
  logPrefix,
}: {
  interceptServerUrl: string;
  interceptAuthToken: string;
  requestId: string;
  interceptTimeoutMs: number;
  interceptPollIntervalMs: number;
  interceptMaxWaitMs: number;
  logPrefix: string;
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
    `${logPrefix} poll start requestId=${shortId(requestId)} intervalMs=${interceptPollIntervalMs} maxWaitMs=${interceptMaxWaitMs}`,
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
    );

    const status = normalizeInterceptDecision(payload?.status, "waiting");
    const decision = normalizeInterceptDecision(payload?.decision, "wait");
    if (attempts === 1 || attempts % 5 === 0 || status !== "waiting") {
      console.log(
        `${logPrefix} poll tick requestId=${shortId(requestId)} attempt=${attempts} status=${status} decision=${decision}`,
      );
    }

    if (["allow", "approved"].includes(decision) || status === "approved") {
      console.log(
        `${logPrefix} poll resolved allow requestId=${shortId(requestId)} attempts=${attempts} elapsedMs=${Date.now() - startedAt}`,
      );
      return {
        decision: "allow",
        reason: payload?.reason || "approved by intercept server",
      };
    }

    if (["deny", "denied", "expired", "timeout"].includes(decision) || ["denied", "expired", "timeout"].includes(status)) {
      console.log(
        `${logPrefix} poll resolved deny requestId=${shortId(requestId)} attempts=${attempts} status=${status} elapsedMs=${Date.now() - startedAt}`,
      );
      return {
        decision: "deny",
        reason: payload?.reason || `intercept ${status}`,
      };
    }

    await sleep(interceptPollIntervalMs);
  }

  console.warn(
    `${logPrefix} poll timeout requestId=${shortId(requestId)} attempts=${attempts} elapsedMs=${Date.now() - startedAt}`,
  );

  return {
    decision: "deny",
    reason: `intercept decision timeout after ${interceptMaxWaitMs}ms`,
  };
}

export async function requestInterceptDecisionByApi({
  interceptServerUrl,
  interceptAuthToken = "",
  interceptTimeoutMs = 20000,
  interceptPollIntervalMs = 3000,
  interceptMaxWaitMs = 60000,
  request,
  logPrefix = "[intercept]",
}: {
  interceptServerUrl: string;
  interceptAuthToken?: string;
  interceptTimeoutMs?: number;
  interceptPollIntervalMs?: number;
  interceptMaxWaitMs?: number;
  request: {
    requestIdCandidates?: unknown[];
    toolName: string;
    hint?: string;
    msg?: string;
    sessionId?: string | null;
    workDir?: string;
    input?: unknown;
  };
  logPrefix?: string;
}) {
  const normalizedServerUrl = trimTrailingSlash(interceptServerUrl);
  const normalizedAuthToken = String(interceptAuthToken ?? "").trim();
  const normalizedTimeoutMs = toPositiveInt(interceptTimeoutMs, 5000);
  const normalizedPollIntervalMs = toPositiveInt(interceptPollIntervalMs, 1000);
  const normalizedMaxWaitMs = toPositiveInt(interceptMaxWaitMs, 30000);

  if (!normalizedServerUrl) {
    throw new Error("intercept server url is required");
  }

  const toolName = String(request?.toolName ?? "").trim().toLowerCase();
  if (!toolName) {
    throw new Error("intercept toolName is required");
  }

  const requestId = createInterceptRequestIdFromCandidates(
    Array.isArray(request?.requestIdCandidates) ? request.requestIdCandidates : [],
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (normalizedAuthToken) {
    headers.Authorization = `Bearer ${normalizedAuthToken}`;
  }

  console.log(
    `${logPrefix} pretool send requestId=${shortId(requestId)} tool=${toolName} server=${normalizedServerUrl}`,
  );

  const payload = await fetchJsonWithTimeout(`${normalizedServerUrl}/api/copilot/intercepts/pretool`, {
    method: "POST",
    headers,
    timeoutMs: normalizedTimeoutMs,
    body: JSON.stringify({
      request: {
        id: requestId,
        tool: toolName,
        hint: String(request?.hint ?? "").trim(),
        msg: String(request?.msg ?? `Intercepted tool ${toolName}`).trim() || `Intercepted tool ${toolName}`,
        sessionId: String(request?.sessionId ?? "").trim() || null,
        workDir: String(request?.workDir ?? "").trim(),
        input: request?.input ?? null,
        ts: Date.now(),
      },
    }),
  });

  const decision = normalizeInterceptDecision(payload?.decision, "deny");
  console.log(
    `${logPrefix} pretool decision requestId=${shortId(requestId)} tool=${toolName} decision=${decision}`,
  );

  if (decision !== "wait") {
    return {
      requestId,
      decision,
      reason: payload?.reason || payload?.msg || "intercept decision",
    };
  }

  console.log(
    `${logPrefix} pretool queued requestId=${shortId(requestId)} tool=${toolName} entering=poll`,
  );

  const pollResult = await pollInterceptDecision({
    interceptServerUrl: normalizedServerUrl,
    interceptAuthToken: normalizedAuthToken,
    requestId,
    interceptTimeoutMs: normalizedTimeoutMs,
    interceptPollIntervalMs: normalizedPollIntervalMs,
    interceptMaxWaitMs: normalizedMaxWaitMs,
    logPrefix,
  });

  return {
    requestId,
    ...pollResult,
  };
}
