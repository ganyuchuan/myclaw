import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Cron } from "croner";

// ─── Data Model ──────────────────────────────────────────────────────────────

/**
 * Job shape (persisted JSON):
 * {
 *   id: string,
 *   name: string,
 *   enabled: boolean,
 *   schedule: { type: "at"|"every"|"cron", value: string|number },
 *   payload: { action: "copilot"|"log", params: object },
 *   state: {
 *     nextRunAtMs: number|null,
 *     lastRunAtMs: number|null,
 *     lastStatus: "ok"|"error"|null,
 *     lastError: string|null,
 *     runningAtMs: number|null,
 *     runCount: number,
 *   },
 *   createdAtMs: number,
 *   updatedAtMs: number,
 * }
 */

function makeDefaultState() {
  return {
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastStatus: null,
    lastError: null,
    runningAtMs: null,
    runCount: 0,
  };
}

// ─── nextRun Calculation ─────────────────────────────────────────────────────

function computeNextRun(schedule, now = Date.now()) {
  const { type, value } = schedule;

  if (type === "at") {
    const ts = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(ts)) {
      return null;
    }
    return ts > now ? ts : null; // one-shot; expired → null
  }

  if (type === "every") {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) {
      return null;
    }
    return now + ms;
  }

  if (type === "cron") {
    try {
      const job = new Cron(String(value));
      const next = job.nextRun(new Date(now));
      return next ? next.getTime() : null;
    } catch {
      return null;
    }
  }

  return null;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadJobs(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      return new Map();
    }
    const map = new Map();
    for (const job of arr) {
      if (job && typeof job.id === "string") {
        map.set(job.id, job);
      }
    }
    return map;
  } catch (err) {
    if (err.code === "ENOENT") {
      return new Map();
    }
    throw err;
  }
}

function saveJobs(filePath, jobs) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify([...jobs.values()], null, 2));
  fs.renameSync(tmp, filePath);
}

// ─── Executor ────────────────────────────────────────────────────────────────

