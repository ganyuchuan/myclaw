import { config } from "./config.mjs";
import { createGatewayServer } from "./gateway/server.mjs";
import { createCronScheduler } from "./cron/scheduler.mjs";
import * as Lark from "@larksuiteoapi/node-sdk";

function normalizeFeishuDomain(domain) {
  if (domain === "lark") {
    return Lark.Domain.Lark;
  }
  return Lark.Domain.Feishu;
}

async function sendFeishuNotification({ client, target, text }) {
  if (!target?.chatId) {
    return;
  }

  const content = JSON.stringify({ text });
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: target.chatId,
      msg_type: "text",
      content,
    },
  });
}

// ── Cron subsystem ──
let cronScheduler = null;
if (config.cron.enabled) {
  cronScheduler = createCronScheduler(config.cron);
  let feishuNotifyClient = null;

  if (config.feishu.enabled && config.feishu.appId && config.feishu.appSecret) {
    feishuNotifyClient = new Lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: normalizeFeishuDomain(config.feishu.domain),
    });
  }

  // Built-in executors
  cronScheduler.registerExecutor("log", (params) => {
    const message = String(params.message ?? "ping");
    console.log(`[cron:log] ${message}`);
    return message;
  });

  cronScheduler.registerExecutor("copilot", async (params) => {
    const { runCopilot } = await import("./tool/copilot.mjs");
    const output = await runCopilot({ prompt: params.prompt, config: config.copilot });
    console.log(`[cron:copilot] ${output.slice(0, 500)}`);
    return output;
  });

  cronScheduler.onJobFinished(async ({ job, trigger, status, error, output }) => {
    if (!feishuNotifyClient || job.notify?.type !== "feishu") {
      return;
    }

    const header = status === "ok" ? "[cron] 任务执行成功" : "[cron] 任务执行失败";
    const lines = [
      header,
      `name: ${job.name}`,
      `id: ${job.id}`,
      `trigger: ${trigger}`,
      `action: ${job.payload?.action ?? "unknown"}`,
    ];

    if (status === "ok") {
      if (typeof output === "string" && output.trim()) {
        lines.push(`output: ${output.slice(0, 1500)}`);
      }
    } else if (error) {
      lines.push(`error: ${error}`);
    }

    await sendFeishuNotification({
      client: feishuNotifyClient,
      target: job.notify,
      text: lines.join("\n"),
    });
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
