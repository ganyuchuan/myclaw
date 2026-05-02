import path from "node:path";
import { runCopilotWithSession } from "./copilot.js";

type SqlToolConfig = {
  workDir?: string;
  dbFile?: string;
  schemaHint?: string;
};

type CopilotRuntimeConfig = {
  enabled?: boolean;
  workDir?: string;
  reuseSession?: boolean;
  timeoutMs?: number;
  model?: string;
  allowAllTools?: boolean;
  skillsFile?: string;
  mcpConfigFile?: string;
  hookEnabled?: boolean;
  blockedTools?: string[];
  restrictedDirTools?: string[];
  allowedDirs?: string[];
  askBeforeDestructive?: boolean;
  destructiveTools?: string[];
  permissionRequestMode?: "auto" | "approve" | "deny" | "delegate";
  interceptEnabled?: boolean;
  interceptTools?: string[];
  interceptServerUrl?: string;
  interceptAuthToken?: string;
  interceptTimeoutMs?: number;
  interceptFailOpen?: boolean;
  interceptPollIntervalMs?: number;
  interceptMaxWaitMs?: number;
};

type RunSqlRequestInput = {
  text?: string;
  config?: SqlToolConfig;
  copilotConfig?: CopilotRuntimeConfig;
};

function buildSqlGenerationPrompt({
  nlQuery,
  dbFile,
  schemaHint,
}: {
  nlQuery: string;
  dbFile: string;
  schemaHint: string;
}) {
  const schemaBlock = schemaHint
    ? `已知 schema 信息（可能不完整）：\n${schemaHint}\n`
    : "";

  return [
    "你是 SQLite 专家。请把用户自然语言请求翻译成一条可执行的 SQLite SQL 语句并执行。要求：",
    "1) 执行完成后输出执行过的 SQL 语句以及对应的执行结果。",
    "2) 优先使用 SELECT 语句；如果需求明确要求写操作，才使用 INSERT/UPDATE/DELETE。",
    "3) 语句必须兼容 sqlite3 CLI。",
    `4) 如果本地没有数据库则创建，目标数据库文件: ${dbFile}`,
    schemaBlock,
    `用户请求: ${nlQuery}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runSqlRequest({
  text = "",
  config = {},
  copilotConfig = {},
}: RunSqlRequestInput) {
  const nlQuery = String(text ?? "").trim();
  if (!nlQuery) {
    throw new Error("sql.text is required");
  }

  if (!copilotConfig?.enabled) {
    throw new Error("copilot tool is disabled");
  }

  const workDir = config.workDir || copilotConfig.workDir || process.cwd();
  const dbFileRaw = String(config.dbFile ?? "data/myclaw.db").trim() || "data/myclaw.db";
  const dbFile = path.isAbsolute(dbFileRaw) ? dbFileRaw : path.resolve(workDir, dbFileRaw);

  const prompt = buildSqlGenerationPrompt({
    nlQuery,
    dbFile,
    schemaHint: String(config.schemaHint ?? "").trim(),
  });

  const { output, sessionId } = await runCopilotWithSession({
    prompt,
    config: {
      ...copilotConfig,
      reuseSession: false,
    },
  });

  return {
    ok: true,
    naturalLanguage: nlQuery,
    dbFile,
    output: String(output ?? "").trim(),
    sessionId,
  };
}
