import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { mcpInitialize } from "./mcpClient.js";
import { runBaristaTurn, loadMcpTools, RESOLVE_DIY_TOOL } from "./llm.js";
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
import { replyText, replyImageFromUrl, resolveUserName } from "./feishu.js";
import { appendOrder, getRecentOrders } from "./tastes.js";

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
    await replyText(chatId, "抱歉，刚才处理时出了点问题，可以再说一次吗？").catch(() => {});
  }
}

async function handleOrderTurn(userId, chatId, userText) {
  const history = getHistory(userId);

  // 新会话开头附上历史口味偏好，给模型做参考（不直接展示给用户）。
  let userContent = userText;
  if (history.length === 0) {
    const recent = getRecentOrders(userId, 3);
    const summary = recent
      .flatMap((r) => (r.items ?? []).map((it) => it.productName || it.name || it.skuName))
      .filter(Boolean)
      .join("、");
    if (summary) {
      userContent = `（系统提示：这位同事以前点过：${summary}，仅供参考，不要主动提起，除非对方问起。）\n\n${userText}`;
    }
  }
  const newHistory = [...history, { role: "user", content: userContent }];

  const { reply, updatedHistory, orderQrCodeUrl, orderedItems } = await runBaristaTurn({
    systemPrompt: ORDER_PROMPT,
    history: newHistory,
    mcpUrl: process.env.LUCKIN_MCP_URL,
    mcpToken: process.env.LUCKIN_MCP_ORDER_TOKEN,
  });

  saveHistory(userId, updatedHistory);
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
    extraTools: [RESOLVE_DIY_TOOL],
    localToolHandler: (name, args) => {
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
  .catch((err) => console.error("MCP 初始化/拉取工具失败:", err));

app.listen(port, () => console.log(`Lucky Barista 飞书 bot 已启动: http://localhost:${port}/feishu/events`));
