const BLOCK_MARKDOWN_PATTERNS = [
  /(^|\n)```[\s\S]*?```/,
  /(^|\n)~~~[\s\S]*?~~~/,
  /(^|\n)\s{0,3}#{1,6}\s+\S+/,
  /(^|\n)\s{0,3}>\s+\S+/,
  /(^|\n)\s{0,3}(?:[-*+]\s+\S+|\d+\.\s+\S+)/,
  /(^|\n)\s*\|.+\|\s*\n\s*\|(?:\s*:?-{3,}:?\s*\|)+/,
  /(^|\n)\s{0,3}(?:---+|\*\*\*+|___+)\s*(\n|$)/,
];

const INLINE_MARKDOWN_PATTERNS = [
  /!\[[^\]]*]\([^)]+\)/,
  /\[[^\]]+]\([^)]+\)/,
  /(^|[^\w])(?:\*\*|__)[^*_`\n]+(?:\*\*|__)(?=[^\w]|$)/,
  /(^|[^\w])~~[^~`\n]+~~(?=[^\w]|$)/,
  /`[^`\n]+`/,
];

function looksLikeMarkdown(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return false;
  }

  return (
    BLOCK_MARKDOWN_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    INLINE_MARKDOWN_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

function buildFeishuReplyPayload(text, allowMarkdownCard = false) {
  const normalized = String(text ?? "");
  if (!allowMarkdownCard || !looksLikeMarkdown(normalized)) {
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

export { buildFeishuReplyPayload, looksLikeMarkdown };
