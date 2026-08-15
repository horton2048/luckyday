import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { mcpInitialize } from "./mcpClient.js";
import { runBaristaTurn, loadMcpTools, RESOLVE_DIY_TOOL, SCHEDULE_ORDER_TOOL, RECORD_TASTE_TOOL } from "./llm.js";
import { classifyIntent } from "./router.js";
import { appendWish } from "./wishlist.js";
import {
  getHistory,
  saveHistory,
  resetHistory,
  enqueueForUser,
  getMode,
  setMode,
  getDiyRound,
  incrDiyRound,
  pushDiyWords,
  getDiyWords,
} from "./session.js";
import { replyText, replyImageFromUrl, resolveUserName, getChatMembers } from "./feishu.js";
import { appendOrder, getRecentOrders } from "./tastes.js";
import { recordTaste, getTaste } from "./tasteProfiles.js";
import { addScheduledOrder, startScheduler } from "./scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORDER_PROMPT = readFileSync(join(__dirname, "../prompts/order.md"), "utf8");
const DIY_PROMPT = readFileSync(join(__dirname, "../prompts/diy.md"), "utf8");
const DIY_MAX_ROUNDS = 3;

const app = express();
app.use(express.json());

const seenEventIds = new Set(); // 飞书会重试投递，简单去重

app.post("/feishu/events", async (req, res) => {
  const body = req.body;

  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  res.status(200).send();

  const eventId = req.headers["x-tt-logid"] ?? body.header?.event_id;
  if (eventId) {
    if (seenEventIds.has(eventId)) return;
    seenEventIds.add(eventId);
  }

  if (body.header?.event_type !== "im.message.receive_v1") return;

  const event = body.event;
  if (event.message.message_type !== "text") return;

  const chatId = event.message.chat_id;
  const userId = event.sender.sender_id.open_id;
  const userText = JSON.parse(event.message.content)
    .text.replace(/@_user_\d+\s*/g, "")
    .trim();
  if (!userText) return;

  await enqueueForUser(userId, () => handleMessage(userId, chatId, userText));
});

// recordTaste 在 order/DIY 两种模式下都可能被调用，共用一份"person 名字 -> open_id"解析逻辑。
// 曾经真实踩过的坑：模型会在不确定的时候编一个"XX口味待确认"这种占位内容调用这个工具，
// 直接覆盖掉之前真实记录的偏好——所以这里必须拦一道，不能只靠 prompt 约束模型的行为。
const PLACEHOLDER_PATTERN = /待确认|待定|不明确|未知|不清楚/;

async function handleRecordTaste(userId, chatId, args) {
  const summary = (args.summary ?? "").trim();
  if (!summary || summary.length < 2 || PLACEHOLDER_PATTERN.test(summary)) {
    return { error: "summary 看起来是占位内容，不是真实听到的偏好，本次记录已拒绝。只有用户明确说出具体口味时才调用这个工具。" };
  }

  let targetId = userId;
  let targetName = null;
  if (args.person && args.person !== "self") {
    const members = await getChatMembers(chatId).catch(() => []);
    const match = members.find((m) => m.name === args.person || args.person.includes(m.name));
    if (match) {
      targetId = match.member_id;
      targetName = match.name;
    }
  }
  recordTaste(targetId, targetName, summary);
  return { ok: true };
}

async function handleMessage(userId, chatId, userText) {
  try {
    const currentMode = getMode(userId);
    const mode = await classifyIntent({ userText, currentMode });
    setMode(userId, mode);

    if (mode === "order") {
      await handleOrderTurn(userId, chatId, userText);
    } else {
      await handleDiyTurn(userId, chatId, userText);
    }
  } catch (err) {
    console.error("处理消息失败:", err);
    // 兜底自愈：这类"历史记录里有没回应的 tool_call"错误，一旦发生就是永久性的——
    // 同一份坏历史会在这个用户之后每一条消息里被重新发给 LLM，一直 400 到人工重启服务器为止。
    // 与其死等下次踩到同样的坑再手动重启，不如自动清掉这个用户的会话，最多丢这一轮对话。
    if (/tool.*id.*not found|tool_call_id/i.test(err.message ?? "")) {
      console.error(`[自愈] userId=${userId} 命中历史损坏特征，自动重置会话`);
      resetHistory(userId);
    }
    await replyText(chatId, "抱歉，刚才处理时出了点问题，可以再说一次吗？").catch(() => {});
  }
}

