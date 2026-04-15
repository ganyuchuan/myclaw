import { CopilotClient, approveAll } from "@github/copilot-sdk";
import path from "node:path";
import { getSkillDirectoriesForSession } from "./skills.mjs";
import { loadMcpServersForCopilot } from "./mcp.mjs";

let sharedCopilotSessionId = "";
let sharedSessionQueue = Promise.resolve();
let sdkClient = null;
let sdkClientCwd = "";
let sharedSession = null;
let sharedSkillSignature = "";

function withSharedSessionLock(task) {
  const run = sharedSessionQueue.then(task, task);
  // Keep queue alive even when one task fails.
  sharedSessionQueue = run.catch(() => {});
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

function buildCopilotHooks(config) {
  if (!config?.hookEnabled) {
    return undefined;
  }

  const workDir = path.resolve(config.workDir || process.cwd());
  const blockedTools = normalizeSet(config.blockedTools, []);
  const restrictedDirTools = normalizeSet(config.restrictedDirTools, DEFAULT_RESTRICTED_DIR_TOOLS);
  const destructiveTools = normalizeSet(config.destructiveTools, DEFAULT_DESTRUCTIVE_TOOLS);
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

  const sessionConfig = {
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
  onDelta,
  onDone,
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
      return await runSessionPrompt({
        session,
        prompt,
        timeoutMs: config.timeoutMs,
        onDelta,
        onDone,
      });
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
  return sharedCopilotSessionId;
}

export function setSharedCopilotSessionId(sessionId) {
  const normalized = String(sessionId ?? "").trim();
  sharedCopilotSessionId = normalized;
  sharedSession = null;
}

export function resetSharedCopilotSessionId() {
  sharedCopilotSessionId = "";
  sharedSessionQueue = Promise.resolve();
  sharedSkillSignature = "";
  if (sharedSession) {
    void sharedSession.disconnect().catch(() => {});
  }
  sharedSession = null;
}

async function getOrCreateSharedSession(config) {
  const client = await ensureSdkClient(config);
  const sessionConfig = await buildSessionConfig(config);
  const nextSkillSignature = makeSessionSignature({
    skillDirectories: sessionConfig.skillDirectories,
    mcpServers: sessionConfig.mcpServers,
  });

  if (sharedSession && sharedSkillSignature !== nextSkillSignature) {
    await sharedSession.disconnect().catch(() => {});
    sharedSession = null;
    sharedCopilotSessionId = "";
  }

  if (sharedSession) {
    return sharedSession;
  }

  sharedSession = sharedCopilotSessionId
    ? await client.resumeSession(sharedCopilotSessionId, sessionConfig)
    : await client.createSession(sessionConfig);

  sharedCopilotSessionId = sharedSession.sessionId;
  sharedSkillSignature = nextSkillSignature;
  return sharedSession;
}

/**
 * Run copilot with one shared reusable session across the current process.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {object} options.config
 * @returns {Promise<{ output: string, sessionId: string }>}
 */
export async function runCopilotWithSharedSession({ prompt, config, onDelta, onDone }) {
  if (!config?.reuseSession) {
    return runCopilotWithSession({
      prompt,
      config,
      onDelta,
      onDone,
    });
  }

  return withSharedSessionLock(async () => {
    let retried = false;

    while (true) {
      try {
        const session = await getOrCreateSharedSession(config);
        const result = await runSessionPrompt({
          session,
          prompt,
          timeoutMs: config.timeoutMs,
          onDelta,
          onDone,
        });
        sharedCopilotSessionId = result.sessionId;
        return result;
      } catch (error) {
        if (sharedSession) {
          await sharedSession.disconnect().catch(() => {});
        }
        sharedSession = null;

        if (!retried && isSessionNotFoundError(error)) {
          retried = true;
          sharedCopilotSessionId = "";
          console.warn("[copilot-sdk] shared session not found, recreate and retry once");
          continue;
        }

        throw error;
      }
    }
  });
}

export async function stopCopilotClient() {
  if (sharedSession) {
    await sharedSession.disconnect().catch(() => {});
    sharedSession = null;
  }

  if (!sdkClient) {
    return;
  }

  const errors = await sdkClient.stop().catch(() => []);
  if (Array.isArray(errors) && errors.length > 0) {
    console.warn(`[copilot-sdk] client stop returned ${errors.length} cleanup errors`);
  }

  sdkClient = null;
  sdkClientCwd = "";
  sharedCopilotSessionId = "";
  sharedSessionQueue = Promise.resolve();
  sharedSkillSignature = "";
}
