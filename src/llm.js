// OpenAI 兼容 chat completions，带 MCP 工具 + 本地伪工具的函数调用 loop。
import { mcpCallTool, mcpListTools } from "./mcpClient.js";

// 工具 schema 直接从 MCP 服务器的 tools/list 拉取并原样转发给模型，
// 不再手写猜测参数名——手写的 items/quantity 曾经是猜错的，真实字段是 productList/amount。
let cachedMcpTools = null;

export async function loadMcpTools(mcpUrl, mcpToken) {
  const raw = await mcpListTools(mcpUrl, mcpToken);
  cachedMcpTools = raw.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  return cachedMcpTools;
}

// DIY 收集模式专用的"本地伪工具"：不打 MCP，只是让模型用结构化方式
// 报告收敛结果，代码据此决定"转下单"还是"写愿望单"，同时不把 JSON 暴露给用户。
export const RESOLVE_DIY_TOOL = {
  type: "function",
  function: {
    name: "resolveDiy",
    description:
      "DIY 收集访谈收敛时调用，报告结果。这不是真实下单，只是内部信号。" +
      "一次可以报告一杯或多杯（比如给几位同事分别点不同的），items 数组每条对应一杯。",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "每杯一条记录，至少一条",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "这杯是给谁的，比如'领导1'，单人单杯时可省略" },
              matched: { type: "boolean", description: "是否找到了接近的现有商品" },
              productHint: { type: "string", description: "matched=true 时，商品名称或关键词，用于后续 searchProductForMcp" },
              collected: {
                type: "object",
                description: "收集到的用户偏好",
                properties: {
                  taste: { type: "string" },
                  coffeeIntensity: { type: "string" },
                  temperature: { type: "string" },
                  sweetness: { type: "string" },
                  flavor: { type: "string" },
                },
              },
              gapReason: { type: "string", description: "matched=false 时，为什么现有菜单做不出来" },
            },
            required: ["matched"],
          },
        },
      },
      required: ["items"],
    },
  },
};

// MiniMax-M3 会自信地"记住"一些真实商品的 productId/skuCode（大概率是训练数据里见过瑞幸的公开信息），
// 哪怕本轮对话从没真正调用过 searchProductForMcp 查到这个商品，也能编出恰好合法的参数。
// 这在下单场景不可接受——蒙对是运气，蒙错就是真实扣错钱。所以 previewOrder/createOrder
// 的每个商品，必须能在"本会话真实工具结果"里追溯到同一个 productId+skuCode 组合，否则拦截。
function extractKnownProductPairs(messages) {
  const known = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === "object") {
      if (typeof node.productId !== "undefined" && typeof node.skuCode === "string") {
        known.add(`${node.productId}:${node.skuCode}`);
      }
      Object.values(node).forEach(visit);
    }
  };
  for (const m of messages) {
    if (m.role !== "tool") continue;
    try {
      visit(JSON.parse(m.content));
    } catch {
      // 非 JSON 的 tool 消息忽略
    }
  }
  return known;
}

function findUngroundedItems(args, knownPairs) {
  const list = args.productList ?? args.items ?? [];
  return list.filter((item) => !knownPairs.has(`${item.productId}:${item.skuCode}`));
}