async function executeJob(job, executors) {
  const action = job.payload?.action;
  const executor = executors[action];
  if (!executor) {
    throw new Error(`unknown action: ${action}`);
  }
  return executor(job.payload.params ?? {}, job);
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export function createCronScheduler(config) {
  const filePath = config.jobsFile;
  const jobTimeoutMs = config.jobTimeoutMs;
  const maxConcurrent = config.maxConcurrent;

  let jobs = loadJobs(filePath);
  let wakeTimer = null;
  let running = 0;
  let stopped = false;

  // Custom executors registered externally
  const executors = {};
  const completionListeners = new Set();

  // ── helpers ──

  const persist = () => saveJobs(filePath, jobs);

  const clearWakeTimer = () => {
    if (wakeTimer !== null) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
  };

  const scheduleWake = () => {
    clearWakeTimer();
    if (stopped) {
      return;
    }

    let earliest = Infinity;
    for (const job of jobs.values()) {
      if (
        job.enabled &&
        job.state.nextRunAtMs !== null &&
        job.state.runningAtMs === null
      ) {
        if (job.state.nextRunAtMs < earliest) {
          earliest = job.state.nextRunAtMs;
        }
      }
    }

    if (earliest === Infinity) {
      return;
    }

    const delay = Math.max(0, earliest - Date.now());
    wakeTimer = setTimeout(() => tick(), delay);
    // Prevent timer from blocking process exit
    if (wakeTimer.unref) {
      wakeTimer.unref();
    }
  };

  const tick = async () => {
    if (stopped) {
      return;
    }

    const now = Date.now();
    const dueJobs = [];
    for (const job of jobs.values()) {
      if (
        job.enabled &&
        job.state.nextRunAtMs !== null &&
        job.state.nextRunAtMs <= now &&
        job.state.runningAtMs === null
      ) {
        dueJobs.push(job);
      }
    }

    for (const job of dueJobs) {
      if (running >= maxConcurrent) {
        break;
      }
      runJob(job);
    }

    scheduleWake();
  };

  const notifyCompletionListeners = async (event) => {
    for (const listener of completionListeners) {
      try {
        await listener(event);
      } catch (error) {
        console.error(`[cron] completion listener failed: ${String(error?.message ?? error)}`);
      }
    }
  };

  const runJob = async (job, trigger = "scheduled") => {
    running++;
    job.state.runningAtMs = Date.now();
    persist();
    let output;

    const timeout = new Promise((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`job timeout after ${jobTimeoutMs}ms`)),
        jobTimeoutMs,
      );
      if (t.unref) {
        t.unref();
      }
    });

    try {
      output = await Promise.race([executeJob(job, executors), timeout]);
      job.state.lastStatus = "ok";
      job.state.lastError = null;
    } catch (err) {
      job.state.lastStatus = "error";
      job.state.lastError = String(err?.message ?? err).slice(0, 1000);
      console.error(`[cron] job ${job.id} (${job.name}) failed: ${job.state.lastError}`);
    } finally {
      job.state.lastRunAtMs = Date.now();
      job.state.runCount++;
      job.state.runningAtMs = null;

      // Recompute next run
      const next = computeNextRun(job.schedule);
      job.state.nextRunAtMs = next;
      // One-shot (at) tasks: disable after expiry
      if (job.schedule.type === "at" && next === null) {
        job.enabled = false;
      }
      job.updatedAtMs = Date.now();

      running--;
      persist();
      await notifyCompletionListeners({
        job: { ...job },
        trigger,
        status: job.state.lastStatus,
        error: job.state.lastError,
        output,
      });
      scheduleWake();
    }
  };

  // ── Recovery on startup ──
  const recoverOnStartup = () => {
    const now = Date.now();
    for (const job of jobs.values()) {
      // Clear stale running marks from previous crash
      if (job.state.runningAtMs !== null) {
        console.log(`[cron] clearing stale running mark on job ${job.id} (${job.name})`);
        job.state.runningAtMs = null;
      }
      // Recompute nextRun for enabled jobs
      if (job.enabled) {
        const next = computeNextRun(job.schedule, now);
        job.state.nextRunAtMs = next;
        if (job.schedule.type === "at" && next === null) {
          job.enabled = false;
        }
      }
    }
    persist();
  };

  // ── Public API (used by gateway methods) ──

  const list = () => {
    return [...jobs.values()].map((j) => ({ ...j }));
  };

  const add = ({ name, schedule, payload, enabled, notify }) => {
    if (!name || typeof name !== "string") {
      throw new Error("job name is required");
    }
    if (!schedule || !["at", "every", "cron"].includes(schedule.type)) {
      throw new Error("schedule.type must be at|every|cron");
    }
    if (schedule.value === undefined || schedule.value === null || schedule.value === "") {
      throw new Error("schedule.value is required");
    }
    if (!payload || typeof payload.action !== "string") {
      throw new Error("payload.action is required");
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const nextRunAtMs = enabled !== false ? computeNextRun(schedule, now) : null;

    const job = {
      id,
      name: String(name),
      enabled: enabled !== false,
      schedule: { type: schedule.type, value: schedule.value },
      payload: { action: payload.action, params: payload.params ?? {} },
      ...(notify && typeof notify === "object" && !Array.isArray(notify) ? { notify: { ...notify } } : {}),
      state: { ...makeDefaultState(), nextRunAtMs },
      createdAtMs: now,
      updatedAtMs: now,
    };

    jobs.set(id, job);
    persist();
    scheduleWake();
    return { ...job };
  };

  const update = (id, patch) => {
    const job = jobs.get(id);
    if (!job) {
      throw new Error(`job not found: ${id}`);
    }

    if (patch.name !== undefined) {
      job.name = String(patch.name);
    }
    if (patch.schedule !== undefined) {
      if (!["at", "every", "cron"].includes(patch.schedule.type)) {
        throw new Error("schedule.type must be at|every|cron");
      }
      job.schedule = { type: patch.schedule.type, value: patch.schedule.value };
    }
    if (patch.payload !== undefined) {
      job.payload = { action: patch.payload.action, params: patch.payload.params ?? {} };
    }
    if (patch.notify !== undefined) {
      if (patch.notify && typeof patch.notify === "object" && !Array.isArray(patch.notify)) {
        job.notify = { ...patch.notify };
      } else {
        delete job.notify;
      }
    }
    if (patch.enabled !== undefined) {
      job.enabled = Boolean(patch.enabled);
    }

    // Recompute next run
    if (job.enabled) {
      job.state.nextRunAtMs = computeNextRun(job.schedule);
    } else {
      job.state.nextRunAtMs = null;
    }

    job.updatedAtMs = Date.now();
    persist();
    scheduleWake();
    return { ...job };
  };

  const remove = (id) => {
    if (!jobs.has(id)) {
      throw new Error(`job not found: ${id}`);
    }
    jobs.delete(id);
    persist();
    scheduleWake();
    return { removed: true, id };
  };

  const run = async (id) => {
    const job = jobs.get(id);
    if (!job) {
      throw new Error(`job not found: ${id}`);
    }
    if (job.state.runningAtMs !== null) {
      throw new Error(`job ${id} is already running`);
    }

    await runJob(job, "manual");
    return {
      id: job.id,
      lastStatus: job.state.lastStatus,
      lastError: job.state.lastError,
      lastRunAtMs: job.state.lastRunAtMs,
      output: job.state.lastStatus === "ok" ? undefined : undefined,
    };
  };

  // ── Lifecycle ──

  const start = () => {
    stopped = false;
    recoverOnStartup();
    scheduleWake();
    console.log(`[cron] scheduler started, ${jobs.size} job(s) loaded from ${filePath}`);
  };

  const stop = () => {
    stopped = true;
    clearWakeTimer();
    console.log("[cron] scheduler stopped");
  };

  const registerExecutor = (action, fn) => {
    executors[action] = fn;
  };

  const onJobFinished = (listener) => {
    completionListeners.add(listener);
    return () => {
      completionListeners.delete(listener);
    };
  };

  return {
    list,
    add,
    update,
    remove,
    run,
    start,
    stop,
    registerExecutor,
    onJobFinished,
  };
}
