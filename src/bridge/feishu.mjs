import * as Lark from "@larksuiteoapi/node-sdk";
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

function parseTextContent(messageType, rawContent) {
  if (!rawContent) {
    return "";
  }

  if (messageType !== "text") {
    return "";
  }

  try {
    const parsed = JSON.parse(rawContent);
    return String(parsed?.text ?? "").trim();
  } catch {
    return "";
  }
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

    const rawText = parseTextContent(messageType, message?.content);
    const text = stripMentions(rawText, mentions);
    if (!text) {
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

    try {
      await gatewayClient.request("send", { sessionId, text });
      const agentPayload = await gatewayClient.request("agent", { sessionId });
      const reply = String(agentPayload?.reply ?? "").trim();
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