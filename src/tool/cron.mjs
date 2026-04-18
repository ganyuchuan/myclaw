import { runCopilotWithSession } from "./copilot.mjs";

const ALLOWED_ACTIONS = new Set(["list", "add", "update", "remove", "run"]);

function summarizeJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  return list.slice(0, 50).map((job) => ({
    id: String(job?.id ?? ""),
    name: String(job?.name ?? ""),
    enabled: Boolean(job?.enabled),
    schedule: job?.schedule ?? null,
    action: String(job?.payload?.action ?? ""),
  }));
}

function extractJsonObject(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try next candidate.
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const maybe = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(maybe);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function buildCronPlannerPrompt({ nlQuery, jobs }) {
  const jobsBlock = JSON.stringify(summarizeJobs(jobs), null, 2);

  return [
    "你是 Cron 调度专家。请把用户自然语言请求转换为一个 JSON 指令。",
    "你只能输出一个 JSON 对象，不要输出 markdown 或其他解释。",
    "JSON 格式:",
    '{"action":"list|add|update|remove|run","reason":"简短中文理由","params":{}}',
    "规则:",
    "1) action 只能是 list/add/update/remove/run。",
    "2) list 的 params 必须是 {}。",
    "3) run/remove 必须提供 params.id。",
    "4) update 必须提供 params.id，其他字段放在 params 中。",
    '5) add 必须提供 name/schedule/payload，例如 schedule={"type":"every","value":60000}。',
    '6) payload.action 仅允许 "copilot" 且 payload.params.prompt 字段值是：过滤过时间信息的用户自然语言。',
    "7) 如果用户需求不明确，优先返回 action 猜测用户意图对应哪步动作，reason 说明相关动作缺少哪些关键信息。",
    "当前任务快照（可能为空）:",
    jobsBlock,
    `用户请求: ${nlQuery}`,
  ].join("\n");
}

export async function planCronOperation({ text = "", copilotConfig = {}, jobs = [] }) {
  const nlQuery = String(text ?? "").trim();
  if (!nlQuery) {
    throw new Error("cron.nl.text is required");
  }

  if (!copilotConfig?.enabled) {
    throw new Error("copilot tool is disabled");
  }

  const prompt = buildCronPlannerPrompt({ nlQuery, jobs });
  const { output, sessionId } = await runCopilotWithSession({
    prompt,
    config: {
      ...copilotConfig,
      reuseSession: false,
    },
  });

  const parsed = extractJsonObject(output);
  if (!parsed) {
    throw new Error("copilot cron planner did not return valid JSON");
  }

  const action = String(parsed?.action ?? "").trim().toLowerCase();
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`unsupported cron action from planner: ${action || "unknown"}`);
  }

  const params = parsed?.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
    ? parsed.params
    : {};

  return {
    ok: true,
    naturalLanguage: nlQuery,
    interpreted: {
      action,
      reason: String(parsed?.reason ?? "").trim(),
      params,
    },
    output: String(output ?? "").trim(),
    sessionId,
  };
}