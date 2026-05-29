import * as Lark from "@larksuiteoapi/node-sdk";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { createGatewayClient } from "../gateway/gateway-client.js";
import { buildFeishuReplyPayload } from "./reply-format.js";

process.title = process.env.PROCESS_TITLE || "alimbo-feishu";

type TenantAccessTokenResponse = {
  code?: number;
  msg?: string;
  expire?: number;
  tenant_access_token?: string;
};

type GatewayCopilotResponse = {
  output?: string;
};

type WsClientCompat = {
  stop?: () => void;
  disconnect?: () => void;
};

type ServiceRequestParams = {
  name?: string;
  lines?: number;
};

type InterceptQueueItem = {
  id?: string;
  status?: string;
  decision?: string;
  tool?: string;
  hint?: string;
  msg?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  expiresAtMs?: number;
  decidedBy?: string | null;
  reason?: string;
};

type InterceptQueueResponse = {
  items?: InterceptQueueItem[];
};

type InterceptDecisionResponse = {
  ok?: boolean;
  id?: string;
  status?: string;
  decision?: string;
  reason?: string;
  tool?: string;
  hint?: string;
  msg?: string;
  decidedBy?: string | null;
  decidedAtMs?: number;
};

type InterceptTrackedCard = {
  requestId: string;
  messageId: string;
  chatId: string;
  tool: string;
  hint: string;
  msg: string;
  status: string;
  updatedAtMs: number;
};

type InterceptCardActionValue = {
  action?: string;
  requestId?: string;
  tool?: string;
};

type InterceptCardActionPayload = {
  action?: {
    value?: InterceptCardActionValue;
  };
  operator?: {
    open_id?: string;
  };
};

type PendingAttachmentItem = {
  kind: "image" | "file";
  filePath: string;
  fileName: string;
  contentType: string;
  size: number;
  receivedAtMs: number;
};

type PendingAttachmentState = {
  items: PendingAttachmentItem[];
  expiresAtMs: number;
};

