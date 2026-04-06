import * as Lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.mjs";
import { createGatewayClient } from "./gateway-client.mjs";

function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function normalizeDomain(domain) {
  if (domain === "lark") {
    return Lark.Domain.Lark;
  }
  if (domain === "feishu" || !domain) {
    return Lark.Domain.Feishu;
  }
  return domain;
}

function parseInboundContent(messageType, rawContent) {
  if (!rawContent) {
    return { text: "", kind: "unknown", imageKey: "" };
  }

  try {
    const parsed = JSON.parse(rawContent);

    if (messageType === "text") {
      return {
        text: String(parsed?.text ?? "").trim(),
        kind: "text",
        imageKey: "",
      };
    }

    if (messageType === "image") {
      const imageKey = String(parsed?.image_key ?? "").trim();
      return {
        text: "",
        kind: "image",
        imageKey,
      };
    }

    return { text: "", kind: messageType || "unknown", imageKey: "" };
  } catch {
    return { text: "", kind: "invalid_json", imageKey: "" };
  }
}

function getOpenApiBaseUrl(domain) {
  const normalized = String(domain ?? "").trim().toLowerCase();
  return normalized === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

function imageExtensionFromMime(contentType) {
  const mime = String(contentType ?? "").toLowerCase();
  if (mime.includes("png")) {
    return "png";
  }
  if (mime.includes("gif")) {
    return "gif";
  }
  if (mime.includes("webp")) {
    return "webp";
  }
  return "jpg";
}

const feishuTokenCache = {
  token: "",
  expireAtMs: 0,
};

async function fetchTenantAccessToken(feishuCfg, forceRefresh = false) {
  if (!forceRefresh && feishuTokenCache.token && Date.now() < feishuTokenCache.expireAtMs) {
    return feishuTokenCache.token;
  }

  const baseUrl = getOpenApiBaseUrl(feishuCfg.domain);
  const response = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: feishuCfg.appId, app_secret: feishuCfg.appSecret }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 0 || !payload?.tenant_access_token) {
    throw new Error(`failed to get tenant token: ${response.status} ${String(payload?.msg ?? "")}`);
  }

  const expiresInSec = Number(payload?.expire ?? 7200);
  feishuTokenCache.token = String(payload.tenant_access_token);
  feishuTokenCache.expireAtMs = Date.now() + Math.max(60, expiresInSec - 60) * 1000;
  return feishuTokenCache.token;
}

async function fetchImageBytes(feishuCfg, messageId, imageKey, token) {
  const baseUrl = getOpenApiBaseUrl(feishuCfg.domain);
  const url = `${baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`;
  return fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

async function downloadFeishuImageToTemp({ feishuCfg, messageId, imageKey }) {
  if (!imageKey) {
    throw new Error("image_key is missing in feishu image message");
  }

  const tempDir = feishuCfg.imageTempDir || "data/feishu-images";
  await fs.mkdir(tempDir, { recursive: true });

  let token = await fetchTenantAccessToken(feishuCfg);
  let response = await fetchImageBytes(feishuCfg, messageId, imageKey, token);
  if (response.status === 401) {
    token = await fetchTenantAccessToken(feishuCfg, true);
    response = await fetchImageBytes(feishuCfg, messageId, imageKey, token);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`download feishu image failed: ${response.status} ${text.slice(0, 200)}`);
  }

  const contentType = String(response.headers.get("content-type") || "image/jpeg");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > feishuCfg.imageMaxBytes) {
    throw new Error(`image too large: ${bytes.length} > ${feishuCfg.imageMaxBytes}`);
  }

  const ext = imageExtensionFromMime(contentType);
  const fileName = `${Date.now()}-${messageId.slice(-8)}-${imageKey.slice(0, 8)}.${ext}`;
  const filePath = path.resolve(tempDir, fileName);
  await fs.writeFile(filePath, bytes);

  return {
    filePath,
    contentType,
    size: bytes.length,
  };
}

function stripMentions(text, mentions) {
  let result = String(text ?? "");
  for (const mention of mentions ?? []) {
    const key = String(mention?.key ?? "");
    const name = String(mention?.name ?? "");
    if (key) {
      result = result.replaceAll(key, "");
    }
    if (name) {
      result = result.replaceAll(`@${name}`, "");
    }
  }
  return result.replace(/\s+/g, " ").trim();
}

