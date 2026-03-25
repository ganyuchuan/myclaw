import dotenv from "dotenv";

dotenv.config();

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: toInt(process.env.PORT, 18789),
  gatewayToken: process.env.GATEWAY_TOKEN?.trim() || "dev-token",
  defaultProvider: process.env.LLM_PROVIDER?.trim().toLowerCase() || "openai",
  openAiApiKey: process.env.OPENAI_API_KEY?.trim() || "",
  openAiModel: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
  doubaoApiKey: process.env.DOUBAO_API_KEY?.trim() || "",
  doubaoModel: process.env.DOUBAO_MODEL?.trim() || "doubao-1-5-pro-32k-250115",
  doubaoEndpoint:
    process.env.DOUBAO_ENDPOINT?.trim() || "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  maxPayloadBytes: 1024 * 1024,
};
