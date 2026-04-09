import { execFile } from "node:child_process";

let sharedCopilotSessionId = "";
let sharedSessionQueue = Promise.resolve();

function withSharedSessionLock(task) {
  const run = sharedSessionQueue.then(task, task);
  // Keep queue alive even when one task fails.
  sharedSessionQueue = run.catch(() => {});
  return run;
}

function buildCopilotArgs({ prompt, config, resumeSessionId, outputJson }) {
  const args = ["copilot", "-p", prompt, "-s", "--no-ask-user"];

  if (resumeSessionId) {
    args.push(`--resume=${resumeSessionId}`);
  }

  if (config.allowAllTools) {
    args.push("--yolo");
  }

  if (config.model) {
    args.push("--model", config.model);
  }

  if (outputJson) {
    args.push("--output-format", "json");
  }

  return args;
}

function runGhCopilot({ args, config }) {
  const cwd = config.workDir || process.cwd();
  const startedAt = Date.now();

  console.log(
    `[copilot] exec gh ${JSON.stringify(args)} cwd=${cwd} timeoutMs=${config.timeoutMs} maxBuffer=8388608`,
  );

  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        timeout: config.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        cwd,
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        const elapsedMs = Date.now() - startedAt;
        if (error) {
          const msg = stderr?.trim() || error.message;
          console.error(
            `[copilot] gh finished error elapsedMs=${elapsedMs} code=${error.code ?? "unknown"} signal=${error.signal ?? ""} message=${msg}`,
          );
          reject(new Error(`gh copilot failed: ${msg}`));
          return;
        }
        console.log(`[copilot] gh finished ok elapsedMs=${elapsedMs} stdoutChars=${stdout.trim().length}`);
        resolve(stdout.trim());
      },
    );
  });
}

function parseCopilotJsonOutput(raw) {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let sessionId = "";
  let output = "";

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && event?.type === "user.message" && typeof event?.parentId === "string") {
      sessionId = event.parentId;
    }

    if (event?.type === "assistant.message" && typeof event?.data?.content === "string") {
      output = event.data.content;
    }
  }

  if (!output) {
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event?.type === "assistant.message_delta" && typeof event?.data?.deltaContent === "string") {
        output += event.data.deltaContent;
      }
    }
  }

  return { output: output.trim(), sessionId };
}

/**
 * Run gh copilot CLI in non-interactive mode and return text output.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {object} options.config
 * @param {string} [options.resumeSessionId]
 * @returns {Promise<string>}
 */
export async function runCopilot({ prompt, config, resumeSessionId = "" }) {
  const args = buildCopilotArgs({
    prompt,
    config,
    resumeSessionId,
    outputJson: false,
  });

  return runGhCopilot({ args, config });
}

/**
 * Run gh copilot and return both output and reusable sessionId.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {object} options.config
 * @param {string} [options.resumeSessionId]
 * @returns {Promise<{ output: string, sessionId: string }>}
 */
export async function runCopilotWithSession({ prompt, config, resumeSessionId = "" }) {
  const args = buildCopilotArgs({
    prompt,
    config,
    resumeSessionId,
    outputJson: true,
  });

  const raw = await runGhCopilot({ args, config });
  return parseCopilotJsonOutput(raw);
}

export function getSharedCopilotSessionId() {
  return sharedCopilotSessionId;
}

export function setSharedCopilotSessionId(sessionId) {
  const normalized = String(sessionId ?? "").trim();
  if (normalized) {
    sharedCopilotSessionId = normalized;
  }
}

export function resetSharedCopilotSessionId() {
  sharedCopilotSessionId = "";
  sharedSessionQueue = Promise.resolve();
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
    const output = await runCopilot({ prompt, config });
    return { output, sessionId: "" };
  }

  return withSharedSessionLock(async () => {
    const { output, sessionId } = await runCopilotWithSession({
      prompt,
      config,
      resumeSessionId: sharedCopilotSessionId,
    });

    if (sessionId) {
      sharedCopilotSessionId = sessionId;
    }

    return { output, sessionId: sharedCopilotSessionId };
  });
}