const ATTACHMENT_LISTEN_WINDOW_MS = 5 * 60 * 1000;
const pendingAttachments = new Map<string, PendingAttachmentState>();

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
    return { text: "", kind: "unknown", imageKey: "", fileKey: "", fileName: "" };
  }

  try {
    const parsed = JSON.parse(rawContent);

    if (messageType === "text") {
      return {
        text: String(parsed?.text ?? "").trim(),
        kind: "text",
        imageKey: "",
        fileKey: "",
        fileName: "",
      };
    }

    if (messageType === "image") {
      const imageKey = String(parsed?.image_key ?? "").trim();
      return {
        text: "",
        kind: "image",
        imageKey,
        fileKey: "",
        fileName: "",
      };
    }

    if (messageType === "file") {
      const fileKey = String(parsed?.file_key ?? "").trim();
      const fileName = String(parsed?.file_name ?? "").trim();
      return {
        text: "",
        kind: "file",
        imageKey: "",
        fileKey,
        fileName,
      };
    }

    return { text: "", kind: messageType || "unknown", imageKey: "", fileKey: "", fileName: "" };
  } catch {
    return { text: "", kind: "invalid_json", imageKey: "", fileKey: "", fileName: "" };
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

function extensionFromFileName(fileName) {
  const base = String(fileName ?? "").trim();
  const idx = base.lastIndexOf(".");
  if (idx < 0 || idx === base.length - 1) {
    return "bin";
  }
  return base.slice(idx + 1).toLowerCase();
}

function parseFileNameFromContentDisposition(contentDisposition) {
  const value = String(contentDisposition ?? "");
  if (!value) {
    return "";
  }

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] ? String(plainMatch[1]) : "";
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

  const payload = await response.json().catch(() => null) as TenantAccessTokenResponse | null;
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

async function fetchFileBytes(feishuCfg, messageId, fileKey, token) {
  const baseUrl = getOpenApiBaseUrl(feishuCfg.domain);
  const url = `${baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`;
  return fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

async function downloadFeishuResourceToTemp({ feishuCfg, messageId, resourceKey, resourceType, fileNameHint = "" }) {
  if (!resourceKey) {
    throw new Error(`${resourceType}_key is missing in feishu ${resourceType} message`);
  }

  const isImage = resourceType === "image";
  const tempDir = isImage ? feishuCfg.imageTempDir || "data/feishu-images" : feishuCfg.fileTempDir || "data/feishu-files";
  const maxBytes = isImage ? feishuCfg.imageMaxBytes : feishuCfg.fileMaxBytes;
  await fs.mkdir(tempDir, { recursive: true });

  let token = await fetchTenantAccessToken(feishuCfg);
  let response = isImage
    ? await fetchImageBytes(feishuCfg, messageId, resourceKey, token)
    : await fetchFileBytes(feishuCfg, messageId, resourceKey, token);

  if (response.status === 401) {
    token = await fetchTenantAccessToken(feishuCfg, true);
    response = isImage
      ? await fetchImageBytes(feishuCfg, messageId, resourceKey, token)
      : await fetchFileBytes(feishuCfg, messageId, resourceKey, token);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`download feishu image failed: ${response.status} ${text.slice(0, 200)}`);
  }

  const contentType = String(response.headers.get("content-type") || "image/jpeg");
  const contentDisposition = String(response.headers.get("content-disposition") || "");
  const serverFileName = parseFileNameFromContentDisposition(contentDisposition);
  const fileName = serverFileName || fileNameHint || `${resourceType}-${resourceKey}`;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new Error(`${resourceType} too large: ${bytes.length} > ${maxBytes}`);
  }

  const ext = isImage ? imageExtensionFromMime(contentType) : extensionFromFileName(fileName);
  const safeName = `${Date.now()}-${messageId.slice(-8)}-${resourceKey.slice(0, 8)}.${ext}`;
  const filePath = path.resolve(tempDir, safeName);
  await fs.writeFile(filePath, bytes);

  return {
    filePath,
    fileName,
    contentType,
    size: bytes.length,
    resourceType,
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

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function formatTime(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) {
    return "-";
  }
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isTextLikeFile({ fileName, contentType }) {
  const normalizedName = String(fileName ?? "").toLowerCase();
  return (
    normalizedName.endsWith(".md") ||
    normalizedName.endsWith(".markdown") ||
    normalizedName.endsWith(".txt") ||
    String(contentType ?? "").startsWith("text/")
  );
}

async function cleanupAttachmentItems(items: PendingAttachmentItem[] = []) {
  for (const item of items) {
    if (!item?.filePath) {
      continue;
    }
    await fs.unlink(item.filePath).catch(() => {});
  }
}

async function clearExpiredPendingAttachments(scopeKey, nowMs = Date.now()) {
  const state = pendingAttachments.get(scopeKey);
  if (!state || state.expiresAtMs > nowMs) {
    return;
  }

  pendingAttachments.delete(scopeKey);
  await cleanupAttachmentItems(state.items);
}

async function appendPendingAttachment(scopeKey, item: PendingAttachmentItem) {
  await clearExpiredPendingAttachments(scopeKey);
  const nowMs = Date.now();
  const state = pendingAttachments.get(scopeKey) || {
    items: [],
    expiresAtMs: nowMs + ATTACHMENT_LISTEN_WINDOW_MS,
  };
  state.items.push(item);
  state.expiresAtMs = nowMs + ATTACHMENT_LISTEN_WINDOW_MS;
  pendingAttachments.set(scopeKey, state);
  return state.items.length;
}

async function consumePendingAttachmentContext(scopeKey, fileMaxTextChars) {
  await clearExpiredPendingAttachments(scopeKey);
  const state = pendingAttachments.get(scopeKey);
  if (!state || state.items.length === 0) {
    return { context: "", items: [] };
  }

  pendingAttachments.delete(scopeKey);

  const lines = [
    "用户在当前对话中先发送了以下图片/文件，请先结合这些上下文再回答后续文本问题。",
  ];

  let imageIndex = 0;
  let fileIndex = 0;

  for (const item of state.items) {
    if (item.kind === "image") {
      imageIndex += 1;
      lines.push(`图片#${imageIndex}:`);
      lines.push(`- 路径: ${item.filePath}`);
      lines.push(`- 类型: ${item.contentType}`);
      lines.push(`- 大小(bytes): ${item.size}`);
      continue;
    }

    fileIndex += 1;
    lines.push(`文件#${fileIndex}:`);
    lines.push(`- 文件名: ${item.fileName || "(unknown)"}`);
    lines.push(`- 路径: ${item.filePath}`);
    lines.push(`- 类型: ${item.contentType}`);
    lines.push(`- 大小(bytes): ${item.size}`);

    if (isTextLikeFile(item)) {
      const raw = await fs.readFile(item.filePath, "utf8").catch(() => "");
      if (raw) {
        const clipped = raw.length > fileMaxTextChars
          ? `${raw.slice(0, fileMaxTextChars)}\n\n[内容已截断，总长度=${raw.length}]`
          : raw;
        lines.push("- 文本内容:");
        lines.push("```");
        lines.push(clipped);
        lines.push("```");
      }
    }
  }

  return { context: lines.join("\n"), items: state.items };
}

function buildInterceptReviewCard(item, resolution = null) {
  const id = String(item?.id ?? "").trim();
  const tool = String(item?.tool ?? "").trim() || "unknown";
  const hint = String(item?.hint ?? "").trim() || "-";
  const msg = String(item?.msg ?? "").trim() || "-";
  const createdAt = formatTime(item?.createdAtMs);
  const expiresAt = formatTime(item?.expiresAtMs);
  const title = resolution
    ? `审核已完成 · ${tool}`
    : `Copilot 审核请求 · ${tool}`;
  const template = resolution
    ? (resolution.decision === "allow" ? "green" : "red")
    : "orange";
  const summary = resolution
    ? `结果: ${resolution.decision === "allow" ? "Approve" : "Deny"}\n操作人: ${resolution.decidedBy}\n原因: ${resolution.reason || "-"}`
    : "请直接点击下方按钮完成审批";

  const elements = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          `**Request ID**: ${id}`,
          `**Tool**: ${tool}`,
          `**Hint**: ${hint}`,
          `**Message**: ${msg}`,
          `**Created At**: ${createdAt}`,
          `**Expires At**: ${expiresAt}`,
        ].join("\n"),
      },
    },
    {
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: summary,
        },
      ],
    },
  ] as Array<Record<string, unknown>>;

  if (!resolution) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          type: "primary",
          text: { tag: "plain_text", content: "Approve" },
          value: { action: "approve", requestId: id, tool },
        },
        {
          tag: "button",
          type: "danger",
          text: { tag: "plain_text", content: "Deny" },
          value: { action: "deny", requestId: id, tool },
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
      template,
    },
    elements,
  };
}

