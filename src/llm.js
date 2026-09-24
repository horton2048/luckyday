// OpenAI 兼容 chat completions，带 MCP 工具 + 本地伪工具的函数调用 loop。
import { mcpCallTool, mcpListTools } from "./mcpClient.js";
import { taskSignal, assertTaskActive } from './taskContext.js';
import { cleanHistory } from './session.js';

// 工具 schema 直接从 MCP 服务器的 tools/list 拉取并原样转发给模型，
// 不再手写猜测参数名——手写的 items/quantity 曾经是猜错的，真实字段是 productList/amount。
let cachedMcpTools = null;

export async function loadMcpTools(mcpUrl, mcpToken, { additionalServers = [] } = {}) {
  const servers = [{ url: mcpUrl, token: mcpToken }, ...additionalServers];
  const rawLists = await Promise.all(servers.map((server) => mcpListTools(server.url, server.token)));
  const raw = rawLists.flat();
  cachedMcpTools = raw.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  return cachedMcpTools;
}

// 许愿池的"本地伪工具"：菜单确实做不出来时调用，把这杯记进愿望池。
// 不打 MCP，只是让模型用结构化方式报告"为什么做不出来"，代码据此写愿望 + 回卡片。
// 用户原话由代码从消息里直接取，不经过模型改写——这是许愿池的底线：原话永远不被覆盖。
export const SAVE_WISH_TOOL = {
  type: "function",
  function: {
    name: "saveWish",
    description:
      "菜单里确实找不到接近的商品、用户想要的这杯现在做不出来时调用，把它记进许愿池。" +
      "调用前必须先用 searchProductForMcp 在门店里查过、确认真的没有接近的商品。" +
      "用户的原话会被系统完整保留，你不要改写、不要替它起名，只补充结构化字段和做不出来的原因。",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "object",
          description: "从用户话里能确定的口味维度，填不出来的留空",
          properties: {
            taste: { type: "string" },
            coffeeIntensity: { type: "string" },
            temperature: { type: "string" },
            sweetness: { type: "string" },
            flavor: { type: "string" },
          },
        },
        gapReason: {
          type: "string",
          description: "为什么现有菜单做不出这杯（缺少什么风味/形态/配料），要具体，不要只写\"没有这个产品\"",
        },
      },
      required: ["gapReason"],
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
function extractKnownProductPairs(messages, deptId) {
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
  const calls = new Map();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) calls.set(call.id, call.function);
    if (m.role !== "tool") continue;
    try {
      const call = calls.get(m.tool_call_id);
      if (!["searchProductForMcp", "queryProductDetailInfo", "switchProduct"].includes(call?.name)) continue;
      const args = JSON.parse(call.arguments);
      if (String(args.deptId) !== String(deptId)) continue;
      const result = JSON.parse(m.content);
      if (result.error || result.success === false || (result.code != null && Number(result.code) !== 0)) continue;
      visit(result.data);
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
      signal: taskSignal(90_000),
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

// 一次性的 JSON 判断调用（不带工具、不维护历史）：许愿池的语义聚类用它。
// 有的模型不认 response_format，所以改成"提示里要 JSON + 从回复里抠第一段 JSON"，
// 兼容性最好；抠不出来就当失败，由调用方降级处理。
export async function chatJson({ system, user, maxTokens = 500 }) {
  const data = await callLlmWithRetry({
    model: process.env.LLM_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
  });
  const content = data?.choices?.[0]?.message?.content ?? "";
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM 未返回可解析的 JSON: ${content.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {array} opts.history
 * @param {string} opts.mcpUrl
 * @param {string} opts.mcpToken
 * @param {array} [opts.extraTools] 额外的本地伪工具（如 SAVE_WISH_TOOL）
 * @param {(name: string, args: object) => object|null} [opts.localToolHandler]
 *        命中本地伪工具名时调用；返回值会作为 tool 消息内容回填给模型继续对话。
 *        如果 handler 返回 { __stop: true, ... } 则立即结束这轮，把 rest 字段透传给调用方。
 */
export async function runBaristaTurn({ systemPrompt, history, mcpUrl, mcpToken, mcpServers = [], extraTools = [], localToolHandler, cardMode = false, disableMcp = false, lockedDeptId = null }) {
  const messages = [{ role: "system", content: systemPrompt }, ...cleanHistory(history, 100)];
  const tools = [...(disableMcp ? [] : (cachedMcpTools ?? [])), ...extraTools].filter(t => !cardMode || !['createOrder', 'scheduleOrder'].includes(t.function.name));
  const localToolNames = new Set(extraTools.map((t) => t.function.name));
  let orderQrCodeUrl = null;
  let orderedItems = null;
  let previewOrder = null;
  let missingPreviewRetries = 0;

  const MAX_STEPS = 10;
  for (let step = 0; step < MAX_STEPS; step++) {
    assertTaskActive();
    const data = await callLlmWithRetry({
      model: process.env.LLM_MODEL,
      messages,
      tools,
      thinking: { type: "disabled" },
    });
    const msg = data.choices[0].message;

    if (!msg.tool_calls?.length) {
      // Models sometimes quote catalog prices and ask for confirmation without previewing.
      // That produces text only, bypassing the confirmation-card path in server.js.
      const asksToConfirm = /确认.{0,8}(下单|订单|支付)|是否.{0,8}(下单|支付)|可以.{0,4}下单|要.{0,4}下单吗/.test(msg.content ?? "");
      if (!previewOrder && !orderQrCodeUrl && asksToConfirm) {
        if (missingPreviewRetries++ < 2 && step < MAX_STEPS - 1) {
          messages.push(msg, { role: "system", content: "程序校验：本轮尚未取得成功的 previewOrder。不能用商品目录价格让用户确认下单。请对当前门店、当前商品和数量调用 previewOrder；信息不足则询问缺失项，接口失败则明确说明，禁止假称订单已准备好。" });
          continue;
        }
        const fallback = { role: "assistant", content: "还没取得当前门店的有效报价，暂时无法生成确认卡，请稍后重试。" };
        return { reply: fallback.content, updatedHistory: [...messages.slice(1), fallback], orderQrCodeUrl, orderedItems, previewOrder: null };
      }
      // 必须把这轮的完整轨迹（含工具调用/结果）存回历史，否则下一轮模型会忘记
      // 真实的 productId/skuCode 等字段，转而凭记忆瞎编——这是之前踩到的真实 bug。
      return { reply: sanitizeReply(msg.content), updatedHistory: [...messages.slice(1), msg], orderQrCodeUrl, orderedItems, previewOrder };
    }

    messages.push(msg);
    // 模型有时会在同一条消息里一次性调用好几个工具（比如"顺手记个口味 + 同时把愿望记进许愿池"）。
    // 之前的 bug：遇到 __stop 工具就立刻 return，如果它不是这一批里最后一个，排在后面的
    // 工具调用永远得不到回应，historyi 里留下悬空 tool_call，下一轮直接被 LLM API 400 拒掉。
    // 现在改成：这一批全部处理完、每个都有回应之后，再统一决定要不要提前结束这一轮。
    let stopResult = null;
    for (const call of msg.tool_calls) {
      assertTaskActive();
      if (cardMode && ['createOrder','scheduleOrder'].includes(call.function.name)) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: '请通过订单卡片确认下单。' }) });
        continue;
      }
      const args = JSON.parse(call.function.arguments || "{}");
      if(lockedDeptId!=null && ['searchProductForMcp','queryProductDetailInfo','switchProduct','previewOrder','createOrder','scheduleOrder'].includes(call.function.name) && String(args.deptId)!==String(lockedDeptId)) {
        previewOrder=null;
        messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({error:'门店与用户已选门店不一致，已拦截。请使用已确认的 deptId 重新查询商品。',deptId:lockedDeptId})});
        continue;
      }
      if (previewOrder && args.deptId != null && String(args.deptId) !== String(previewOrder.args.deptId)) previewOrder = null;
      console.log(`[工具调用] step=${step} tool=${call.function.name} args=${JSON.stringify(args)}`);

      // 商品防幻觉校验：previewOrder/createOrder/scheduleOrder 三个都会让商品真正流向下单，
      // 必须在分发给本地工具或 MCP 之前统一拦一遍，不能因为 scheduleOrder 是本地工具就绕过去。
      if (["previewOrder", "createOrder", "scheduleOrder"].includes(call.function.name)) {
        if (call.function.name === "previewOrder") previewOrder = null;
        const knownPairs = extractKnownProductPairs(messages, args.deptId);
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
        // 地图工具使用 maps_ 前缀；其余工具仍走瑞幸 MCP。这样模型可以在同一轮
        // 先把“国贸附近”解析成坐标，再用瑞幸 queryShopList 找真实门店。
        const server = mcpServers.find((item) =>
          item.toolPrefix ? call.function.name.startsWith(item.toolPrefix) : item.toolNames?.includes(call.function.name)
        ) ?? { url: mcpUrl, token: mcpToken };
        result = await mcpCallTool(server.url, server.token, call.function.name, args);
        console.log(`[工具结果] tool=${call.function.name} result=${JSON.stringify(result).slice(0, 500)}`);
        if (call.function.name === "createOrder" && result?.data?.payOrderQrCodeUrl) {
          orderQrCodeUrl = result.data.payOrderQrCodeUrl;
          orderedItems = args.productList ?? args.items ?? null;
        }
        if (call.function.name === "previewOrder" && result?.data && !result.error && result.success !== false && (result.code == null || Number(result.code) === 0)) {
          previewOrder = { args, result };
        }
      } catch (err) {
        result = { error: String(err) };
        console.error(`[工具失败] tool=${call.function.name} error=${err.stack || err}`);
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }

    if (stopResult) {
      return { ...stopResult, updatedHistory: messages.slice(1), previewOrder };
    }
  }

  console.error(`[超出最大步数] MAX_STEPS=${MAX_STEPS} 达到上限仍未收敛，最后几条消息:`, JSON.stringify(messages.slice(-4)));
  return { reply: "抱歉，这一步处理时间有点长，可以再说一次你的需求吗？", updatedHistory: history };
}
