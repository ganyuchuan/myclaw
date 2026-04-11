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
    streaming: true,
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

function isSessionNotFoundError(error) {
  const message = String(error?.message ?? error).toLowerCase();
  return message.includes("session not found");
}

async function createOrResumeSession({ client, config, resumeSessionId = "" }) {
  const sessionConfig = buildSessionConfig(config);

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

  let output = "";
  try {
    const event = await session.sendAndWait({ prompt }, timeoutMs);
    output = normalizeOutput(event) || streamedOutput.trim();
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
}
