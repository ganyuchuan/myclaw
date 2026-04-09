import { config } from "./config.mjs";
import { createGatewayServer } from "./gateway/server.mjs";
import { createCronScheduler } from "./cron/scheduler.mjs";
import * as Lark from "@larksuiteoapi/node-sdk";
import { runCopilotWithSharedSession } from "./tool/copilot.mjs";
import { createSyncClient } from "./sync/client.mjs";
import { looksLikeMarkdown } from "./bridge/reply-format.mjs";

function normalizeFeishuDomain(domain) {
  if (domain === "lark") {
    return Lark.Domain.Lark;
  }
  return Lark.Domain.Feishu;
}

function buildNotificationPayload(text, renderAsMarkdown = false) {
  const normalized = String(text ?? "");
  if (!renderAsMarkdown) {
    return {
      msgType: "text",
      content: JSON.stringify({ text: normalized }),
    };
  }

  return {
    msgType: "interactive",
    content: JSON.stringify({
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: "markdown",
          content: normalized,
        },
      ],
    }),
  };
}

async function sendFeishuNotification({ client, target, text, renderAsMarkdown = false }) {
  if (!target?.chatId) {
    return;
  }

  const payload = buildNotificationPayload(text, renderAsMarkdown);
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: target.chatId,
      msg_type: payload.msgType,
      content: payload.content,
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
      const { output, sessionId } = await runCopilotWithSharedSession({
        prompt: params.prompt,
        config: config.copilot,
      });

      if (job?.state?.copilotSessionId) {
        delete job.state.copilotSessionId;
      }

      console.log(
        `[cron:copilot] jobId=${job?.id} sharedSessionId=${sessionId || "new"} output=${output.slice(0, 500)}`,
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

    const outputText = typeof output === "string" ? output.trim() : "";
    const outputIsMarkdown = status === "ok" && outputText ? looksLikeMarkdown(outputText) : false;

    if (status === "ok") {
      if (outputText) {
        if (outputIsMarkdown) {
          lines.push("output:");
          lines.push(outputText.slice(0, 1500));
        } else {
          lines.push(`output: ${outputText.slice(0, 1500)}`);
        }
      }
    } else if (error) {
      lines.push(`error: ${error}`);
    }

    await sendFeishuNotification({
      client: feishuNotifyClient,
      target: job.notify,
      text: lines.join("\n"),
      renderAsMarkdown: outputIsMarkdown,
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
