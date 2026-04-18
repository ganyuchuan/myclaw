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

function resolveTargets(config) {
  const configured = config?.targets;
  const fallback = {
    gateway: [String(config?.pm2GatewayName ?? "").trim()],
    bridge: [String(config?.pm2BridgeName ?? "").trim()],
    all: [String(config?.pm2BridgeName ?? "").trim(), String(config?.pm2GatewayName ?? "").trim()],
  };

  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    return {
      gateway: uniqueNonEmpty(fallback.gateway),
      bridge: uniqueNonEmpty(fallback.bridge),
      all: uniqueNonEmpty(fallback.all),
    };
  }

  const result = {};
  for (const [target, namesRaw] of Object.entries(configured)) {
    const normalizedTarget = String(target ?? "").trim().toLowerCase();
    if (!normalizedTarget) {
      continue;
    }

    const names = Array.isArray(namesRaw)
      ? namesRaw.map((item) => String(item ?? "").trim()).filter(Boolean)
      : String(namesRaw ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);

    if (names.length > 0) {
      result[normalizedTarget] = uniqueNonEmpty(names);
    }
  }

  return {
    ...fallback,
    ...result,
    gateway: uniqueNonEmpty(result.gateway ?? fallback.gateway),
    bridge: uniqueNonEmpty(result.bridge ?? fallback.bridge),
    all: uniqueNonEmpty(result.all ?? fallback.all),
  };
}

function resolveServiceNames(target, config) {
  const targets = resolveTargets(config);
  const serviceNames = targets[target];
  if (!Array.isArray(serviceNames) || serviceNames.length === 0) {
    const availableTargets = Object.keys(targets)
      .sort()
      .join(", ");
    throw new Error(`target is not configured: ${target}. available targets: ${availableTargets}`);
  }
  return uniqueNonEmpty(serviceNames);
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

export async function runServiceAction({ action = "", target = "", lines = 50, config = {} }) {
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
      target: "",
      serviceNames: [],
      results: [],
    };
  }

  const normalizedTarget = String(target ?? "").trim().toLowerCase();
  if (!normalizedTarget) {
    throw new Error(`service.${normalizedAction} target is required`);
  }

  const serviceNames = resolveServiceNames(normalizedTarget, config);
  if (serviceNames.length === 0) {
    throw new Error(`service names are not configured for target: ${normalizedTarget}`);
  }

  const results = [];
  for (const serviceName of serviceNames) {
    const commandResult = await runPm2({
      pm2Bin,
      args: buildServiceArgs(normalizedAction, serviceName, logLines),
      timeoutMs,
      cwd,
    });

    results.push({
      serviceName,
      ...commandResult,
    });
  }

  const ok = results.every((item) => item.ok);
  const output = results
    .map((item) => `[${item.serviceName}] ${item.output || (item.ok ? normalizedAction : "failed")}`)
    .join("\n")
    .trim();

  return {
    ok,
    action: normalizedAction,
    target: normalizedTarget,
    pm2Bin,
    serviceNames,
    results,
    output,
  };
}

export async function restartService({ target = "", config = {} }) {
  return runServiceAction({
    action: "restart",
    target,
    config,
  });
}