// MiniMax-M3 偶发会把思考内容漏进正式回复（官方仓库已知问题），这里做兜底清洗；
// 同时飞书文本消息不渲染 Markdown，把常见 Markdown 符号去掉，保证收到的是纯文字。
function sanitizeReply(text) {
  if (!text) return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`{1,3}([^`]+?)`{1,3}/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*]\s+/gm, "· ")
    .trim();
}

// 429/5xx/529 是服务商那边的瞬时容量问题，重试大概率能过；400 之类是我们自己传参有问题，
// 重试没用、只会掩盖真实 bug，必须立刻抛出。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_LLM_RETRIES = 3;

async function callLlmWithRetry(body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();

    const text = await res.text();
    if (!RETRYABLE_STATUS.has(res.status) || attempt >= MAX_LLM_RETRIES) {
      throw new Error(`LLM HTTP ${res.status}: ${text}`);
    }
    const delayMs = 1000 * 2 ** attempt;
    console.error(`[LLM ${res.status}，${delayMs}ms 后重试 (${attempt + 1}/${MAX_LLM_RETRIES})] ${text.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {array} opts.history
 * @param {string} opts.mcpUrl
 * @param {string} opts.mcpToken
 * @param {array} [opts.extraTools] 额外的本地伪工具（如 RESOLVE_DIY_TOOL）
 * @param {(name: string, args: object) => object|null} [opts.localToolHandler]
 *        命中本地伪工具名时调用；返回值会作为 tool 消息内容回填给模型继续对话。
 *        如果 handler 返回 { __stop: true, ... } 则立即结束这轮，把 rest 字段透传给调用方。
 */
export async function runBaristaTurn({ systemPrompt, history, mcpUrl, mcpToken, extraTools = [], localToolHandler }) {
  const messages = [{ role: "system", content: systemPrompt }, ...history];
  const tools = [...(cachedMcpTools ?? []), ...extraTools];
  const localToolNames = new Set(extraTools.map((t) => t.function.name));
  let orderQrCodeUrl = null;
  let orderedItems = null;

  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await callLlmWithRetry({
      model: process.env.LLM_MODEL,
      messages,
      tools,
      thinking: { type: "disabled" },
    });
    const msg = data.choices[0].message;

    if (!msg.tool_calls?.length) {
      // 必须把这轮的完整轨迹（含工具调用/结果）存回历史，否则下一轮模型会忘记
      // 真实的 productId/skuCode 等字段，转而凭记忆瞎编——这是之前踩到的真实 bug。
      return { reply: sanitizeReply(msg.content), updatedHistory: [...messages.slice(1), msg], orderQrCodeUrl, orderedItems };
    }

    messages.push(msg);
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      console.log(`[工具调用] step=${step} tool=${call.function.name} args=${JSON.stringify(args)}`);

      if (localToolNames.has(call.function.name)) {
        const handled = localToolHandler?.(call.function.name, args);
        // 无论是否 __stop 提前结束，都必须先把这条 tool_call 的响应回填进历史，
        // 否则下一轮历史里会有一个没有回应的 tool_call，LLM API 会用 400 拒掉整个会话。
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(handled ?? {}) });
        if (handled?.__stop) {
          return { ...handled, updatedHistory: messages.slice(1) };
        }
        continue;
      }

      let result;
      if (call.function.name === "previewOrder" || call.function.name === "createOrder") {
        const knownPairs = extractKnownProductPairs(messages);
        const ungrounded = findUngroundedItems(args, knownPairs);
        if (ungrounded.length > 0) {
          console.error(`[拦截未验证商品] tool=${call.function.name} ungrounded=${JSON.stringify(ungrounded)}`);
          result = {
            error:
              "这些商品的 productId/skuCode 在本次对话里没有被 searchProductForMcp 或 queryProductDetailInfo 真实验证过，禁止直接下单/预览。请先调用 searchProductForMcp 查到真实商品，再用查到的真实字段重试。",
            ungroundedItems: ungrounded,
          };
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          continue;
        }
      }
      try {
        result = await mcpCallTool(mcpUrl, mcpToken, call.function.name, args);
        console.log(`[工具结果] tool=${call.function.name} result=${JSON.stringify(result).slice(0, 500)}`);
        if (call.function.name === "createOrder" && result?.data?.payOrderQrCodeUrl) {
          orderQrCodeUrl = result.data.payOrderQrCodeUrl;
          orderedItems = args.productList ?? args.items ?? null;
        }
      } catch (err) {
        result = { error: String(err) };
        console.error(`[工具失败] tool=${call.function.name} error=${err.stack || err}`);
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  console.error(`[超出最大步数] MAX_STEPS=${MAX_STEPS} 达到上限仍未收敛，最后几条消息:`, JSON.stringify(messages.slice(-4)));
  return { reply: "抱歉，这一步处理时间有点长，可以再说一次你的需求吗？", updatedHistory: history };
}
