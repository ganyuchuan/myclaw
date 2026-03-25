function extractDeltaText(chunk) {
  const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
  if (choices.length === 0) {
    return "";
  }

  const delta = choices[0]?.delta;
  if (!delta || typeof delta !== "object") {
    return "";
  }

  return typeof delta.content === "string" ? delta.content : "";
}

function parseJsonLine(raw) {
  const line = raw.trim();
  if (!line) {
    return null;
  }

  if (line.startsWith("data:")) {
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return null;
    }
    return JSON.parse(payload);
  }

  if (line === "[DONE]") {
    return null;
  }

  return JSON.parse(line);
}

export async function generateDoubaoReply({ messages, apiKey, model, endpoint }) {
  if (!apiKey) {
    const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
    const text = lastUser?.content || "";
    return `Doubao fallback reply: ${text.slice(0, 400)}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Doubao request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  if (!response.body) {
    throw new Error("Doubao response missing body stream");
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
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let chunk;
      try {
        chunk = parseJsonLine(trimmed);
      } catch {
        continue;
      }

      if (!chunk) {
        continue;
      }

      result += extractDeltaText(chunk);
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      const chunk = parseJsonLine(tail);
      if (chunk) {
        result += extractDeltaText(chunk);
      }
    } catch {
      // Ignore malformed tail chunk from streamed transport.
    }
  }

  if (result.trim()) {
    return result;
  }

  throw new Error("Doubao returned success but no text delta could be parsed");
}