function makeFeishuConversationScope({ appId, chatType, chatId, senderOpenId }) {
  const appScope = String(appId ?? "").trim() || "unknown-app";
  if (chatType === "group") {
    return `feishu:${appScope}:group:${chatId}`;
  }
  return `feishu:${appScope}:dm:${senderOpenId}`;
}

function getStableShardIndex(key, totalShards) {
  const digest = crypto.createHash("sha1").update(String(key)).digest();
  const number = digest.readUInt32BE(0);
  return number % totalShards;
}

function shouldHandleFeishuConversation(scopeKey, feishuCfg) {
  const total = Number.isFinite(feishuCfg?.routeTotalShards) && feishuCfg.routeTotalShards > 0
    ? Number.parseInt(String(feishuCfg.routeTotalShards), 10)
    : 1;

  if (total <= 1) {
    return { shouldHandle: true, shard: 0, total, index: 0 };
  }

  const rawIndex = Number.isFinite(feishuCfg?.routeShardIndex)
    ? Number.parseInt(String(feishuCfg.routeShardIndex), 10)
    : 0;
  const index = ((rawIndex % total) + total) % total;
  const salt = String(feishuCfg?.routeSalt ?? "").trim();
  const shard = getStableShardIndex(`${salt}:${scopeKey}`, total);

  return {
    shouldHandle: shard === index,
    shard,
    total,
    index,
  };
}

