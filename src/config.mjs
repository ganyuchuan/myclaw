import dotenv from "dotenv";

dotenv.config();

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: toInt(process.env.PORT, 18789),
  gatewayToken: process.env.GATEWAY_TOKEN?.trim() || "dev-token",
  llm: {
    provider: process.env.LLM_PROVIDER?.trim().toLowerCase() || "openai",
    protocol: process.env.LLM_PROTOCOL?.trim().toLowerCase() || "responses",
    endpoint: process.env.LLM_ENDPOINT?.trim() || "https://api.openai.com/v1/responses",
    model: process.env.LLM_MODEL?.trim() || "gpt-4.1-mini",
    apiKey: process.env.LLM_API_KEY?.trim() || "",
    stream: process.env.LLM_STREAM?.trim() || "false",
  },
  maxPayloadBytes: 1024 * 1024,
};
