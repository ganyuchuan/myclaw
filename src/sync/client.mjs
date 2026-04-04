function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

export function createSyncClient(config) {
  const baseUrl = trimTrailingSlash(config.serverUrl || "http://127.0.0.1:18790");
  const timeoutMs = config.timeoutMs || 5000;
  const nodeId = config.nodeId || "myclaw-local";

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`sync request failed (${response.status}): ${text.slice(0, 500)}`);
      }

      if (response.status === 204) {
        return null;
      }

      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async upsertJob(job) {
      const id = encodeURIComponent(String(job?.id ?? ""));
      if (!id) {
        return;
      }
      await request("PUT", `/api/jobs/${id}`, { job: { ...job, nodeId } });
    },

    async removeJob(id) {
      const encoded = encodeURIComponent(String(id ?? ""));
      if (!encoded) {
        return;
      }
      await request("DELETE", `/api/jobs/${encoded}`);
    },

    async appendRun(run) {
      await request("POST", "/api/runs", {
        run: { ...run, nodeId },
      });
    },

    async health() {
      return request("GET", "/health");
    },
  };
}