function makeStreamId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function createCopilotStreamManager({
  feishuClient,
  flushIntervalMs = 800,
  minChunkChars = 120,
}) {
  const streams = new Map();

  const enqueueFlush = (streamId, { force = false } = {}) => {
    const state = streams.get(streamId);
    if (!state) {
      return;
    }

    state.flushChain = state.flushChain
      .then(async () => {
        if (!state.buffer) {
          return;
        }

        const now = Date.now();
        if (!force && state.buffer.length < minChunkChars && now - state.lastFlushAtMs < flushIntervalMs) {
          return;
        }

        const chunk = state.buffer;
        state.buffer = "";
        state.lastFlushAtMs = now;

        await sendFeishuText({
          feishuClient,
          chatId: state.chatId,
          replyToMessageId: state.replyToMessageId,
          text: `[stream] ${chunk}`,
          renderAsMarkdown: false,
        });
      })
      .catch((error) => {
        console.warn(`[feishu-bridge] stream flush failed: ${String(error?.message ?? error)}`);
      });
  };

  return {
    create(chatId, replyToMessageId) {
      const streamId = makeStreamId();
      streams.set(streamId, {
        chatId,
        replyToMessageId,
        buffer: "",
        lastFlushAtMs: 0,
        flushChain: Promise.resolve(),
      });
      return streamId;
    },
    pushDelta(streamId, delta) {
      const state = streams.get(streamId);
      if (!state) {
        return;
      }
      state.buffer += String(delta ?? "");
      enqueueFlush(streamId);
    },
    async finish(streamId) {
      if (!streams.has(streamId)) {
        return;
      }
      enqueueFlush(streamId, { force: true });
      const state = streams.get(streamId);
      if (state) {
        await state.flushChain;
      }
      streams.delete(streamId);
    },
  };
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

function resolveReactionEmojiType({ text, copilotCfg }) {
  const command = splitCommandText(text);

  if (command) {
    return "";
  }

  const defaultEmoji = "OnIt";
  const copilotEmoji = "OnIt";
  const claudeEmoji = "Moon";
  const codexEmoji = "Done";

  const provider = String(copilotCfg?.agentProvider ?? "copilot").trim().toLowerCase();

  if (provider === "copilot") {
    return copilotEmoji;
  } else if (provider === "claude") {
    return claudeEmoji;
  } else if (provider === "codex") {
    return codexEmoji;
  }

  return defaultEmoji;
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

function formatCronNlReply(payload) {
  const interpreted = payload?.interpreted && typeof payload.interpreted === "object"
    ? payload.interpreted
    : {};
  const action = String(interpreted?.action ?? "").trim();
  const reason = String(interpreted?.reason ?? "").trim();
  const paramsText = JSON.stringify(interpreted?.params ?? {}, null, 2);
  const resultText = JSON.stringify(payload?.result ?? {}, null, 2);

  return [
    "cron.nl 已执行",
    action ? `action: ${action}` : "",
    reason ? `reason: ${reason}` : "",
    `params: ${paramsText}`,
    `result: ${resultText}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function routeCommand({
  text,
  gatewayClient,
  runCopilotRequest,
  copilotCfg,
  gitCfg,
  sqlCfg,
  serviceCfg,
  chatId,
  senderOpenId,
}) {
  const command = splitCommandText(text);
  if (!command) {
    return null;
  }

  const { cmd, rest } = command;

  if (cmd === "/help") {
    const serviceHelp = serviceCfg?.enabled
      ? [
          "/service list",
          "/service start <name>",
          "/service stop <name>",
          "/service restart <name>",
          "/service logs <name> [lines]",
        ]
      : [];

    return [
      "支持命令:",
      "/copilot <prompt>",
      "/sql <自然语言查询>",
      "/git <args>",
      ...serviceHelp,
      "/skills list",
      "/skills add <path>",
      "/skills remove <path>",
      "/mcp list",
      "/mcp add <mcp_config>",
      "/mcp remove <mcp_name>",
      "/cron list",
      "/cron run <jobId>",
      "/cron remove <jobId>",
      "/cron add <json>",
      "/cron update <jobId> <jsonPatch>",
      "/cron nl <自然语言>",
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
    const payload = await runCopilotRequest(prompt);
    return String(payload?.output ?? "").trim() || "(empty output)";
  }

  if (cmd === "/git") {
    if (!gitCfg?.enabled) {
      throw new Error("git tool is disabled");
    }

    if (!rest) {
      throw new Error("usage: /git <args>");
    }

    const payload = await gatewayClient.request("git", { command: rest });
    return String(payload?.output ?? "").trim() || "(empty output)";
  }

  if (cmd === "/sql") {
    if (!sqlCfg?.enabled) {
      throw new Error("sql tool is disabled");
    }

    if (!rest) {
      throw new Error("usage: /sql <自然语言查询>");
    }

    const payload = await gatewayClient.request("sql", { text: rest });
    const lines = [`SQL: ${String(payload?.sql ?? "").trim()}`];

    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (rows.length > 0) {
      lines.push(`Rows(${rows.length}):`);
      lines.push(JSON.stringify(rows, null, 2));
    } else if (payload?.output) {
      lines.push(String(payload.output));
    } else {
      lines.push("(no rows)");
    }

    return lines.join("\n");
  }

  if (cmd === "/service") {
    if (!serviceCfg?.enabled) {
      throw new Error("service tool is disabled");
    }

    const [actionRaw, nameRaw, linesRaw] = String(rest ?? "").split(/\s+/).filter(Boolean);
    const action = String(actionRaw ?? "").toLowerCase();
    const name = String(nameRaw ?? "").trim();
    const lines = Number.parseInt(String(linesRaw ?? ""), 10);
    const actionSet = new Set(["list", "start", "stop", "restart", "logs"]);

    if (!actionSet.has(action)) {
      throw new Error("usage: /service <list|start|stop|restart|logs> [name] [lines]");
    }

    if (action !== "list" && !name) {
      throw new Error(`usage: /service ${action} <name>${action === "logs" ? " [lines]" : ""}`);
    }

    const params: ServiceRequestParams = action === "list" ? {} : { name };
    if (action === "logs" && Number.isFinite(lines) && lines > 0) {
      params.lines = lines;
    }

    const payload = await gatewayClient.request(`service.${action}`, params);
    return String(payload?.output ?? "").trim() || "(empty output)";
  }

  if (cmd === "/skills") {
    if (!rest) {
      throw new Error("usage: /skills <list|add|remove> ...");
    }

    const [actionRaw, ...parts] = rest.split(/\s+/);
    const action = String(actionRaw ?? "").toLowerCase();

    if (action === "list") {
      const payload = await gatewayClient.request("skills.list", {});
      const skills = Array.isArray(payload?.skills) ? payload.skills : [];
      if (skills.length === 0) {
        return "(no skills added)";
      }

      return skills
        .map((item, index) => {
          const marker = item?.exists ? "" : " [missing]";
          return `${index + 1}. ${String(item?.relativePath ?? item?.path ?? "")}${marker}`;
        })
        .join("\n");
    }

    if (action === "add") {
      const skillPath = parts.join(" ").trim();
      if (!skillPath) {
        throw new Error("usage: /skills add <path>");
      }
      const payload = await gatewayClient.request("skills.add", { path: skillPath });
      const relative = String(payload?.added?.relativePath ?? payload?.added?.path ?? skillPath);
      return payload?.changed
        ? `skill added: ${relative}`
        : `skill already exists: ${relative}`;
    }

    if (action === "remove") {
      const skillPath = parts.join(" ").trim();
      if (!skillPath) {
        throw new Error("usage: /skills remove <path>");
      }
      const payload = await gatewayClient.request("skills.remove", { path: skillPath });
      return payload?.changed
        ? `skill removed: ${skillPath}`
        : `skill not found: ${skillPath}`;
    }

    throw new Error("usage: /skills <list|add|remove> ...");
  }

  if (cmd === "/mcp") {
    if (!rest) {
      throw new Error("usage: /mcp <add|remove|list> ...");
    }

    const [actionRaw, ...parts] = rest.split(/\s+/);
    const action = String(actionRaw ?? "").toLowerCase();

    if (action === "list") {
      const payload = await gatewayClient.request("mcp.list", {});
      return JSON.stringify(payload?.mcpServers ?? {}, null, 2);
    }

    if (action === "add") {
      const configText = rest.slice("add".length).trim();
      if (!configText) {
        throw new Error("usage: /mcp add <mcp_config>");
      }

      const payload = await gatewayClient.request("mcp.add", { jsonConfig: configText });
      const names = Array.isArray(payload?.names) ? payload.names : [];
      const changedNames = Array.isArray(payload?.changedNames) ? payload.changedNames : [];
      return [
        `mcp config file: ${String(payload?.filePath ?? "")}`,
        `servers in request: ${names.join(", ") || "(none)"}`,
        `updated servers: ${changedNames.join(", ") || "(no changes)"}`,
        `total servers: ${String(payload?.count ?? 0)}`,
      ].join("\n");
    }

    if (action === "remove") {
      const mcpName = parts.join(" ").trim();
      if (!mcpName) {
        throw new Error("usage: /mcp remove <mcp_name>");
      }

      const payload = await gatewayClient.request("mcp.remove", { name: mcpName });
      return [
        `mcp config file: ${String(payload?.filePath ?? "")}`,
        `removed: ${payload?.removed ? "yes" : "no"}`,
        `server: ${String(payload?.name ?? mcpName)}`,
        `total servers: ${String(payload?.count ?? 0)}`,
      ].join("\n");
    }

    throw new Error("usage: /mcp <add|remove|list> ...");
  }

  if (cmd === "/cron") {
    if (!rest) {
      throw new Error("usage: /cron <list|run|remove|add|update|nl> ...");
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

    if (action === "nl") {
      const nlText = parts.join(" ").trim();
      if (!nlText) {
        throw new Error("usage: /cron nl <自然语言>");
      }

      if (!copilotCfg?.enabled) {
        throw new Error("cron 自然语言模式依赖 copilot，请启用 COPILOT_ENABLED=true");
      }

      const payload = await gatewayClient.request("cron.nl", {
        text: nlText,
        notify: {
          type: "feishu",
          chatId,
          senderOpenId,
        },
      });
      return formatCronNlReply(payload);
    }

    throw new Error("usage: /cron <list|run|remove|add|update|nl> ...");
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

async function sendFeishuText({ feishuClient, chatId, replyToMessageId, text, renderAsMarkdown = false }) {
  const payload = buildFeishuReplyPayload(text, renderAsMarkdown);
  return sendFeishuMessage({
    feishuClient,
    chatId,
    replyToMessageId,
    msgType: payload.msgType,
    content: payload.content,
  });
}

async function sendFeishuMessage({ feishuClient, chatId, replyToMessageId, msgType, content }) {
  if (replyToMessageId) {
    return feishuClient.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { msg_type: msgType, content },
    });
  }

  return feishuClient.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: msgType,
      content,
    },
  });
}

async function updateFeishuInteractiveMessage({ feishuClient, messageId, content }) {
  return feishuClient.request({
    method: "PATCH",
    url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    data: {
      msg_type: "interactive",
      content,
    },
  });
}

function createInterceptReviewClient(feishuCfg) {
  const baseUrl = trimTrailingSlash(feishuCfg.interceptServerUrl || "http://127.0.0.1:18790");
  const authToken = String(feishuCfg.interceptAuthToken ?? "").trim();
  const timeoutMs = parsePositiveInt(feishuCfg.requestTimeoutMs, 15000);

  async function request(method, apiPath, body = undefined) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
      } as Record<string, string>;
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }

      const response = await fetch(`${baseUrl}${apiPath}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`intercept request failed (${response.status}): ${text.slice(0, 300)}`);
      }

      if (response.status === 204) {
        return null;
      }

      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getWaitingQueue(limit) {
      const safeLimit = parsePositiveInt(limit, 20);
      const payload = await request(
        "GET",
        `/api/copilot/intercepts/queue?status=waiting&limit=${encodeURIComponent(String(safeLimit))}`,
      ) as InterceptQueueResponse;
      return Array.isArray(payload?.items) ? payload.items : [];
    },

    async getDecision(id) {
      const normalized = String(id ?? "").trim();
      if (!normalized) {
        return null;
      }

      try {
        return await request(
          "GET",
          `/api/copilot/intercepts/decision?id=${encodeURIComponent(normalized)}`,
        ) as InterceptDecisionResponse;
      } catch (error) {
        const message = String(error?.message ?? error);
        if (message.includes("(404)")) {
          return null;
        }
        throw error;
      }
    },

    async decide({ id, decision, reason, decidedBy }) {
      return request("POST", "/api/copilot/intercepts/decision", {
        id,
        decision,
        reason,
        decidedBy,
      }) as Promise<InterceptDecisionResponse>;
    },
  };
}

