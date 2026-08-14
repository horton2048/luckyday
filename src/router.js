// 轻量意图分类：判断这轮该走"直接下单"还是"DIY 收集"。
// 单独一次极简调用，不带工具、不带长提示词，保证判断本身也快也准。
export async function classifyIntent({ userText, currentMode }) {
  const prompt = `判断用户这句话属于哪种意图，只回答 order 或 diy，不要任何其他文字。
- order：用户已经明确知道要点什么瑞幸商品（商品名、或"帮我点一杯/来一杯+具体描述"）。
- diy：用户在描述模糊的偏好/灵感，还没有明确到具体商品，或者是在回答 DIY 访谈中的追问（选项/口感/风味等）。

当前会话状态：${currentMode ?? "无（新会话）"}
用户说：${userText}`;

  const res = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      thinking: { type: "disabled" },
      max_tokens: 10,
    }),
  });
  if (!res.ok) throw new Error(`意图分类 HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices[0].message.content.trim().toLowerCase();
  return text.includes("order") ? "order" : "diy";
}
