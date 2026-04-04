import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const port = toInt(process.env.SYNC_PORT, 18790);
const dbFile = process.env.SYNC_DB_FILE?.trim() || "data/cron-sync-db.json";

function ensureStoreShape(raw) {
  if (!raw || typeof raw !== "object") {
    return { jobs: {}, runs: [] };
  }
  const jobs = raw.jobs && typeof raw.jobs === "object" ? raw.jobs : {};
  const runs = Array.isArray(raw.runs) ? raw.runs : [];
  return { jobs, runs };
}

function loadStore() {
  try {
    const raw = fs.readFileSync(dbFile, "utf8");
    return ensureStoreShape(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { jobs: {}, runs: [] };
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  try {
    if (req.method === "GET" && pathname === "/health") {
      const store = loadStore();
      return json(res, 200, {
        ok: true,
        service: "myclaw-sync-server",
        jobs: Object.keys(store.jobs).length,
        runs: store.runs.length,
      });
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

server.listen(port, "127.0.0.1", () => {
  console.log(`[sync-server] listening on http://127.0.0.1:${port}`);
  console.log(`[sync-server] db file: ${dbFile}`);
});
