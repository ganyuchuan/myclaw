import { execFile } from "node:child_process";

/**
 * Run gh copilot CLI in non-interactive mode and return the text output.
 *
 * @param {object} options
 * @param {string} options.prompt  – The prompt to send to copilot
 * @param {object} options.config  – copilot config block from config.mjs
 * @returns {Promise<string>}
 */
export function runCopilot({ prompt, config }) {
  const args = ["copilot", "-p", prompt, "-s", "--no-ask-user"];

  if (config.allowAllTools) {
    args.push("--yolo");
  }

  if (config.model) {
    args.push("--model", config.model);
  }

  const cwd = config.workDir || process.cwd();

  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        timeout: config.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
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
