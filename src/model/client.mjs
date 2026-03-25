function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseSseJsonLine(raw) {
  const line = raw.trim();
  if (!line) {
    return null;
  }

  if (!line.startsWith("data:")) {
    return null;
  }

  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") {
    return null;
  }

  return JSON.parse(payload);
}

function extractChatDeltaText(chunk) {
  const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
  let text = "";

  for (const choice of choices) {
    const content = choice?.delta?.content;
    if (typeof content === "string") {
      text += content;
      continue;
    }

    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === "string") {
          text += part.text;
        }
      }
    }
  }

  return text;
}

async function collectChatCompletionStream(response) {
  if (!response.body) {
    throw new Error("LLM response missing body stream");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      let chunk;
      try {
        chunk = parseSseJsonLine(line);
      } catch {
        continue;
      }

      if (!chunk) {
        continue;
      }

      result += extractChatDeltaText(chunk);
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      const chunk = parseSseJsonLine(tail);
      if (chunk) {
        result += extractChatDeltaText(chunk);
      }
    } catch {
      // Ignore malformed tail chunk from streamed transport.
    }
  }

  return result;
}

function getFallbackReply(messages, provider) {
  const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
  const text = lastUser?.content || "";
  return `${provider || "LLM"} fallback reply: ${text.slice(0, 400)}`;
}

async function requestChatCompletions({ messages, llm }) {
  const stream = parseBoolean(llm.stream, true);
  const response = await fetch(llm.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      messages,
      stream,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  if (stream) {
    const text = await collectChatCompletionStream(response);
    if (text.trim()) {
      return text;
    }
    throw new Error("LLM returned success but no stream text could be parsed");
  }

  const json = await response.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text === "string" && text.trim()) {
    return text;
  }

  throw new Error("LLM returned success but no chat completion text could be parsed");
}

async function requestResponses({ messages, llm }) {
  const response = await fetch(llm.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      input: messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const json = await response.json();
  const outputText = json?.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText;
  }

  throw new Error("LLM returned success but no responses text could be parsed");
}

export async function generateAssistantReply({ messages, llm }) {
  if (!llm?.apiKey) {
    return getFallbackReply(messages, llm?.provider);
  }

  if (!llm?.endpoint) {
    throw new Error("LLM endpoint is required; set LLM_ENDPOINT in .env");
  }

  const protocol = String(llm.protocol || "chat_completions").toLowerCase();
  if (protocol === "chat_completions") {
    return requestChatCompletions({ messages, llm });
  }

  if (protocol === "responses") {
    return requestResponses({ messages, llm });
  }

  throw new Error(`unsupported llm protocol: ${protocol}`);
}