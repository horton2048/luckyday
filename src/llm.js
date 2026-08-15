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

// 预约下单：不立刻 createOrder，把已经用 previewOrder 验证过的真实 productList 存起来，
// 到约定时间由服务器端的调度器自动 createOrder。跟 previewOrder/createOrder 一样必须防幻觉校验。
export const SCHEDULE_ORDER_TOOL = {
  type: "function",
  function: {
    name: "scheduleOrder",
    description:
      "用户明确要求把已经用 previewOrder 报价确认过的订单，安排到未来某个时间点自动下单" +
      "（而不是现在立刻下单）时调用。deptId/productList 必须是本轮 previewOrder 真实验证过的值。" +
      "调用后不会立刻下单，到点由系统自动执行并推送支付二维码。",
    parameters: {
      type: "object",
      properties: {
        executeAt: {
          type: "string",
          description: "ISO 8601 时间（带时区），比如 2026-08-16T08:00:00+08:00，代表几点自动下单，" +
            "需要结合对话里系统提示的当前时间换算相对时间（比如'明天早上8点'）",
        },
        deptId: { type: "number" },
        productList: {
          type: "array",
          items: {
            type: "object",
            properties: {
              amount: { type: "number" },
              productId: { type: "number" },
              skuCode: { type: "string" },
            },
            required: ["amount", "productId", "skuCode"],
          },
        },
        longitude: { type: "number" },
        latitude: { type: "number" },
        couponCodeList: { type: "array", items: { type: "string" }, description: "可选" },
        summary: { type: "string", description: "给用户看的一句话摘要，比如'明天8点 生椰杨枝甘露 超大杯'" },
      },
      required: ["executeAt", "deptId", "productList", "summary"],
    },
  },
};

// 口味记忆：用户在对话里（不管最后有没有下单）明确说出自己或某位同事的偏好时调用，
// 方便以后"按大家平时的口味"直接点单，不用每次重新问一遍。这是个静默记录工具，
// 不打断对话主线——调用后正常继续当前流程即可，不需要 __stop。
export const RECORD_TASTE_TOOL = {
  type: "function",
  function: {
    name: "recordTaste",
    description:
      "当用户明确说出自己或某位同事的口味偏好时调用（不管最后有没有下单），比如" +
      "'我不喝咖啡'、'XX喜欢清爽果香的'、'XX只喝美式'。用于以后自动按记忆点单。" +
      "只有这轮对话里真的听到了具体内容才调用；不知道某人口味时绝对不要编一个" +
      "'待确认'/'待定'这样的占位内容调用本工具去'占坑'——宁可不调用，也不能用占位覆盖掉" +
      "可能已经存在的真实记录。系统提示里给出的\"已知口味偏好\"是历史记忆，用来参考回答，" +
      "不需要针对这些历史记忆再调用本工具。",
    parameters: {
      type: "object",
      properties: {
        person: { type: "string", description: "这个偏好是谁的：'self' 表示当前说话人自己，否则填群里那个人的真实姓名" },
        summary: { type: "string", description: "一句话口味总结，比如'不喝咖啡，喜欢清爽果香、不加糖'" },
      },
      required: ["person", "summary"],
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
    // 模型有时会在同一条消息里一次性调用好几个工具（比如"顺手记个口味 + 同时收敛 DIY"）。
    // 之前的 bug：遇到 __stop 工具就立刻 return，如果它不是这一批里最后一个，排在后面的
    // 工具调用永远得不到回应，historyi 里留下悬空 tool_call，下一轮直接被 LLM API 400 拒掉。
    // 现在改成：这一批全部处理完、每个都有回应之后，再统一决定要不要提前结束这一轮。
    let stopResult = null;
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      console.log(`[工具调用] step=${step} tool=${call.function.name} args=${JSON.stringify(args)}`);

      // 商品防幻觉校验：previewOrder/createOrder/scheduleOrder 三个都会让商品真正流向下单，
      // 必须在分发给本地工具或 MCP 之前统一拦一遍，不能因为 scheduleOrder 是本地工具就绕过去。
      if (["previewOrder", "createOrder", "scheduleOrder"].includes(call.function.name)) {
        const knownPairs = extractKnownProductPairs(messages);
        const ungrounded = findUngroundedItems(args, knownPairs);
        if (ungrounded.length > 0) {
          console.error(`[拦截未验证商品] tool=${call.function.name} ungrounded=${JSON.stringify(ungrounded)}`);
          const result = {
            error:
              "这些商品的 productId/skuCode 在本次对话里没有被 searchProductForMcp 或 queryProductDetailInfo 真实验证过，禁止直接下单/预约/预览。请先调用 searchProductForMcp 查到真实商品，再用查到的真实字段重试。",
            ungroundedItems: ungrounded,
          };
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          continue;
        }
      }

      if (localToolNames.has(call.function.name)) {
        const handled = await localToolHandler?.(call.function.name, args);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(handled ?? {}) });
        if (handled?.__stop && !stopResult) stopResult = handled;
        continue;
      }

      let result;
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

    if (stopResult) {
      return { ...stopResult, updatedHistory: messages.slice(1) };
    }
  }

  console.error(`[超出最大步数] MAX_STEPS=${MAX_STEPS} 达到上限仍未收敛，最后几条消息:`, JSON.stringify(messages.slice(-4)));
  return { reply: "抱歉，这一步处理时间有点长，可以再说一次你的需求吗？", updatedHistory: history };
}