function createInterceptReviewWorker({ feishuCfg, feishuClient }) {
  const noop = {
    start() {},
    stop() {},
    async handleCardAction() {
      return null;
    },
  };

  if (!feishuCfg.interceptReviewEnabled) {
    return noop;
  }

  const reviewChatId = String(feishuCfg.interceptReviewChatId ?? "").trim();
  if (!reviewChatId) {
    console.warn("[feishu-bridge][intercept-review] disabled: FEISHU_INTERCEPT_REVIEW_CHAT_ID is empty");
    return noop;
  }

  const client = createInterceptReviewClient(feishuCfg);
  const seenSignatures = new Set();
  const trackedCards = new Map<string, InterceptTrackedCard>();
  const queueLimit = parsePositiveInt(feishuCfg.interceptReviewQueueLimit, 20);
  const pollIntervalMs = parsePositiveInt(feishuCfg.interceptReviewPollIntervalMs, 3000);
  const decider = String(feishuCfg.interceptReviewDecider ?? "").trim() || "feishu-bridge";
  let timer = null as NodeJS.Timeout | null;
  let polling = false;

  const markTrackedCardResolved = ({ requestId, status, reason, decidedBy, decision, tool, hint, msg }) => {
    const tracked = trackedCards.get(requestId);
    if (!tracked) {
      return;
    }

    tracked.status = status;
    tracked.tool = tool || tracked.tool;
    if (hint) {
      tracked.hint = hint;
    }
    if (msg) {
      tracked.msg = msg;
    }
    tracked.updatedAtMs = Date.now();

    void updateFeishuInteractiveMessage({
      feishuClient,
      messageId: tracked.messageId,
      content: JSON.stringify(
        buildInterceptReviewCard(
          {
            id: requestId,
            tool: tool || tracked.tool,
            hint: hint || tracked.hint || "-",
            msg: msg || tracked.msg || "审批已处理",
          },
          {
            decision,
            decidedBy,
            reason,
          },
        ),
      ),
    }).catch((error) => {
      console.warn(
        `[feishu-bridge][intercept-review] failed to update card requestId=${requestId}: ${String(error?.message ?? error)}`,
      );
    });
  };

  const syncResolvedCards = async (waitingItems) => {
    const waitingSet = new Set(waitingItems.map((item) => String(item?.id ?? "").trim()).filter(Boolean));
    const trackedIds = [...trackedCards.keys()];

    for (const requestId of trackedIds) {
      if (waitingSet.has(requestId)) {
        continue;
      }

      const tracked = trackedCards.get(requestId);
      if (!tracked || tracked.status !== "waiting") {
        continue;
      }

      const decisionPayload = await client.getDecision(requestId);
      if (!decisionPayload) {
        continue;
      }

      const status = String(decisionPayload.status ?? "").trim().toLowerCase();
      if (!status || status === "waiting") {
        continue;
      }

      const resolvedDecision = status === "approved" ? "allow" : "deny";
      markTrackedCardResolved({
        requestId,
        status,
        decision: resolvedDecision,
        decidedBy: String(decisionPayload.decidedBy ?? "manual"),
        reason: String(decisionPayload.reason ?? "manual decision"),
        tool: String(decisionPayload.tool ?? tracked.tool ?? "unknown"),
        hint: String(decisionPayload.hint ?? tracked.hint ?? "").trim(),
        msg: String(decisionPayload.msg ?? tracked.msg ?? "审批已处理").trim(),
      });
    }
  };

  const notifyNewWaitingItems = async (items) => {
    for (const item of items) {
      const id = String(item?.id ?? "").trim();
      if (!id) {
        continue;
      }

      const signature = `${id}:${Number(item?.updatedAtMs ?? item?.createdAtMs ?? 0)}`;
      if (seenSignatures.has(signature)) {
        continue;
      }
      seenSignatures.add(signature);

      if (seenSignatures.size > 4000) {
        const keep = [...seenSignatures].slice(-2000);
        seenSignatures.clear();
        for (const value of keep) {
          seenSignatures.add(value);
        }
      }

      const response = await sendFeishuMessage({
        feishuClient,
        chatId: reviewChatId,
        replyToMessageId: "",
        msgType: "interactive",
        content: JSON.stringify(buildInterceptReviewCard(item)),
      });

      const messageId = String(response?.data?.message_id ?? response?.message_id ?? "").trim();
      if (messageId) {
        trackedCards.set(id, {
          requestId: id,
          messageId,
          chatId: reviewChatId,
          tool: String(item?.tool ?? "").trim() || "unknown",
          hint: String(item?.hint ?? "").trim() || "-",
          msg: String(item?.msg ?? "").trim() || "-",
          status: "waiting",
          updatedAtMs: Date.now(),
        });
      }
    }
  };

  const poll = async () => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const waitingItems = await client.getWaitingQueue(queueLimit);
      await notifyNewWaitingItems(waitingItems);
      await syncResolvedCards(waitingItems);
    } catch (error) {
      console.warn(`[feishu-bridge][intercept-review] poll failed: ${String(error?.message ?? error)}`);
    } finally {
      polling = false;
    }
  };

  return {
    start() {
      void poll();
      timer = setInterval(() => {
        void poll();
      }, pollIntervalMs);
      console.log(
        `[feishu-bridge][intercept-review] enabled chatId=${reviewChatId} pollIntervalMs=${pollIntervalMs} queueLimit=${queueLimit}`,
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    async handleCardAction(cardActionPayload) {
      const data = (cardActionPayload ?? {}) as InterceptCardActionPayload;
      const action = String(data?.action?.value?.action ?? "").trim().toLowerCase();
      if (!["approve", "deny"].includes(action)) {
        return null;
      }

      const id = String(data?.action?.value?.requestId ?? "").trim();
      if (!id) {
        return {
          toast: {
            type: "error",
            content: "缺少 requestId，无法审批",
          },
        };
      }

      const decision = action === "approve" ? "allow" : "deny";
      const operator = String(data?.operator?.open_id ?? "").trim();
      const shortOperator = operator ? operator.slice(-8) : "unknown";
      const decidedBy = `${decider}:${shortOperator}`;
      const reason = `manual ${decision} from ${decidedBy}`;

      const decisionResponse = await client.decide({
        id,
        decision,
        decidedBy,
        reason,
      });

      const tracked = trackedCards.get(id);

      const updatedItem = {
        id: String(decisionResponse?.id ?? id),
        tool: String(data?.action?.value?.tool ?? "") || tracked?.tool || "unknown",
        hint: String(decisionResponse?.hint ?? tracked?.hint ?? "").trim() || "-",
        msg: String(decisionResponse?.msg ?? tracked?.msg ?? "审批已处理").trim() || "审批已处理",
      };

      markTrackedCardResolved({
        requestId: updatedItem.id,
        status: decision === "allow" ? "approved" : "denied",
        decision,
        decidedBy,
        reason: String(decisionResponse?.reason ?? reason),
        tool: updatedItem.tool,
        hint: updatedItem.hint,
        msg: updatedItem.msg,
      });

      return {
        toast: {
          type: decision === "allow" ? "success" : "warning",
          content: decision === "allow" ? "已批准" : "已拒绝",
        },
        card: {
          type: "raw",
          data: buildInterceptReviewCard(updatedItem, {
            decision,
            decidedBy,
            reason: String(decisionResponse?.reason ?? reason),
          }),
        },
      };
    },
  };
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
  if (feishuCfg.interceptReviewEnabled && !feishuCfg.interceptReviewChatId) {
    throw new Error("FEISHU_INTERCEPT_REVIEW_CHAT_ID is required when FEISHU_INTERCEPT_REVIEW_ENABLED=true");
  }
}

const feishuCfg = config.feishu;
assertConfig(feishuCfg);

const copilotCfg = config.copilot;
const gitCfg = config.git;
const sqlCfg = config.sql;
const serviceCfg = config.service;

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

const copilotStreamManager = createCopilotStreamManager({
  feishuClient,
  flushIntervalMs: feishuCfg.copilotStreamFlushIntervalMs,
  minChunkChars: feishuCfg.copilotStreamMinChunkChars,
});
gatewayClient.onEvent((frame) => {
  if (!feishuCfg.copilotStreamEnabled) {
    return;
  }

  if (frame?.event === "copilot.delta") {
    const streamId = String(frame?.payload?.streamId ?? "");
    if (!streamId) {
      return;
    }
    copilotStreamManager.pushDelta(streamId, frame?.payload?.delta ?? "");
    return;
  }

  if (frame?.event === "copilot.done") {
    const streamId = String(frame?.payload?.streamId ?? "");
    if (!streamId) {
      return;
    }
    void copilotStreamManager.finish(streamId);
  }
});

const botOpenId = await resolveBotOpenId(feishuClient);
const dedup = createMessageDedup();
let warnedUnknownBotOpenId = false;
const interceptReviewWorker = createInterceptReviewWorker({ feishuCfg, feishuClient });
interceptReviewWorker.start();

console.log(
  `[feishu-bridge] config: appId=${maskSecret(feishuCfg.appId)} domain=${feishuCfg.domain} mode=${feishuCfg.connectionMode} requireMentionInGroup=${feishuCfg.requireMentionInGroup}`,
);
console.log(
  `[feishu-bridge] copilot stream: enabled=${feishuCfg.copilotStreamEnabled} flushIntervalMs=${feishuCfg.copilotStreamFlushIntervalMs} minChunkChars=${feishuCfg.copilotStreamMinChunkChars}`,
);
console.log(
  `[feishu-bridge] routing: totalShards=${feishuCfg.routeTotalShards} shardIndex=${feishuCfg.routeShardIndex} salt=${feishuCfg.routeSalt}`,
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

    const copilotSessionKey = makeFeishuConversationScope({
      appId: feishuCfg.appId,
      chatType,
      chatId,
      senderOpenId,
    });
    const routeDecision = shouldHandleFeishuConversation(copilotSessionKey, feishuCfg);
    if (!routeDecision.shouldHandle) {
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
    if (!text && inbound.kind !== "image" && inbound.kind !== "file") {
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

    const isCopilot = copilotCfg.enabled;

    const reactionEmojiType = resolveReactionEmojiType({
      text,
      copilotCfg,
    });

    // 先贴一个"正在处理"的表情回应（命令消息可返回空字符串以跳过）
    if (reactionEmojiType) {
      try {
        await feishuClient.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: reactionEmojiType } },
        });
      } catch (e) {
        console.warn(`[feishu-bridge] add reaction failed: ${e?.message ?? e}`);
      }
    }

    let pendingAttachmentCleanupItems = [];
    try {
      let reply;

      const runCopilotRequest = async (prompt) => {
        if (!feishuCfg.copilotStreamEnabled) {
          return gatewayClient.request("copilot", { prompt, sessionKey: copilotSessionKey });
        }

        const effectiveStreamId = copilotStreamManager.create(chatId, messageId);

        try {
          const payload = await gatewayClient.request("copilot", {
            prompt,
            sessionKey: copilotSessionKey,
            stream: true,
            streamId: effectiveStreamId,
          });
          await copilotStreamManager.finish(effectiveStreamId);
          return payload;
        } catch (error) {
          await copilotStreamManager.finish(effectiveStreamId);
          throw error;
        }
      };

      if (isCopilot && !text && (inbound.kind === "image" || inbound.kind === "file")) {
        const downloadedResource = await downloadFeishuResourceToTemp({
          feishuCfg,
          messageId,
          resourceKey: inbound.kind === "image" ? inbound.imageKey : inbound.fileKey,
          resourceType: inbound.kind,
          fileNameHint: inbound.fileName,
        });

        const pendingCount = await appendPendingAttachment(copilotSessionKey, {
          kind: inbound.kind,
          filePath: downloadedResource.filePath,
          fileName: downloadedResource.fileName,
          contentType: downloadedResource.contentType,
          size: downloadedResource.size,
          receivedAtMs: Date.now(),
        });

        await sendFeishuText({
          feishuClient,
          chatId,
          replyToMessageId: messageId,
          text: `已收到${inbound.kind === "image" ? "图片" : "文件"}（当前已缓存 ${pendingCount} 个附件）。请在 ${Math.floor(
            ATTACHMENT_LISTEN_WINDOW_MS / 60_000,
          )} 分钟内发送一条文本消息，我会把这些附件作为上下文一起处理。`,
          renderAsMarkdown: feishuCfg.replyMarkdown,
        });
        return;
      }

      const commandReply = await routeCommand({
        text,
        gatewayClient,
        runCopilotRequest,
        copilotCfg,
        gitCfg,
        sqlCfg,
        serviceCfg,
        chatId,
        senderOpenId,
      });
      if (commandReply !== null) {
        reply = String(commandReply).trim();
      }

      if (!reply && isCopilot) {
        let prompt = text.trim();
        const pendingAttachmentPayload = await consumePendingAttachmentContext(
          copilotSessionKey,
          feishuCfg.fileMaxTextChars,
        );
        pendingAttachmentCleanupItems = pendingAttachmentPayload.items;
        if (pendingAttachmentPayload.context) {
          prompt = [
            pendingAttachmentPayload.context,
            "用户本条文本消息如下：",
            prompt,
          ].join("\n\n");
        }

        if (!prompt) {
          return;
        }
        console.log(
          `[feishu-bridge] copilot request from user=${senderOpenId} kind=${inbound.kind} prompt=${clipText(prompt, 120)}`,
        );
        const copilotPayload = await runCopilotRequest(prompt) as GatewayCopilotResponse;
        reply = String(copilotPayload?.output ?? "").trim();
      } else if (!reply) {
        if (inbound.kind === "image" || inbound.kind === "file") {
          reply = "当前仅 copilot 模式支持图片/文件处理，请启用 COPILOT_ENABLED=true 后重试。";
        } else {
          reply = "当前已关闭 agent 会话回退链路，请启用 COPILOT_ENABLED=true 后重试。";
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
        renderAsMarkdown: feishuCfg.replyMarkdown,
      });
    } catch (error) {
      console.error(`[feishu-bridge] handle message failed: ${String(error?.message ?? error)}`);
      try {
        await sendFeishuText({
          feishuClient,
          chatId,
          replyToMessageId: messageId,
          text: `[error] ${String(error?.message ?? error)}`,
          renderAsMarkdown: feishuCfg.replyMarkdown,
        });
      } catch (replyError) {
        console.error(`[feishu-bridge] error reply failed: ${String(replyError?.message ?? replyError)}`);
      }
    } finally {
      if (pendingAttachmentCleanupItems.length > 0) {
        await cleanupAttachmentItems(pendingAttachmentCleanupItems);
      }
    }
  },
  // SDK typing does not model return values here, but websocket card callbacks do support returning updated card payloads.
  "card.action.trigger": ((payload) => interceptReviewWorker.handleCardAction(payload)),
});

wsClient.start({ eventDispatcher: dispatcher });
console.log("[feishu-bridge] websocket client started");

const shutdown = () => {
  interceptReviewWorker.stop();
  gatewayClient.close();
  try {
    const maybeWsClient = wsClient as unknown as WsClientCompat;
    if (typeof maybeWsClient.stop === "function") {
      maybeWsClient.stop();
    } else if (typeof maybeWsClient.disconnect === "function") {
      maybeWsClient.disconnect();
    }
  } catch {
    // Ignore shutdown cleanup errors.
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
