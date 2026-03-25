import dotenv from "dotenv";

dotenv.config();

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: toInt(process.env.PORT, 18789),
  gatewayToken: process.env.GATEWAY_TOKEN?.trim() || "dev-token",
  openAiApiKey: process.env.OPENAI_API_KEY?.trim() || "",
  openAiModel: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
  maxPayloadBytes: 1024 * 1024,
};