function unwrapEventPayload(payload) {
  if (payload?.event && typeof payload.event === "object") {
    return payload.event;
  }
  return payload;
}

function createMessageDedup(maxEntries = 2000) {
  const seen = new Map();
  return {
    has(messageId) {
      return seen.has(messageId);
    },
    add(messageId) {
      seen.set(messageId, Date.now());
      if (seen.size <= maxEntries) {
        return;
      }

      const oldest = seen.keys().next().value;
      if (oldest) {
        seen.delete(oldest);
      }
    },
  };
}

function clipText(value, maxChars = 500) {
  const text = String(value ?? "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function splitCommandText(text) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("/")) {
    return null;
  }

  const firstSpace = raw.indexOf(" ");
  if (firstSpace < 0) {
    return { cmd: raw.toLowerCase(), rest: "" };
  }

  return {
    cmd: raw.slice(0, firstSpace).toLowerCase(),
    rest: raw.slice(firstSpace + 1).trim(),
  };
}

function parseMaybeJsonObject(raw, fieldName) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${fieldName} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`${fieldName} must be valid JSON: ${String(error?.message ?? error)}`);
  }
}

function withFeishuNotificationTarget(params, { chatId, senderOpenId }) {
  if (params.notify && typeof params.notify === "object" && !Array.isArray(params.notify)) {
    return params;
  }

  return {
    ...params,
    notify: {
      type: "feishu",
      chatId,
      senderOpenId,
    },
  };
}

async function routeCommand({ text, sessionId, gatewayClient, copilotCfg, chatId, senderOpenId }) {
  const command = splitCommandText(text);
  if (!command) {
    return null;
  }

  const { cmd, rest } = command;

  if (cmd === "/help") {
    return [
      "支持命令:",
      "/copilot <prompt>",
      "/agent <text>",
      "/cron list",
      "/cron run <jobId>",
      "/cron remove <jobId>",
      "/cron add <json>",
      "/cron update <jobId> <jsonPatch>",
    ].join("\n");
  }

  if (cmd === "/copilot") {
    if (!copilotCfg.enabled) {
      throw new Error("copilot tool is disabled");
    }
    const prompt = rest;
    if (!prompt) {
      throw new Error("usage: /copilot <prompt>");
    }
    const payload = await gatewayClient.request("copilot", { prompt });
    return String(payload?.output ?? "").trim() || "(empty output)";
  }

  if (cmd === "/agent") {
    if (!rest) {
      throw new Error("usage: /agent <text>");
    }
    await gatewayClient.request("send", { sessionId, text: rest });
    const payload = await gatewayClient.request("agent", { sessionId });
    return String(payload?.reply ?? "").trim() || "(empty output)";
  }

  if (cmd === "/cron") {
    if (!rest) {
      throw new Error("usage: /cron <list|run|remove|add|update> ...");
    }

    const [actionRaw, ...parts] = rest.split(/\s+/);
    const action = String(actionRaw ?? "").toLowerCase();

    if (action === "list") {
      const payload = await gatewayClient.request("cron.list", {});
      return JSON.stringify(payload?.jobs ?? [], null, 2);
    }

    if (action === "run") {
      const id = String(parts[0] ?? "").trim();
      if (!id) {
        throw new Error("usage: /cron run <jobId>");
      }
      const payload = await gatewayClient.request("cron.run", { id });
      return JSON.stringify(payload ?? {}, null, 2);
    }

    if (action === "remove") {
      const id = String(parts[0] ?? "").trim();
      if (!id) {
        throw new Error("usage: /cron remove <jobId>");
      }
      const payload = await gatewayClient.request("cron.remove", { id });
      return JSON.stringify(payload ?? {}, null, 2);
    }

    if (action === "add") {
      const jsonText = rest.slice("add".length).trim();
      if (!jsonText) {
        throw new Error("usage: /cron add <json>");
      }
      const params = withFeishuNotificationTarget(
        parseMaybeJsonObject(jsonText, "cron.add params"),
        { chatId, senderOpenId },
      );
      const payload = await gatewayClient.request("cron.add", params);
      return JSON.stringify(payload?.job ?? payload ?? {}, null, 2);
    }

    if (action === "update") {
      const id = String(parts[0] ?? "").trim();
      if (!id) {
        throw new Error("usage: /cron update <jobId> <jsonPatch>");
      }
      const patchText = rest.slice("update".length).trim().slice(id.length).trim();
      if (!patchText) {
        throw new Error("usage: /cron update <jobId> <jsonPatch>");
      }
      const patch = parseMaybeJsonObject(patchText, "cron.update patch");
      const payload = await gatewayClient.request("cron.update", { id, ...patch });
      return JSON.stringify(payload?.job ?? payload ?? {}, null, 2);
    }

    throw new Error("usage: /cron <list|run|remove|add|update> ...");
  }

  return null;
}

