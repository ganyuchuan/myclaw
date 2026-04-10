import { CopilotClient, approveAll } from "@github/copilot-sdk";

let sharedCopilotSessionId = "";
let sharedSessionQueue = Promise.resolve();
let sdkClient = null;
let sdkClientCwd = "";
let sharedSession = null;

function withSharedSessionLock(task) {
  const run = sharedSessionQueue.then(task, task);
  // Keep queue alive even when one task fails.
  sharedSessionQueue = run.catch(() => {});
  return run;
}

function denyAllPermissions() {
  return { kind: "denied-by-rules" };
}

function buildSessionConfig(config) {
  const sessionConfig = {
    onPermissionRequest: config.allowAllTools ? approveAll : denyAllPermissions,
    workingDirectory: config.workDir || process.cwd(),
  };

  if (config.model) {
    sessionConfig.model = config.model;
  }

  return sessionConfig;
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

async function createOrResumeSession({ client, config, resumeSessionId = "" }) {
  const sessionConfig = buildSessionConfig(config);

  if (resumeSessionId) {
    return client.resumeSession(resumeSessionId, sessionConfig);
  }

  return client.createSession(sessionConfig);
}

async function runSessionPrompt({ session, prompt, timeoutMs }) {
  const startedAt = Date.now();
  console.log(
    `[copilot-sdk] send prompt sessionId=${session.sessionId} timeoutMs=${timeoutMs}`,
  );

  const event = await session.sendAndWait({ prompt }, timeoutMs);
  const output = normalizeOutput(event);
  const elapsedMs = Date.now() - startedAt;

  console.log(
    `[copilot-sdk] done sessionId=${session.sessionId} elapsedMs=${elapsedMs} outputChars=${output.length}`,
  );

  return { output, sessionId: session.sessionId };
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
export async function runCopilotWithSession({ prompt, config, resumeSessionId = "" }) {
  const client = await ensureSdkClient(config);
  const session = await createOrResumeSession({
    client,
    config,
    resumeSessionId,
  });

  try {
    return await runSessionPrompt({
      session,
      prompt,
      timeoutMs: config.timeoutMs,
    });
  } finally {
    await session.disconnect().catch(() => {});
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
  if (sharedSession) {
    void sharedSession.disconnect().catch(() => {});
  }
  sharedSession = null;
}

async function getOrCreateSharedSession(config) {
  const client = await ensureSdkClient(config);

  if (sharedSession) {
    return sharedSession;
  }

  const sessionConfig = buildSessionConfig(config);
  sharedSession = sharedCopilotSessionId
    ? await client.resumeSession(sharedCopilotSessionId, sessionConfig)
    : await client.createSession(sessionConfig);

  sharedCopilotSessionId = sharedSession.sessionId;
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
export async function runCopilotWithSharedSession({ prompt, config }) {
  if (!config?.reuseSession) {
    return runCopilotWithSession({
      prompt,
      config,
    });
  }

  return withSharedSessionLock(async () => {
    try {
      const session = await getOrCreateSharedSession(config);
      const result = await runSessionPrompt({
        session,
        prompt,
        timeoutMs: config.timeoutMs,
      });
      sharedCopilotSessionId = result.sessionId;
      return result;
    } catch (error) {
      if (sharedSession) {
        await sharedSession.disconnect().catch(() => {});
      }
      sharedSession = null;
      throw error;
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
}
