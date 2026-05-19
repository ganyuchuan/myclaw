function toText(value: unknown): string {
  return String(value ?? "").trim();
}

type CollectTextOptions = {
  maxDepth?: number;
  maxItems?: number;
  maxTextLength?: number;
};

function collectTextFragments(value: unknown, options: CollectTextOptions = {}): string[] {
  const {
    maxDepth = 6,
    maxItems = 120,
    maxTextLength = 2000,
  } = options;

  const fragments: string[] = [];
  const seen = new WeakSet<object>();

  const pushText = (text: string) => {
    const trimmed = toText(text);
    if (!trimmed) {
      return;
    }
    fragments.push(trimmed.length > maxTextLength ? `${trimmed.slice(0, maxTextLength)}...` : trimmed);
  };

  const walk = (input: unknown, depth: number) => {
    if (fragments.length >= maxItems || depth > maxDepth || input === null || input === undefined) {
      return;
    }

    if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
      pushText(String(input));
      return;
    }

    if (Array.isArray(input)) {
      for (const item of input) {
        walk(item, depth + 1);
        if (fragments.length >= maxItems) {
          break;
        }
      }
      return;
    }

    if (typeof input === "object") {
      if (seen.has(input as object)) {
        return;
      }
      seen.add(input as object);

      const record = input as Record<string, unknown>;
      const prioritizedKeys = [
        "text",
        "content",
        "message",
        "prompt",
        "output",
        "deltaContent",
        "reasoning",
        "error",
        "args",
        "result",
      ];

      for (const key of prioritizedKeys) {
        if (key in record) {
          walk(record[key], depth + 1);
        }
      }

      const entries = Object.entries(record).slice(0, 24);
      for (const [key, nested] of entries) {
        if (prioritizedKeys.includes(key)) {
          continue;
        }
        if (typeof nested === "string") {
          pushText(`${key}: ${nested}`);
          continue;
        }
        walk(nested, depth + 1);
        if (fragments.length >= maxItems) {
          break;
        }
      }
    }
  };

  walk(value, 0);
  return fragments;
}

export function estimateContentTokens(value: unknown): number {
  const fragments = collectTextFragments(value);
  if (fragments.length === 0) {
    return 0;
  }
  return fragments.reduce((total, item) => total + estimateTextTokens(item), 0);
}

export function truncatePreview(value: unknown, maxLength = 160): string {
  const text = toText(value);
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function estimateTextTokens(value: unknown): number {
  const text = toText(value);
  if (!text) {
    return 0;
  }

  const cjkChars = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
  const asciiChars = text.length - cjkChars;
  const asciiTokens = Math.ceil(Math.max(0, asciiChars) / 4);
  return Math.max(1, cjkChars + asciiTokens);
}

export function estimateToolCallTokens({
  toolName,
  toolArgs,
  toolResult,
}: {
  toolName?: unknown;
  toolArgs?: unknown;
  toolResult?: unknown;
}): {
  toolName: string;
  argsTokens: number;
  resultTokens: number;
  totalTokens: number;
  argsPreview: string;
  resultPreview: string;
} {
  const normalizedToolName = toText(toolName).toLowerCase() || "unknown";
  const argsTokens = estimateContentTokens(toolArgs);
  const resultTokens = estimateContentTokens(toolResult);
  const argsPreview = truncatePreview(collectTextFragments(toolArgs).join("\n"), 180);
  const resultPreview = truncatePreview(collectTextFragments(toolResult).join("\n"), 180);

  return {
    toolName: normalizedToolName,
    argsTokens,
    resultTokens,
    totalTokens: argsTokens + resultTokens,
    argsPreview,
    resultPreview,
  };
}

function estimateConversationTokens({
  prompt,
  output,
  entries = [],
}: {
  prompt?: unknown;
  output?: unknown;
  entries?: unknown[];
}): number {
  const promptTokens = estimateTextTokens(prompt);
  const outputTokens = estimateTextTokens(output);
  let entryTokens = 0;
  if (Array.isArray(entries)) {
    for (const item of entries) {
      entryTokens += estimateTextTokens(item);
    }
  }

  const baseTokens = promptTokens + outputTokens;
  if (baseTokens > 0) {
    return baseTokens;
  }

  return entryTokens;
}

export function estimateConversationTokenBreakdown({
  prompt,
  output,
  entries = [],
}: {
  prompt?: unknown;
  output?: unknown;
  entries?: unknown[];
}): {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  promptPreview: string;
  outputPreview: string;
} {
  const promptText = toText(prompt);
  const outputText = toText(output);
  const promptTokens = estimateTextTokens(promptText);
  const outputTokens = estimateTextTokens(outputText);
  const totalTokens = promptTokens + outputTokens;

  if (totalTokens > 0) {
    return {
      promptTokens,
      outputTokens,
      totalTokens,
      promptPreview: truncatePreview(promptText, 160),
      outputPreview: truncatePreview(outputText, 160),
    };
  }

  const fallbackEntries = Array.isArray(entries)
    ? entries.map((item) => toText(item)).filter(Boolean)
    : [];
  const fallbackText = fallbackEntries.join("\n");
  const fallbackTokens = estimateConversationTokens({ prompt, output, entries });
  return {
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: fallbackTokens,
    promptPreview: "",
    outputPreview: truncatePreview(fallbackText, 160),
  };
}