async function handleOrderTurn(userId, chatId, userText) {
  const history = getHistory(userId);

  // 每轮都带上当前时间，供模型换算"明天早上8点"这类相对时间（预约下单要用）。
  const nowStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  let hints = [`当前时间：${nowStr}（北京时间）`];

  // 新会话开头附上历史口味偏好，给模型做参考（不直接展示给用户）：
  // 自己以前点过什么 + 群里其他人声明过的口味偏好（这样"按大家平时的口味各点一杯"不用重新问）。
  if (history.length === 0) {
    const recent = getRecentOrders(userId, 3);
    const ownSummary = recent
      .flatMap((r) => (r.items ?? []).map((it) => it.productName || it.name || it.skuName))
      .filter(Boolean)
      .join("、");
    if (ownSummary) hints.push(`这位同事以前点过：${ownSummary}`);

    const members = await getChatMembers(chatId).catch(() => []);
    const teamHints = members
      .map((m) => {
        const t = getTaste(m.member_id);
        return t ? `${m.name}：${t.summary}` : null;
      })
      .filter(Boolean);
    if (teamHints.length > 0) hints.push(`已知群里的口味偏好——${teamHints.join("；")}`);
  }

  const userContent = `（系统提示，以下是历史记忆仅供参考、不是这轮用户说的话：${hints.join("；")}。` +
    `不要主动提起，除非用户问起或者要按大家口味点单；也不要针对这些历史记忆调用 recordTaste，` +
    `那是已经记过的旧数据。）\n\n${userText}`;
  const newHistory = [...history, { role: "user", content: userContent }];

  const { reply, updatedHistory, orderQrCodeUrl, orderedItems } = await runBaristaTurn({
    systemPrompt: ORDER_PROMPT,
    history: newHistory,
    mcpUrl: process.env.LUCKIN_MCP_URL,
    mcpToken: process.env.LUCKIN_MCP_ORDER_TOKEN,
    extraTools: [SCHEDULE_ORDER_TOOL, RECORD_TASTE_TOOL],
    localToolHandler: async (name, args) => {
      if (name === "recordTaste") return handleRecordTaste(userId, chatId, args);
      if (name === "scheduleOrder") {
        const record = addScheduledOrder({ ...args, chatId, userId });
        console.log(`[预约下单已登记] id=${record.id} executeAt=${args.executeAt}`);
        return { __stop: true, reply: `好的，已经帮你预约好了：${args.summary}。到点会自动下单并把付款二维码发过来。` };
      }
      return null;
    },
  });

  saveHistory(userId, updatedHistory);
  console.log(`[回复] userId=${userId} reply=${reply}`);
  await replyText(chatId, reply);
  if (orderQrCodeUrl) {
    await replyImageFromUrl(chatId, orderQrCodeUrl).catch((err) => console.error("发送支付二维码失败:", err));
  }
  if (orderedItems) {
    resolveUserName(chatId, userId)
      .then((userName) => appendOrder({ feishuUserId: userId, userName, chatId, items: orderedItems }))
      .catch((err) => console.error("记录点单口味失败:", err));
  }
}

async function handleDiyTurn(userId, chatId, userText) {
  pushDiyWords(userId, userText);

  const history = getHistory(userId);
  // MiniMax 的 OpenAI 兼容接口只接受一条 system 消息、且必须在最前面，
  // 中途再插一条 role:"system" 会直接 400。收敛提醒改成拼进 user 消息里。
  const forceResolve = getDiyRound(userId) >= DIY_MAX_ROUNDS;
  const newHistory = [
    ...history,
    {
      role: "user",
      content: forceResolve
        ? `${userText}\n\n（系统提示：已经问满 3 轮，这轮必须直接调用 resolveDiy 收敛，不能再提问。）`
        : userText,
    },
  ];

  let resolvedOutcome = null;

  const { reply, updatedHistory } = await runBaristaTurn({
    systemPrompt: DIY_PROMPT,
    history: newHistory,
    mcpUrl: process.env.LUCKIN_MCP_URL,
    mcpToken: process.env.LUCKIN_MCP_ORDER_TOKEN,
    extraTools: [RESOLVE_DIY_TOOL, RECORD_TASTE_TOOL],
    localToolHandler: async (name, args) => {
      if (name === "recordTaste") return handleRecordTaste(userId, chatId, args);
      if (name !== "resolveDiy") return null;
      resolvedOutcome = args;
      const items = args.items ?? [];
      const matchedItems = items.filter((it) => it.matched);
      const unmatchedItems = items.filter((it) => !it.matched);

      for (const it of unmatchedItems) {
        appendWish({
          feishuUserId: userId,
          rawUserWords: getDiyWords(userId),
          collected: it.collected ?? {},
          gapReason: it.gapReason ?? "",
        });
      }

      const parts = [];
      if (matchedItems.length > 0) {
        const names = matchedItems.map((it) => (it.label ? `${it.label}：${it.productHint}` : it.productHint));
        parts.push(`${names.join("，")}挺接近，要不要试试？确认的话我一起帮你查真实价格。`);
      }
      if (unmatchedItems.length > 0) {
        parts.push(
          matchedItems.length > 0
            ? `另外 ${unmatchedItems.length} 杯现在做不出来，我记下来了。`
            : "这杯现在做不出来，我记下来了，攒够人一起投票就有机会上新。"
        );
      }
      return { __stop: true, reply: parts.join(" ") };
    },
  });

  saveHistory(userId, updatedHistory);

  const items = resolvedOutcome?.items ?? [];
  const hasMatched = items.some((it) => it.matched);
  const hasUnmatched = items.some((it) => !it.matched);
  if (hasMatched) {
    setMode(userId, "order");
  } else if (hasUnmatched) {
    setMode(userId, null);
  } else {
    incrDiyRound(userId);
  }

  console.log(`[回复] userId=${userId} reply=${reply}`);
  await replyText(chatId, reply);
}

app.post("/admin/reset/:userId", (req, res) => {
  resetHistory(req.params.userId);
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;

mcpInitialize(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN)
  .then(() => loadMcpTools(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN))
  .then((tools) => console.log(`MCP 已初始化，工具 schema 已从服务器拉取: ${tools.map((t) => t.function.name).join(", ")}`))
  .then(() => startScheduler(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN))
  .catch((err) => console.error("MCP 初始化/拉取工具失败:", err));

app.listen(port, () => console.log(`Lucky Barista 飞书 bot 已启动: http://localhost:${port}/feishu/events`));