async function resolveBotOpenId(feishuClient) {
  try {
    const response = await feishuClient.request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      data: {},
    });
    return response?.bot?.open_id || response?.data?.bot?.open_id || "";
  } catch {
    return "";
  }
}

async function sendFeishuText({ feishuClient, chatId, replyToMessageId, text }) {
  const content = JSON.stringify({ text });
  if (replyToMessageId) {
    await feishuClient.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { msg_type: "text", content },
    });
    return;
  }

  await feishuClient.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content,
    },
  });
}

function assertConfig(feishuCfg) {
  if (!feishuCfg.enabled) {
    throw new Error("FEISHU_ENABLED is false; skip starting feishu bridge");
  }
  if (!feishuCfg.appId || !feishuCfg.appSecret) {
    throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required when FEISHU_ENABLED=true");
  }
  if (feishuCfg.connectionMode !== "websocket") {
    throw new Error('Only FEISHU_CONNECTION_MODE="websocket" is supported in this MVP bridge');
  }
}

const feishuCfg = config.feishu;
assertConfig(feishuCfg);

const copilotCfg = config.copilot;

const gatewayClient = createGatewayClient({
  gatewayUrl: feishuCfg.gatewayUrl,
  gatewayToken: feishuCfg.gatewayToken,
  clientId: feishuCfg.clientId,
  requestTimeoutMs: feishuCfg.requestTimeoutMs,
});

await gatewayClient.connect();

const domain = normalizeDomain(feishuCfg.domain);
const feishuClient = new Lark.Client({
  appId: feishuCfg.appId,
  appSecret: feishuCfg.appSecret,
  appType: Lark.AppType.SelfBuild,
  domain,
});
const wsClient = new Lark.WSClient({
  appId: feishuCfg.appId,
  appSecret: feishuCfg.appSecret,
  domain,
  loggerLevel: Lark.LoggerLevel.info,
});

const botOpenId = await resolveBotOpenId(feishuClient);
const dedup = createMessageDedup();
let warnedUnknownBotOpenId = false;

console.log(
  `[feishu-bridge] config: appId=${maskSecret(feishuCfg.appId)} domain=${feishuCfg.domain} mode=${feishuCfg.connectionMode} requireMentionInGroup=${feishuCfg.requireMentionInGroup}`,
);
console.log(`[feishu-bridge] gateway: ${feishuCfg.gatewayUrl} clientId=${feishuCfg.clientId}`);
console.log(`[feishu-bridge] botOpenId: ${botOpenId || "unknown"}`);

const dispatcher = new Lark.EventDispatcher({});

