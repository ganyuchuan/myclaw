export async function generateAssistantReply({ messages, apiKey, model }) {
  if (!apiKey) {
    const lastUser = [...messages].reverse().find((msg) => msg.role === "user");
    const text = lastUser?.content || "";
    return `MVP fallback reply: ${text.slice(0, 400)}`;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const json = await response.json();
  const outputText = json.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText;
  }

  return "模型返回成功，但没有可解析的文本输出。";
}
