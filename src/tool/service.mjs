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

function resolveServiceNames(target, config) {
  const gatewayName = String(config?.pm2GatewayName ?? "").trim();
  const bridgeName = String(config?.pm2BridgeName ?? "").trim();

  if (target === "gateway") {
    return uniqueNonEmpty([gatewayName]);
  }
  if (target === "bridge") {
    return uniqueNonEmpty([bridgeName]);
  }
  if (target === "all") {
    return uniqueNonEmpty([bridgeName, gatewayName]);
  }

  throw new Error("target must be one of: gateway, bridge, all");
}

async function restartOne({ pm2Bin, serviceName, timeoutMs, cwd }) {
  try {
    const { stdout, stderr } = await execFileAsync(pm2Bin, ["restart", serviceName, "--update-env"], {
      timeout: timeoutMs,
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });

    return {
      serviceName,
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
      serviceName,
      ok: false,
      stdout,
      stderr,
      output: `${stdout}${stderr}`.trim() || message,
      error: message,
      exitCode: Number.isInteger(error?.code) ? error.code : -1,
    };
  }
}

export async function restartService({ target = "", config = {} }) {
  const normalizedTarget = String(target ?? "").trim().toLowerCase();
  if (!normalizedTarget) {
    throw new Error("service.restart target is required");
  }

  const serviceNames = resolveServiceNames(normalizedTarget, config);
  if (serviceNames.length === 0) {
    throw new Error(`service names are not configured for target: ${normalizedTarget}`);
  }

  const pm2Bin = String(config.pm2Bin ?? "pm2").trim() || "pm2";
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 30_000;
  const cwd = config.workDir || process.cwd();

  const results = [];
  for (const serviceName of serviceNames) {
    const result = await restartOne({
      pm2Bin,
      serviceName,
      timeoutMs,
      cwd,
    });
    results.push(result);
  }

  const ok = results.every((item) => item.ok);
  const output = results
    .map((item) => `[${item.serviceName}] ${item.output || (item.ok ? "restarted" : "failed")}`)
    .join("\n")
    .trim();

  return {
    ok,
    target: normalizedTarget,
    pm2Bin,
    serviceNames,
    results,
    output,
  };
}
