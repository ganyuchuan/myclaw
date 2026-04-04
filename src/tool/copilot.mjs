import { execFile } from "node:child_process";

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
        if (error) {
          const msg = stderr?.trim() || error.message;
          reject(new Error(`gh copilot failed: ${msg}`));
          return;
        }
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
