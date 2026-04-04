import { config } from "./config.mjs";
import { createGatewayServer } from "./gateway/server.mjs";
import { createCronScheduler } from "./cron/scheduler.mjs";
import * as Lark from "@larksuiteoapi/node-sdk";
import { runCopilotWithSession } from "./tool/copilot.mjs";
import { createSyncClient } from "./sync/client.mjs";

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
  let syncClient = null;

  if (config.sync.enabled) {
    syncClient = createSyncClient(config.sync);
  }

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

    cronScheduler.registerExecutor("copilot", async (params, job) => {
      const resumeSessionId = String(job?.state?.copilotSessionId ?? "").trim();
      const { output, sessionId } = await runCopilotWithSession({
        prompt: params.prompt,
        config: config.copilot,
        resumeSessionId,
      });

      if (sessionId && job?.state) {
        job.state.copilotSessionId = sessionId;
      }

      console.log(
        `[cron:copilot] jobId=${job?.id} sessionId=${sessionId || resumeSessionId || "new"} output=${output.slice(0, 500)}`,
      );
      return output;
  });

  cronScheduler.onJobFinished(async ({ job, trigger, status, error, output }) => {
    if (syncClient) {
      try {
        await syncClient.upsertJob(job);
        await syncClient.appendRun({
          jobId: job.id,
          jobName: job.name,
          trigger,
          status,
          error,
          output,
          ranAtMs: job.state?.lastRunAtMs ?? Date.now(),
        });
      } catch (syncError) {
        console.warn(`[sync] failed to push run event: ${String(syncError?.message ?? syncError)}`);
      }
    }

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

  cronScheduler.onJobChanged(async ({ type, job }) => {
    if (!syncClient || !job?.id) {
      return;
    }

    try {
      if (type === "remove") {
        await syncClient.removeJob(job.id);
      } else {
        await syncClient.upsertJob(job);
      }
    } catch (syncError) {
      console.warn(`[sync] failed to sync job change: ${String(syncError?.message ?? syncError)}`);
    }
  });

  if (syncClient) {
    (async () => {
      try {
        for (const job of cronScheduler.list()) {
          await syncClient.upsertJob(job);
        }
        console.log("[sync] initial cron jobs synced");
      } catch (syncError) {
        console.warn(`[sync] initial sync failed: ${String(syncError?.message ?? syncError)}`);
      }
    })();
  }

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