dispatcher.register({
  "im.message.receive_v1": async (payload) => {
    const event = unwrapEventPayload(payload);
    const message = event?.message;
    const senderOpenId = String(event?.sender?.sender_id?.open_id ?? "").trim();
    const messageId = String(message?.message_id ?? "").trim();
    const chatId = String(message?.chat_id ?? "").trim();
    const chatType = String(message?.chat_type ?? "").trim();
    const messageType = String(message?.message_type ?? "").trim();
    const mentions = Array.isArray(message?.mentions) ? message.mentions : [];

    if (!messageId || !chatId || !senderOpenId) {
      return;
    }

    if (dedup.has(messageId)) {
      return;
    }
    dedup.add(messageId);

    if (botOpenId && senderOpenId === botOpenId) {
      return;
    }

    const inbound = parseInboundContent(messageType, message?.content);
    const text = stripMentions(inbound.text, mentions);
    if (!text && inbound.kind !== "image") {
      return;
    }

    if (chatType === "group" && feishuCfg.requireMentionInGroup) {
      if (botOpenId) {
        const mentionedBot = mentions.some((m) => m?.id?.open_id === botOpenId);
        if (!mentionedBot) {
          return;
        }
      } else {
        if (!warnedUnknownBotOpenId) {
          warnedUnknownBotOpenId = true;
          console.log("[feishu-bridge] warning: botOpenId unavailable; group mention check is downgraded");
        }
        if (mentions.length === 0) {
          return;
        }
      }
    }

    const sessionId =
      chatType === "group" ? `feishu:group:${chatId}` : `feishu:dm:${senderOpenId}`;
      
    const isCopilot = copilotCfg.enabled;

    // 先贴一个"正在处理"的表情回应
    try {
      await feishuClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: "OnIt" } },
      });
    } catch (e) {
      console.warn(`[feishu-bridge] add reaction failed: ${e?.message ?? e}`);
    }

    let downloadedImage = null;
    try {
      let reply;

      const commandReply = await routeCommand({
        text,
        sessionId,
        gatewayClient,
        copilotCfg,
        chatId,
        senderOpenId,
      });
      if (commandReply !== null) {
        reply = String(commandReply).trim();
      }

      if (!reply && isCopilot) {
        let prompt = text.trim();
        if (inbound.kind === "image") {
          downloadedImage = await downloadFeishuImageToTemp({
            feishuCfg,
            messageId,
            imageKey: inbound.imageKey,
          });
          prompt = [
            "用户发送了一张飞书图片，请分析图片内容并用中文回答。",
            `图片文件路径: ${downloadedImage.filePath}`,
            `图片类型: ${downloadedImage.contentType}`,
            `图片大小(bytes): ${downloadedImage.size}`,
            "如果无法直接读取图片内容，请明确说明原因并给出可执行的下一步。",
          ].join("\n");
        }

        if (!prompt) {
          return;
        }
        console.log(
          `[feishu-bridge] copilot request from user=${senderOpenId} kind=${inbound.kind} prompt=${clipText(prompt, 120)}`,
        );
        const copilotPayload = await gatewayClient.request("copilot", { prompt });
        reply = String(copilotPayload?.output ?? "").trim();
      } else if (!reply) {
        if (inbound.kind === "image") {
          reply = "当前仅 copilot 模式支持图片处理，请启用 COPILOT_ENABLED=true 后重试。";
        } else {
          await gatewayClient.request("send", { sessionId, text });
          const agentPayload = await gatewayClient.request("agent", { sessionId });
          reply = String(agentPayload?.reply ?? "").trim();
        }
      }

      if (!reply) {
        return;
      }

      if (feishuCfg.logReply) {
        console.log(
          `[feishu-bridge] outbound -> chat=${chatId} user=${senderOpenId} text=${clipText(reply)}`,
        );
      }

      await sendFeishuText({
        feishuClient,
        chatId,
        replyToMessageId: messageId,
        text: reply,
      });
    } catch (error) {
      console.error(`[feishu-bridge] handle message failed: ${String(error?.message ?? error)}`);
      try {
        await sendFeishuText({
          feishuClient,
          chatId,
          replyToMessageId: messageId,
          text: `[错误] ${String(error?.message ?? error).slice(0, 500)}`,
        });
      } catch (replyError) {
        console.error(`[feishu-bridge] error reply failed: ${String(replyError?.message ?? replyError)}`);
      }
    } finally {
      if (downloadedImage?.filePath) {
        await fs.unlink(downloadedImage.filePath).catch(() => {});
      }
    }
  },
});

wsClient.start({ eventDispatcher: dispatcher });
console.log("[feishu-bridge] websocket client started");

const shutdown = () => {
  gatewayClient.close();
  try {
    if (typeof wsClient.stop === "function") {
      wsClient.stop();
    } else if (typeof wsClient.disconnect === "function") {
      wsClient.disconnect();
    }
  } catch {
    // Ignore shutdown cleanup errors.
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);