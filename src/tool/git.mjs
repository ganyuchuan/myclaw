import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_ALLOWED_COMMANDS = [
  "status",
  "log",
  "diff",
  "add",
  "commit",
  "pull",
  "push",
  "fetch",
  "branch",
  "checkout",
  "switch",
  "restore",
  "show",
  "remote",
  "tag",
  "rev-parse",
];

function parseArgsFromCommand(commandText) {
  const text = String(commandText ?? "").trim();
  if (!text) {
    return [];
  }

  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1].replace(/\\"/g, '"'));
      continue;
    }
    if (match[2] !== undefined) {
      tokens.push(match[2].replace(/\\'/g, "'"));
      continue;
    }
    tokens.push(match[0]);
  }

  return tokens;
}

function normalizeArgs({ command = "", args }) {
  if (Array.isArray(args) && args.length > 0) {
    return args.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  return parseArgsFromCommand(command);
}

function resolveAllowedCommands(config) {
  const configured = Array.isArray(config?.allowedCommands)
    ? config.allowedCommands.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)
    : [];
  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_COMMANDS);
}

function findGitSubcommand(args) {
  for (const item of args) {
    if (!String(item).startsWith("-")) {
      return String(item).toLowerCase();
    }
  }
  return "";
}

export async function runGitCommand({ command = "", args, config = {} }) {
  const normalizedArgs = normalizeArgs({ command, args });
  if (normalizedArgs.length === 0) {
    throw new Error("git args are required");
  }

  const subcommand = findGitSubcommand(normalizedArgs);
  if (!subcommand) {
    throw new Error("git subcommand is required");
  }

  const allowed = resolveAllowedCommands(config);
  if (!allowed.has(subcommand)) {
    throw new Error(`git subcommand is not allowed: ${subcommand}`);
  }

  const cwd = config.workDir || process.cwd();
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 30_000;

  try {
    const { stdout, stderr } = await execFileAsync("git", normalizedArgs, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });

    return {
      ok: true,
      args: normalizedArgs,
      subcommand,
      cwd,
      output: String(stdout ?? "").trim() || String(stderr ?? "").trim(),
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      exitCode: 0,
    };
  } catch (error) {
    const stdout = String(error?.stdout ?? "");
    const stderr = String(error?.stderr ?? "");
    const message = String(error?.message ?? error);

    return {
      ok: false,
      args: normalizedArgs,
      subcommand,
      cwd,
      output: `${stdout}${stderr}`.trim() || message,
      stdout,
      stderr,
      exitCode: Number.isInteger(error?.code) ? error.code : -1,
      error: message,
    };
  }
}
