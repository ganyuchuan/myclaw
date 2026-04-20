import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function uniqueNonEmpty(list) {
  const result = [];
  const seen = new Set();
  for (const item of list) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function resolveWhitelistedServiceName(name, config) {
  const rawName = String(name ?? "").trim();
  if (!rawName) {
    throw new Error("service name is required");
  }

  const whitelist = uniqueNonEmpty(Array.isArray(config?.whitelist) ? config.whitelist : []);
  if (whitelist.length === 0) {
    throw new Error("service whitelist is empty, no service actions are allowed");
  }

  const matched = whitelist.find((item) => item.toLowerCase() === rawName.toLowerCase());
  if (!matched) {
    throw new Error(`service is not allowed: ${rawName}. whitelist: ${whitelist.join(", ")}`);
  }

  return matched;
}

async function runPm2({ pm2Bin, args, timeoutMs, cwd }) {
  try {
    const { stdout, stderr } = await execFileAsync(pm2Bin, args, {
      timeout: timeoutMs,
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });

    return {
      ok: true,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      output: String(stdout ?? "").trim() || String(stderr ?? "").trim(),
      exitCode: 0,
    };
  } catch (error) {
    const stdout = String(error?.stdout ?? "");
    const stderr = String(error?.stderr ?? "");
    const message = String(error?.message ?? error);
    return {
      ok: false,
      stdout,
      stderr,
      output: `${stdout}${stderr}`.trim() || message,
      error: message,
      exitCode: Number.isInteger(error?.code) ? error.code : -1,
    };
  }
}

function normalizeAction(action) {
  const normalized = String(action ?? "").trim().toLowerCase();
  if (["list", "start", "stop", "restart", "logs"].includes(normalized)) {
    return normalized;
  }
  throw new Error("service action must be one of: list, start, stop, restart, logs");
}

function buildServiceArgs(action, serviceName, lines) {
  if (action === "restart") {
    return ["restart", serviceName, "--update-env"];
  }
  if (action === "logs") {
    return ["logs", serviceName, "--lines", String(lines), "--nostream"];
  }
  return [action, serviceName];
}

export async function runServiceAction({ action = "", name = "", lines = 50, config = {} }) {
  const normalizedAction = normalizeAction(action);

  const pm2Bin = String(config.pm2Bin ?? "pm2").trim() || "pm2";
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 30_000;
  const cwd = config.workDir || process.cwd();
  const logLines = Number.isFinite(Number(lines)) && Number(lines) > 0 ? Number.parseInt(String(lines), 10) : 50;

  if (normalizedAction === "list") {
    const result = await runPm2({
      pm2Bin,
      args: ["list"],
      timeoutMs,
      cwd,
    });

    return {
      ...result,
      action: normalizedAction,
      name: "",
      serviceName: "",
      results: [],
    };
  }

  const serviceName = resolveWhitelistedServiceName(name, config);
  const commandResult = await runPm2({
    pm2Bin,
    args: buildServiceArgs(normalizedAction, serviceName, logLines),
    timeoutMs,
    cwd,
  });

  const results = [{ serviceName, ...commandResult }];
  const ok = commandResult.ok;
  const output = `[${serviceName}] ${commandResult.output || (ok ? normalizedAction : "failed")}`.trim();

  return {
    ok,
    action: normalizedAction,
    name: serviceName,
    pm2Bin,
    serviceName,
    results,
    output,
  };
}

export async function restartService({ name = "", config = {} }) {
  return runServiceAction({
    action: "restart",
    name,
    config,
  });
}
