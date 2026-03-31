import { config } from "./config.mjs";
import { createGatewayServer } from "./gateway/server.mjs";
import { createCronScheduler } from "./cron/scheduler.mjs";

// ── Cron subsystem ──
let cronScheduler = null;
if (config.cron.enabled) {
  cronScheduler = createCronScheduler(config.cron);

  // Built-in executors
  cronScheduler.registerExecutor("log", (params) => {
    console.log(`[cron:log] ${params.message ?? "ping"}`);
  });

  cronScheduler.registerExecutor("copilot", async (params) => {
    const { runCopilot } = await import("./tool/copilot.mjs");
    const output = await runCopilot({ prompt: params.prompt, config: config.copilot });
    console.log(`[cron:copilot] ${output.slice(0, 500)}`);
  });

  cronScheduler.start();
}

const server = createGatewayServer(config, { cronScheduler });

await server.listen();

console.log(`[myclaw] gateway listening on ws://127.0.0.1:${config.port}/ws`);
console.log(`[myclaw] health endpoint: http://127.0.0.1:${config.port}/health`);
if (cronScheduler) {
  console.log(`[myclaw] cron subsystem enabled, jobs file: ${config.cron.jobsFile}`);
}

const shutdown = async () => {
  try {
    if (cronScheduler) {
      cronScheduler.stop();
    }
    await server.close();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
