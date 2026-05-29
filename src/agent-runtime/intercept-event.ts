function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(url: unknown) {
  return String(url ?? "").trim().replace(/\/+$/, "");
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

export async function reportInterceptEventByApi({
  interceptServerUrl,
  interceptAuthToken = "",
  interceptTimeoutMs = 5000,
  event,
}: {
  interceptServerUrl: string;
  interceptAuthToken?: string;
  interceptTimeoutMs?: number;
  event: Record<string, unknown>;
}) {
  const normalizedServerUrl = trimTrailingSlash(interceptServerUrl);
  if (!normalizedServerUrl) {
    throw new Error("intercept server url is required");
  }

  if (!event || typeof event !== "object") {
    throw new Error("intercept event payload is required");
  }

  const normalizedAuthToken = String(interceptAuthToken ?? "").trim();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (normalizedAuthToken) {
    headers.Authorization = `Bearer ${normalizedAuthToken}`;
  }

  return fetchJsonWithTimeout(`${normalizedServerUrl}/api/copilot/intercepts/event`, {
    method: "POST",
    headers,
    timeoutMs: toPositiveInt(interceptTimeoutMs, 5000),
    body: JSON.stringify({ event }),
  });
}
