import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { mcpCallTool, mcpInitialize } from "./mcpClient.js";
import { runBaristaTurn, loadMcpTools, SAVE_WISH_TOOL, SCHEDULE_ORDER_TOOL, RECORD_TASTE_TOOL } from "./llm.js";
import { classifyIntent } from "./router.js";
import {
  getHistory,
  saveHistory,
  resetHistory,
  enqueueForUser,
  getMode,
  setMode,
  getPendingOrder,
  setPendingOrderStatus,
  invalidatePendingOrders,
  getActiveShop,
  setActiveShop,
  clearActiveShop,
} from "./session.js";
import { replyText, replyImageFromUrl, replyImageKey, replyCard, uploadImageFromUrl, resolveUserName, getChatMembers, updateCardEntity, createCardEntity, sendCardEntity, updateCardElement, replyTextToUser, replyCardToUser, sendCardEntityToUser, enqueueCardUpdate } from "./feishu.js";
import { appendOrder, getRecentOrders } from "./tastes.js";
import { recordTaste, getTaste } from "./tasteProfiles.js";
import { addScheduledOrder, startScheduler } from "./scheduler.js";
import { buildPaymentCard, buildOrderEntryCard } from "./cards.js";
import { createOrderUi } from './orderUi.js';
import { startAfternoonTeaScheduler, loadAfternoonTeaConfig } from "./afternoonTea.js";
import {
  startParty,
  getActiveParty,
  getParty,
  closeParty,
  confirmPartyOrder,
  submitPartyDrink,
  joinWithLastOrder,
  declineParty,
  setPartyStatus,
  chatOwnerId,
  PARTY_DEFAULTS,
} from "./party.js";
import { buildPartyCard } from "./partyCards.js";
import {
  loadStore,
  listWishes,
  getWish,
  recordWish,
  toggleVote,
  rankOf,
  wishStats,
  wishesOfUser,
  periodName,
  setWishStatus,
  removeWish,
  persistWishes,
} from "./wishes.js";
import {
  loadOfficeConfig,
  saveOfficeConfig,
  listArrivals,
  loadPrefs,
  loadCandidates,
  loadEmployeeMap,
  recordArrival,
  optOut,
  optIn,
  markDeclined,
  markSent,
  startArrivalWatcher,
  runArrivalTickNow,
  dateKey,
} from "./arrivals.js";
import { buildCandidates, searchCandidates, createReco, getReco, saveReco, listRecos, findOpenReco } from "./recommend.js";
import { buildRecoCard, buildRecoDeclinedCard } from "./recoCards.js";
import { createProductImages } from './productImages.js';
import { getDefaultShop, setDefaultShop } from './preferences.js';
import { FIND_NEARBY_SHOP_TOOL, RESOLVE_PLACE_TOOL, findNearbyShops, resolvePlace, getAmapMcpConfig } from './maps.js';
import {getShopContext,setPendingShopRequest,getPendingShopRequest} from './storeContext.js';
import { bestStoreMatch, rankStoreMatches, storeRequestFromText } from './storeResolver.js';
import {
  buildWishPoolCard,
  buildWishFormCard,
  buildWishDoneCard,
  buildWishListCard,
  buildWishStatusCard,
  wishRowElement,
  rowElementId,
} from "./wishCards.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORDER_PROMPT = readFileSync(join(__dirname, "../prompts/order.md"), "utf8");
const WISH_PROMPT = readFileSync(join(__dirname, "../prompts/wish.md"), "utf8");
const AMAP_MCP = getAmapMcpConfig();
const CHAT_PROMPT = `你是 LuckyDay，负责瑞幸饮品点单，也可以进行简单的偏好记忆和日常对话。\n`+
  `用户询问楼宇、地标或地址时，调用 resolvePlace 查询真实地址，不要凭记忆说“不知道”。\n`+
  `这一轮不是点单，不要调用菜单或订单工具，不要生成交互卡片。直接用简短中文回答。\n`+
  `如果用户明确说出自己或同事的口味偏好，调用 recordTaste 后再自然回复；不要编造偏好。`;

const app = express();
app.use(express.json());

const seenEventIds = new Set(); // 飞书会重试投递，简单去重
const recentUserLocations = new Map();

// 拼单卡的表单值字段名在飞书各版本里不统一（form_value / value.form_value），
// 而且可能是 JSON 字符串。这里一次性兜住，省得每次都去猜。
function extractFormValues(action) {
  const candidates = [action.form_value, action.value?.form_value, action.formValue, action.value?.formValue];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "object") return candidate;
    if (typeof candidate === "string") {
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
  }
  return {};
}

function resolvePartyId(value, chatId) {
  if (value.party_id && getParty(value.party_id)) return value.party_id;
  // 老卡片（没有带 party_id）退化成"这个群当前那局"
  return chatId ? (getActiveParty(chatId)?.id ?? null) : null;
}

async function handlePartyAction({ actionName, value, operatorId, chatId, form, res }) {
  const partyId = resolvePartyId(value, chatId);
  if (!partyId) return res.status(200).json({ toast: { type: "warning", content: "这局拼单已经结束了。" } });

  // 飞书要求卡片回调 3 秒内返回，否则客户端直接弹失败（实测 3.6 秒就报错）。
  // 所以除了纯内存判断，一律"先回执、再后台干活"，失败时用群消息 @ 本人兜底。
  const ack = (toast) => res.status(200).json({ toast });
  const notifyIssue = (text) => replyText(chatId, `<at user_id="${operatorId}"></at> ${text}`).catch(() => {});

  if (actionName === "party_submit") {
    ack({ type: "info", content: "收到，正在记下～" });
    void processPartySubmit({ partyId, operatorId, form, notifyIssue }).catch((err) => {
      console.error("[拼单提交处理失败]", err);
      notifyIssue("刚才这杯没记上，再点一次试试～");
    });
    return;
  }

  if (actionName === "party_same") {
    ack({ type: "info", content: "好的，和上次一样～" });
    void joinWithLastOrder(partyId, operatorId)
      .then((result) => {
        if (!result.ok) return notifyIssue("还没查到你的历史订单，先用上面的表单点一杯吧。");
      })
      .catch((err) => {
        console.error("[拼单和上次一样失败]", err);
        notifyIssue("没取到你上次那杯，用上面的表单点一下吧～");
      });
    return;
  }

  if (actionName === "party_decline") {
    ack({ type: "info", content: "好的，今天不打扰你了。" });
    void resolveUserName(chatId, operatorId)
      .catch(() => operatorId)
      .then((userName) => declineParty(partyId, operatorId, userName))
      .catch((err) => console.error("[拼单不喝标记失败]", err));
    return;
  }

  if (actionName === "party_close") {
    const party = getParty(partyId);
    // 先比发起人（纯内存，瞬间出结果）；只有不是发起人时才去问群主是谁——
    // 查群主是一次接口调用，放在同步路径上会白白吃掉 3 秒预算。
    const isInitiator = operatorId === party?.initiatorId;
    const ownerId = isInitiator ? null : await chatOwnerId(chatId).catch(() => null);
    if (!isInitiator && operatorId !== ownerId) {
      return res.status(200).json({ toast: { type: "warning", content: "只有发起人或群主可以提前截止。" } });
    }
    ack({ type: "info", content: "已截止，正在汇总报价…" });
    void closeParty(partyId).catch((err) => {
      console.error("[拼单截止失败]", err);
      notifyIssue("汇总报价时出了点问题，再点一次试试。");
    });
    return;
  }

  if (actionName === "party_reopen") {
    const party = getParty(partyId);
    if (!party) return res.status(200).json({});
    party.deadline = Date.now() + 5 * 60 * 1000;
    ack({ type: "info", content: "已重新开放 5 分钟，改好了再点提前截止。" });
    void setPartyStatus(partyId, "open")
      .then(() => {
        party.sequence += 1;
        return updateCardEntity(party.cardId, buildPartyCard(party), party.sequence);
      })
      .catch((err) => console.error("拼单重开失败:", err));
    return;
  }

  if (actionName === "party_confirm") {
    ack({ type: "info", content: "正在下单，二维码马上发到群里…" });
    void confirmPartyOrder(partyId).then((result) => {
      if (!result.ok) notifyIssue("下单失败了，我这边已经记录，稍后再试一次。");
    });
    return;
  }

  return res.status(200).json({});
}

async function processPartySubmit({ partyId, operatorId, form, notifyIssue }) {
  const result = await submitPartyDrink(partyId, { userId: operatorId, form });
  if (result.ok) return;

  const content =
    result.reason === "not_found"
      ? `没找到「${result.keyword}」，换个说法再试试？`
      : result.reason === "attr_unavailable"
        ? `「${result.keyword}」的${result.detail}暂时没有，换个搭配或者换一杯试试～`
        : result.reason === "no_drink"
          ? "先选一杯、或者输入想喝的，再提交～"
          : "这局拼单已经截止了。";
  await notifyIssue(content);
}
// ==== 许愿池 ====
// 许愿卡要能"投票后原地刷新票数"，所以记一张 messageId -> 卡片 的登记表。
// 和拼单一样放内存：重启后老卡片只是不再自动刷新，下次打开许愿池就是新的了。
const wishCardRegistry = new Map();
const WISH_CARD_LIMIT = 40;

async function sendWishCard(chatId, card, kind, userId) {
  const cardId = await createCardEntity(card);
  const data = await sendCardEntity(chatId, cardId);
  const messageId = data?.message_id;
  if (messageId) {
    wishCardRegistry.set(messageId, { cardId, chatId, kind, userId, sequence: 0 });
    if (wishCardRegistry.size > WISH_CARD_LIMIT) wishCardRegistry.delete(wishCardRegistry.keys().next().value);
  }
  console.log(`[许愿池] 发出卡片 kind=${kind} chat=${chatId} card_id=${cardId} message_id=${messageId ?? "未知"}`);
  return { cardId, messageId };
}

function rebuildWishCard(entry) {
  const stats = wishStats();
  const period = periodName();
  if (entry.kind === "list") return buildWishListCard({ wishes: listWishes(), stats, period });
  return buildWishPoolCard({ wishes: listWishes(), myWishes: wishesOfUser(entry.userId), stats, period });
}

// 投票后刷新所有还活着的许愿卡。优先只换那一行（局部更新）；万一这张卡里没有这一行
// （比如那张卡只显示了前 3 名，投的是第 8 个愿望），退化成整卡重绘——许愿卡里没有表单，
// 重绘是安全的，不像拼单卡重绘会清空别人正在填的内容。
async function refreshWishCards(wish) {
  for (const entry of wishCardRegistry.values()) {
    entry.sequence += 1;
    try {
      await updateCardElement(entry.cardId, rowElementId(wish.id), wishRowElement(wish), entry.sequence);
    } catch {
      await updateCardEntity(entry.cardId, rebuildWishCard(entry), entry.sequence).catch((err) =>
        console.error("[许愿池] 卡片刷新失败:", err.message)
      );
    }
  }
}

async function sendWishPool(chatId, userId) {
  await backfillWishNames(chatId);
  const card = buildWishPoolCard({
    wishes: listWishes(),
    myWishes: wishesOfUser(userId),
    stats: wishStats(),
    period: periodName(),
  });
  await sendWishCard(chatId, card, "pool", userId);
}

// 从旧流水账迁移进来的愿望只存了 open_id，没有名字，卡片上会显示成"—— 同事"，
// 看着像机器人没记住人。第一次在这个群发卡片时把人名补齐并落盘，之后就不再有这个开销。
async function backfillWishNames(chatId) {
  const missing = loadStore()
    .wishes.flatMap((w) => w.quotes ?? [])
    .filter((q) => !q.userName && !q.anonymous && q.userId);
  if (missing.length === 0) return;

  const names = new Map();
  for (const userId of new Set(missing.map((q) => q.userId))) {
    names.set(userId, await resolveUserName(chatId, userId).catch(() => null));
  }
  let changed = false;
  for (const quote of missing) {
    const name = names.get(quote.userId);
    // 查不到名字时 resolveUserName 会原样返回 open_id，那种就别写进去。
    if (name && !name.startsWith("ou_")) {
      quote.userName = name;
      changed = true;
    }
  }
  if (changed) {
    persistWishes();
    console.log(`[许愿池] 已补齐 ${missing.length} 条历史愿望的署名`);
  }
}

async function handleWishAction({ actionName, value, operatorId, chatId, messageId, form, res }) {
  // 卡片回调必须 3 秒内返回，所以一律"先回执、再后台干活"，失败时用群消息 @ 本人兜底。
  const ack = (toast) => res.status(200).json({ toast });
  const notifyIssue = (text) => replyText(chatId, `<at user_id="${operatorId}"></at> ${text}`).catch(() => {});
  const entry = messageId ? wishCardRegistry.get(messageId) : null;

  if (actionName === "wish_open_form") {
    ack({ type: "info", content: "打开填写卡片…" });
    void sendWishCard(chatId, buildWishFormCard(), "form", operatorId).catch((err) => {
      console.error("[许愿池] 打开填写卡失败:", err);
      notifyIssue("填写卡片没打开成功，再点一次试试～");
    });
    return;
  }

  if (actionName === "wish_list") {
    ack({ type: "info", content: "好的，给你看全部～" });
    void sendWishCard(chatId, buildWishListCard({ wishes: listWishes(), stats: wishStats(), period: periodName() }), "list", operatorId).catch(
      (err) => console.error("[许愿池] 发全部列表失败:", err)
    );
    return;
  }

  if (actionName === "wish_vote") {
    const wish = getWish(value.wish_id);
    if (!wish) return res.status(200).json({ toast: { type: "warning", content: "这个愿望已经不在池子里了。" } });
    const result = toggleVote(value.wish_id, operatorId);
    if (result.unchanged) {
      return res.status(200).json({ toast: { type: "info", content: "这是你自己许的愿望，已经算你一份啦～" } });
    }
    ack({ type: "info", content: result.voted ? `已 +1，现在 ${result.wish.votes.length} 人想要` : "已取消你的 +1" });
    void refreshWishCards(result.wish).catch((err) => console.error("[许愿池] 刷新票数失败:", err));
    return;
  }

  if (actionName === "wish_submit") {
    const raw = String(form.text ?? form.wish_text ?? "").trim();
    if (!raw) return res.status(200).json({ toast: { type: "warning", content: "先写一句你想喝什么～" } });
    ack({ type: "info", content: "收到，正在放进许愿池…" });
    void processWishSubmit({ operatorId, chatId, form, entry, notifyIssue }).catch((err) => {
      console.error("[许愿池] 提交失败:", err);
      notifyIssue("这个愿望没记上，再提交一次试试～");
    });
    return;
  }

  return res.status(200).json({});
}

async function processWishSubmit({ operatorId, chatId, form, entry, notifyIssue }) {
  const raw = String(form.text ?? "").trim();
  const userName = await resolveUserName(chatId, operatorId).catch(() => null);
  const result = await recordWish({
    userId: operatorId,
    userName,
    text: raw,
    fields: {
      flavor: Array.isArray(form.flavor) ? form.flavor.join("、") : form.flavor,
      sweetness: form.sweetness,
      temperature: form.temperature,
    },
    anonymous: form.sign === "匿名",
    chatId,
  });
  if (!result) {
    notifyIssue("这条愿望是空的，没记上～");
    return;
  }

  const done = buildWishDoneCard({
    wish: result.wish,
    rank: rankOf(result.wish.id),
    total: wishStats().total,
    merged: result.merged,
  });

  // 提交完的填写卡原地换成结果卡：表单已经用完了，换掉不会打断任何人。
  if (entry && entry.kind === "form") {
    entry.sequence += 1;
    await updateCardEntity(entry.cardId, done, entry.sequence).catch((err) => console.error("[许愿池] 结果卡回填失败:", err));
  } else {
    await sendWishCard(chatId, done, "done", operatorId).catch((err) => console.error("[许愿池] 结果卡发送失败:", err));
  }
  await refreshWishCards(result.wish).catch(() => {});
  console.log(
    `[许愿池] 入池 id=${result.wish.id} merged=${result.merged} votes=${result.wish.votes.length} rank=${rankOf(result.wish.id)} text=${raw.slice(0, 40)}`
  );
}

const prepareProductImages = createProductImages({
  upload: url => uploadImageFromUrl(url,{timeoutMs:5_000,filename:'product-image'}),
  onError: error => console.error('[商品图片暂不可用]',error.message),
});

const orderUi = createOrderUi({
  prepareImages: prepareProductImages,
  schedule: entry => addScheduledOrder(entry),
  call: (name,args) => mcpCallTool(process.env.LUCKIN_MCP_URL,process.env.LUCKIN_MCP_ORDER_TOKEN,name,args),
  publish: async (state,card) => {
    // Let the callback acknowledgement finish before pushing a replacement to the client.
    const delay=(state.publishAfter??0)-Date.now();
    if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
    const confirmationStep=state.screen==='confirm'&&state.publishedScreen!=='confirm';
    if(state.cardId&&!confirmationStep) {
      try {state.sequence=(state.sequence??0)+1;await updateCardEntity(state.cardId,card,state.sequence);state.publishedScreen=state.screen;return;}
      catch(e) {console.error('[点单卡更新重发]',e.message);}
    }
    const previousCardId=state.cardId;
    const previousSequence=state.sequence??0;
    const cardId=await createCardEntity(card);
    await sendCardEntity(state.chatId,cardId);
    state.cardId=cardId;state.sequence=0;
    state.publishedScreen=state.screen;
    if(confirmationStep&&previousCardId) {
      const completed={schema:'2.0',config:{update_multi:true},header:{title:{tag:'plain_text',content:'LuckyDay · 已进入订单确认'}},body:{elements:[{tag:'markdown',content:'已确认饮品规格，请在下方新的订单确认卡中继续。'}]}};
      await updateCardEntity(previousCardId,completed,previousSequence+1).catch(e=>console.error('[旧点单卡收起失败]',e.message));
    }
  },
  pay: async (state,result) => {
    const url=result?.data?.payOrderQrCodeUrl;
    if(!url)throw new Error('支付二维码尚未返回');
    const imageKey=await uploadImageFromUrl(url);
    await replyCard(state.chatId,buildPaymentCard({order:{result},imageKey}));
    await replyImageKey(state.chatId,imageKey);
  },
  getShopContext,
  onShopSelected: (ownerId, chatId, shop) => {
    invalidateStoreCards(ownerId,chatId);
    return setActiveShop(ownerId,chatId,shop);
  },
  onShopReady: continueAfterStore,
  resolveShops: (state,query) => resolveStoreRequest(state.ownerId,state.chatId,storeRequestFromText(query) ?? {kind:'named',query}),
});

app.post("/feishu/events", async (req, res) => {
  const body = req.body;

  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  if (body.header?.event_type === "card.action.trigger") {
    const action = body.event?.action ?? {};
    const value = action.value ?? {};
    const actionName = value.action ?? "";
    const operatorId = body.event?.operator?.open_id ?? body.event?.operator?.user_id?.open_id;
    const chatId = body.event?.context?.open_chat_id ?? body.event?.context?.chat_id;

    // 拼单卡的表单值可能挂在 form_value / value.form_value 上，飞书各版本不一致，兜着取。
    const form = extractFormValues(action);
    if(['order_entry','order_resume'].includes(actionName)) {
      if(value.owner_id!==operatorId||!chatId)return res.json({toast:{type:'warning',content:'请使用自己的卡片。'}});
      if(actionName==='order_resume')optIn(operatorId);
      res.json({toast:{type:'info',content:'正在打开点单卡…'}});
      void enqueueForUser(operatorId,()=>orderUi.start({ownerId:operatorId,chatId,defaultShop:getDefaultShop(operatorId)})).catch(e=>console.error('[点单入口失败]',e.message));return;
    }
    if(actionName==='orderui') {
      const ticket=orderUi.claim(value,operatorId,chatId);
      if(ticket.error){
        res.json({toast:{type:'warning',content:ticket.error}});
        if(ticket.stale)void enqueueForUser(operatorId,()=>orderUi.recover(ticket.s,'卡片已同步，请继续操作。')).catch(e=>console.error('[卡片同步失败]',e.message));
        if(ticket.expired&&operatorId&&chatId)void enqueueForUser(operatorId,()=>orderUi.start({ownerId:operatorId,chatId,defaultShop:getDefaultShop(operatorId)})).catch(e=>console.error('[重新开卡失败]',e.message));
        return;
      }
      res.json({toast:{type:'info',content:'正在更新点单卡片…'}});
      ticket.s.publishAfter=Date.now()+700;
      void enqueueForUser(operatorId,()=>orderUi.perform(ticket,form)).catch(async err=>{
        ticket.s.busy=false;
        console.error('[点单卡交互失败]',err.message);
        await orderUi.recover(ticket.s).catch(e=>console.error('[点单卡恢复失败]',e.message));
      });
      return;
    }
    const isWish = actionName.startsWith("wish_");
    // 带表单值的回调一律按"提交"处理（飞书不会告诉我们这是哪张卡的表单），
    // 但必须先按 action 前缀分流：许愿表单和拼单表单都带 form_value。
    const isReco = actionName.startsWith("reco_");
    const isPartyForm = !isWish && !isReco && Object.keys(form).length > 0;
    if (isWish) {
      console.log(
        `[许愿池回调] action=${actionName} operator=${operatorId} chat=${chatId} form=${JSON.stringify(form)}`
      );
      return handleWishAction({
        actionName,
        value,
        operatorId,
        chatId,
        messageId: body.event?.context?.open_message_id,
        form,
        res,
      });
    }
    if (isReco) {
      console.log(`[到岗推荐回调] action=${actionName} operator=${operatorId} reco=${value.reco_id}`);
      return handleRecoAction({ actionName, value, operatorId, chatId, form, res });
    }
    if (actionName.startsWith("party_") || isPartyForm) {
      const effectiveAction = actionName || "party_submit";
      console.log(`[拼单回调] action=${effectiveAction} operator=${operatorId} chat=${chatId} form=${JSON.stringify(form)}`);
      return handlePartyAction({ actionName: effectiveAction, value, operatorId, chatId, form, res });
    }

    if (!actionName || !value.pending_id) return res.status(200).json({});

    const pending = getPendingOrder(value.pending_id);
    if (!pending || pending.ownerId !== operatorId) {
      res.status(200).json({ toast: { type: "warning", content: "这张订单卡已失效，或只能由发起人确认。" } });
      if(!pending&&operatorId&&chatId)void enqueueForUser(operatorId,()=>orderUi.start({ownerId:operatorId,chatId})).catch(e=>console.error('[旧卡恢复失败]',e.message));
      return;
    }
    if (actionName === "edit_order") {
      if (pending.status !== "pending") return res.status(200).json({ toast: { type: "warning", content: "这张订单卡已失效，请使用最新报价。" } });
      setPendingOrderStatus(pending.id, "superseded");
      res.status(200).json({ toast: { type: "info", content: "正在打开点单调整卡…" } });
      void enqueueForUser(operatorId,()=>orderUi.start({ownerId:operatorId,chatId:pending.chatId,history:getHistory(operatorId),previewOrder:{args:pending.orderArgs,result:pending.preview}})).catch(err=>console.error('[旧订单转交互卡]',err.message));
      return;
    }
    if (actionName === "confirm_order") {
      if (pending.status !== "pending") {
        return res.status(200).json({ toast: { type: "warning", content: pending.status === "processing" ? "订单正在生成，请稍候。" : "该订单已经处理过了。" } });
      }
      setPendingOrderStatus(pending.id, "processing");
      res.status(200).json({ toast: { type: "info", content: "正在生成支付二维码…" } });
      void confirmPendingOrder(pending.id).catch((err) => console.error("卡片确认下单失败:", err));
      return;
    }
    return res.status(200).json({});
  }

  res.status(200).send();

  const eventId = req.headers["x-tt-logid"] ?? body.header?.event_id;
  if (eventId) {
    if (seenEventIds.has(eventId)) return;
    seenEventIds.add(eventId);
  }

  if (body.header?.event_type !== "im.message.receive_v1") return;

  const event = body.event;
  const chatId = event.message.chat_id;
  const userId = event.sender.sender_id.open_id;
  const chatType = event.message.chat_type;

  // 用户主动发位置：零权限的兜底到岗信号。字段结构先打真实日志，确认后再靠配置打开。
  if (event.message.message_type === "location") {
    await enqueueForUser(userId, () => handleLocationMessage({ userId, chatId, raw: event.message.content }));
    return;
  }
  if (event.message.message_type !== "text") return;

  const userText = JSON.parse(event.message.content)
    .text.replace(/@_user_\d+\s*/g, "")
    .trim();
  if (!userText) return;

  await enqueueForUser(userId, () => handleMessage(userId, chatId, userText, chatType)).catch(async err=>{
    console.error('[消息任务失败]',err.message);
    await orderUi.start({ownerId:userId,chatId,notice:'刚才处理超时，可以直接在卡片上继续选择。'}).catch(e=>console.error('[消息恢复卡失败]',e.message));
  });
});

// 位置消息兜底：飞书只给经纬度、不给地点名，所以只能按"离公司多远"判。
// 这个开关默认关着，因为要先拿到一条真实的位置消息确认字段结构再开。
async function handleLocationMessage({ userId, chatId, raw }) {
  console.log(`[到岗] 收到位置消息 userId=${userId} raw=${raw}`);
  const config = loadOfficeConfig();

  let content = {};
  try {
    content = JSON.parse(raw);
  } catch {
    return;
  }
  const lat = Number(content.latitude);
  const lng = Number(content.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  // 飞书的位置消息本身只有坐标。先保留最近一次定位，后续用户说“离我最近的店”
  // 时可以直接交给地图 MCP；到岗开关关闭时也不影响这条位置能力。
  recentUserLocations.set(userId, { latitude: lat, longitude: lng, address: content.name ?? "最近一次飞书定位", at: Date.now() });

  if (!config.acceptLocationMessage) return;
  if (!config.officeLatitude || !config.officeLongitude) return;

  const distance = haversineMeters(lat, lng, config.officeLatitude, config.officeLongitude);
  const radius = Number(config.officeRadiusMeters ?? 300);
  if (distance > radius) {
    console.log(`[到岗] 位置不在公司范围（${Math.round(distance)}m > ${radius}m），忽略`);
    return;
  }
  const arrival = recordArrival({ userId, at: Date.now(), via: "location", place: content.name ?? "", source: "location", chatId });
  if (!arrival) return;
  await onArrived(arrival);
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function confirmPendingOrder(pendingId) {
  const pending = getPendingOrder(pendingId);
  if (!pending || pending.status !== "processing") return;

  try {
    const result = await mcpCallTool(
      process.env.LUCKIN_MCP_URL,
      process.env.LUCKIN_MCP_ORDER_TOKEN,
      "createOrder",
      pending.orderArgs
    );
    const qrCodeUrl = result?.data?.payOrderQrCodeUrl;
    if (!qrCodeUrl) throw new Error(`创建订单未返回支付二维码: ${JSON.stringify(result).slice(0, 500)}`);

    const imageKey = await uploadImageFromUrl(qrCodeUrl);
    const completed = setPendingOrderStatus(pendingId, "ordered", result);
    try {
      await replyCard(pending.chatId, buildPaymentCard({ order: completed, imageKey }));
      await replyImageKey(pending.chatId, imageKey);
    } catch (deliveryError) {
      await replyText(pending.chatId, `订单已创建（${result.data.orderIdStr ?? '已生成'}），但支付二维码发送失败。请点击重发支付卡。`).catch(() => {});
      throw deliveryError;
    }
    resolveUserName(pending.chatId, pending.ownerId)
      .then((userName) => appendOrder({ feishuUserId: pending.ownerId, userName, chatId: pending.chatId, items: pending.productList }))
      .catch((err) => console.error("记录点单口味失败:", err));
  } catch (err) {
    setPendingOrderStatus(pendingId, "failed");
    await replyText(pending.chatId, "抱歉，订单没有创建成功。请直接回复“重新下单”，我会重新为你准备。")
      .catch((replyErr) => console.error("发送下单失败提示失败:", replyErr));
    throw err;
  }
}

// recordTaste 在下单和许愿两条路径里都可能被调用，共用一份"person 名字 -> open_id"解析逻辑。
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

async function handleFindNearbyShop(userId, args) {
  if (!AMAP_MCP) {
    return {
      error: "地图 MCP 尚未配置。需要在服务端设置 AMAP_MAPS_API_KEY 后才能按地点查找最近门店。",
      code: "AMAP_NOT_CONFIGURED",
    };
  }
  const recent = recentUserLocations.get(userId);
  const userLocation = recent && Date.now() - recent.at < 24 * 60 * 60 * 1000 ? recent : undefined;
  try {
    return await findNearbyShops({
      place: args.place,
      city: args.city,
      radius: args.radius,
      userLocation,
      mapCall: (name, input) => mcpCallTool(AMAP_MCP.url, AMAP_MCP.token, name, input),
      shopCall: (name, input) => mcpCallTool(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, name, input),
    });
  } catch (err) {
    console.error(`[附近门店查询失败] userId=${userId}`, err.stack || err);
    return { error: `地图或门店查询暂时失败：${err.message}` };
  }
}


function renderShopChoices(shops) {
  return shops.slice(0, 3).map((shop, index) => {
    const distance = shop.distanceMeters != null ? `${shop.distanceMeters}米` : (shop.distanceKm != null ? `${shop.distanceKm}公里` : '');
    const status = shop.workStatus ? `，${shop.workStatus}` : '';
    return `${index + 1}. ${shop.deptName || '瑞幸门店'}（${shop.address || shop.deptAddress || '地址待确认'}${distance ? `，${distance}` : ''}${status}）`;
  }).join('\n');
}

function invalidateStoreCards(userId,chatId) {
  invalidatePendingOrders(userId,chatId);
  for(const reco of listRecos().filter(r=>r.userId===userId && (!r.chatId||r.chatId===chatId) && ['sent','ordering','customizing'].includes(r.status))) {
    reco.status='superseded';saveReco(reco);
  }
}

async function resolveStoreRequest(userId,chatId,request) {
  if(request.kind==='nearby') return handleFindNearbyShop(userId,{place:request.query,city:request.city,radius:5000});
  const active=getActiveShop(userId,chatId) ?? getDefaultShop(userId) ?? PARTY_DEFAULTS;
  if(request.kind==='list') {
    const raw=await mcpCallTool(process.env.LUCKIN_MCP_URL,process.env.LUCKIN_MCP_ORDER_TOKEN,'queryShopList',{longitude:active.longitude,latitude:active.latitude});
    if(raw?.error || (raw?.code!=null && Number(raw.code)!==0))return {error:'门店查询失败，请重试。'};
    return {shops:Array.isArray(raw?.data)?raw.data:[]};
  }
  // Resolve the user's place first, not the previous store's coordinates.
  const query=request.query.replace(/贵大/g,'贵州大学').replace(/北工大/g,'北京工业大学');
  const nearby=await handleFindNearbyShop(userId,{place:query,city:request.city,radius:8000});
  if(nearby.error)return nearby;
  const ranked=rankStoreMatches(query,nearby.shops,{limit:8}).filter(row=>row.score>0);
  return {...nearby,shops:ranked.map(row=>row.shop)};
}

async function continueAfterStore(userId,chatId,continuation) {
  if(!continuation || getPendingShopRequest(userId,chatId))return;
  const classification=await classifyIntent({userText:continuation,currentMode:getMode(userId)});
  if(classification.intent==='exclusive_recommendation') await handleRecommendationTurn(userId,chatId,continuation);
  else if(['direct_order','scheduled_order'].includes(classification.intent))await handleOrderTurn(userId,chatId,continuation,{forceSchedule:classification.intent==='scheduled_order',scheduledAtHint:classification.scheduledAt});
}

async function handleStoreLocationTurn(userId,chatId,userText,request) {
  if(request.kind==='selection') {
    const pending=getPendingShopRequest(userId,chatId);
    if(request.continuation && pending) {
      pending.continuation=request.continuation;setPendingShopRequest(userId,chatId,pending);
      const current=orderUi.current(userId,chatId);if(current)current.shopContinuation=request.continuation;
    }
    const selected=await orderUi.selectShop(userId,chatId,request.query);
    if(!selected.shop)await replyText(chatId,selected.error+' 请点击卡片上对应的门店。');
    return;
  }
  invalidateStoreCards(userId,chatId);
  const pending={...request,candidates:[],notice:'正在查找你提到的位置，请先选店，再继续看饮品。'};
  setPendingShopRequest(userId,chatId,pending);
  // Clear old quotes/buttons BEFORE external lookups, including failure paths.
  await orderUi.start({ownerId:userId,chatId});
  try {
    const result=await resolveStoreRequest(userId,chatId,request);
    if(result.error)throw new Error(result.error);
    const shops=result.shops??[];
    if(!shops.length)throw new Error(`没有查到“${request.query}”对应的门店，请补充校区、园区名称或完整地址。`);
    const exact=request.kind==='named'?bestStoreMatch(request.query,shops):null;
    if(exact) {
      await orderUi.setShop(userId,chatId,exact);
      await continueAfterStore(userId,chatId,request.continuation);
      return;
    }
    // Nearby results already have a distance order. A shared name must not move
    // a farther branch ahead of a genuinely closer shop.
    pending.candidates=shops.slice(0,3);pending.origin=result.origin;
    pending.notice=`${result.origin?.name||request.query||'当前位置'}${result.origin?.address?' · '+result.origin.address:''}\n请选择取餐门店${request.continuation?'，选好后继续处理：'+request.continuation:'。'}`;
    setPendingShopRequest(userId,chatId,pending);
    await orderUi.start({ownerId:userId,chatId});
    console.log('[门店定位]',JSON.stringify({query:request.query,origin:result.origin,candidates:pending.candidates.map(x=>({deptId:x.deptId,deptName:x.deptName,distanceKm:x.distanceKm}))}));
  } catch(error) {
    pending.notice=`${error.message} 取餐门店尚未确定，请补充地点或在卡片内搜索。`;
    setPendingShopRequest(userId,chatId,pending);
    await orderUi.start({ownerId:userId,chatId});
  }
}

async function handleResolvePlace(args) {
  if (!AMAP_MCP) return { error: "地图 MCP 尚未配置。", code: "AMAP_NOT_CONFIGURED" };
  try {
    return await resolvePlace({
      query: args.query,
      city: args.city,
      mapCall: (name, input) => mcpCallTool(AMAP_MCP.url, AMAP_MCP.token, name, input),
    });
  } catch (err) {
    console.error("[地点解析失败]", err.stack || err);
    return { error: `地点查询暂时失败：${err.message}` };
  }
}

async function handleSettingsTurn(userId, chatId, userText) {
  const match = userText.match(/(?:默认(?:取餐)?门店|默认地址).{0,8}(?:改成|换成|设为|设置为)\s*[“"「]?(.+?)[”"」]?(?:店|门店)?$/i) ||
    userText.match(/(?:改成|换成|设为)\s*[“"「]?(.+?店)[”"」]?作为默认/iu);
  if (match) {
    const query = match[1].trim().replace(/[。.!！]+$/,'');
    const result=await resolveStoreRequest(userId,chatId,{kind:'named',query});
    const shop=bestStoreMatch(query,result.shops??[]);
    if(!shop){await replyText(chatId,result.error||`“${query}”没有唯一匹配的门店，默认门店未修改，请补充完整名称。`);return;}
    const saved = setDefaultShop(userId, shop);
    setActiveShop(userId, chatId, saved);
    invalidateStoreCards(userId,chatId);
    // The open order card contains a server-side snapshot of the shop. Rebind
    // that live card in place so the user immediately sees the new store; just
    // deleting the state would leave the old Feishu card visibly stale.
    await orderUi.updateDefault(userId, saved);
    await replyText(chatId, `已把默认取餐门店改为${saved.deptName}。下次点单会直接使用它。`); return;
  }
  await handleConversationTurn(userId, chatId, userText);
}

async function handleConversationTurn(userId, chatId, userText) {
  const history = getHistory(userId);
  const { reply, updatedHistory } = await runBaristaTurn({
    systemPrompt: CHAT_PROMPT,
    history: [...history, { role:'user', content:userText }],
    mcpUrl: process.env.LUCKIN_MCP_URL,
    mcpToken: process.env.LUCKIN_MCP_ORDER_TOKEN,
    extraTools: AMAP_MCP ? [RESOLVE_PLACE_TOOL, RECORD_TASTE_TOOL] : [RECORD_TASTE_TOOL],
    disableMcp: true,
    localToolHandler: async (name,args) => {
      if (name === 'resolvePlace') return handleResolvePlace(args);
      return name === 'recordTaste' ? handleRecordTaste(userId,chatId,args) : null;
    },
  });
  saveHistory(userId, updatedHistory);
  await replyText(chatId, reply);
}

// A recommendation request is a card workflow, not a free-form chat answer.
// The old path let the model invent a prose list and then opened an unrelated
// menu card, so “换一杯” had no recommendation state to update. Build the same
// verified candidate set used by arrival recommendations and put it in a live
// card entity with the current default shop attached.
async function handleRecommendationTurn(userId, chatId, userText) {
  if(getPendingShopRequest(userId,chatId)){await orderUi.start({ownerId:userId,chatId});return;}
  const savedShop = getActiveShop(userId, chatId) ?? getDefaultShop(userId);
  const shop = savedShop ?? {
    deptId: PARTY_DEFAULTS.deptId,
    deptName: PARTY_DEFAULTS.shopName,
    longitude: PARTY_DEFAULTS.longitude,
    latitude: PARTY_DEFAULTS.latitude,
  };

  const candidates = await buildCandidates(userId, { shop, max: 3 });
  if (!candidates.length) {
    await replyText(chatId, "我暂时没查到可直接下单的推荐，先打开点单卡，你可以在里面写想喝的饮品。\n");
    await orderUi.start({ ownerId:userId, chatId, defaultShop:shop, userText, notice:'暂时没有可用推荐，可以在卡片里搜索饮品。' });
    return;
  }

  // A fresh explicit request supersedes an older open recommendation card. Its
  // buttons must not be allowed to mutate the newly requested recommendation.
  for (const previous of listRecos().filter(r => r.userId===userId && r.chatId===chatId && ['sent','ordering'].includes(r.status))) {
    previous.status='superseded';
    saveReco(previous);
  }

  const reco = createReco({
    userId,
    chatId,
    day: dateKey(),
    arrivalAt: Date.now(),
    place: '',
    trigger: 'manual',
    shop,
    candidates,
  });

  try {
    await prepareProductImages(reco.candidates);
    const cardId = await createCardEntity(buildRecoCard(reco));
    reco.cardId = cardId;
    saveReco(reco);
    await replyText(chatId, '给你挑了几杯，直接在卡片里选这一杯、换一杯，或者写需求搜索。');
    await sendCardEntity(chatId, cardId);
  } catch (err) {
    reco.status='failed';
    reco.error=String(err.message ?? err);
    saveReco(reco);
    throw err;
  }
}

async function handleMessage(userId, chatId, userText, chatType) {
  try {
    if (/^(?:不点了|不喝了|取消点单|退出点单|先不点|算了|取消)[。！!，,]?$/i.test(userText.trim())) {
      setPendingShopRequest(userId,chatId,null);
      const cancelled = await orderUi.cancel(userId, chatId);
      if (cancelled) return;
      await replyText(chatId, '好的，已退出点单。需要时再叫我。');
      return;
    }
    // 门店切换先走确定性的真实门店检索，避免意图模型把“我现在在贵州大学”
    // 当成闲聊或把下一轮点单又切回默认店。默认门店设置仍保留原来的 settings 流程。
    if (!/(?:默认(?:取餐)?门店|默认地址)/u.test(userText)) {
      const pending=getPendingShopRequest(userId,chatId);
      if(pending&&!orderUi.current(userId,chatId))await orderUi.start({ownerId:userId,chatId});
      const storeRequest = storeRequestFromText(userText, orderUi.current(userId, chatId));
      if (storeRequest) {
        await handleStoreLocationTurn(userId, chatId, userText, storeRequest);
        return;
      }
    }
    // 到岗推荐的开关和手动到岗口子只在私聊里生效，群里不管这些
    if (chatType === "p2p" && userText.length <= 12) {
      if (RECO_DECLINE_WORDS.test(userText)) {
        optOut(userId);
        await replyCard(chatId,buildOrderEntryCard({ownerId:userId,message:'已关闭主动推荐。仍然可以随时点单，也可以点击恢复推荐。',resume:true}));
        return;
      }
      if (RECO_ACCEPT_WORDS.test(userText)) {
        optIn(userId);
        await replyCard(chatId,buildOrderEntryCard({ownerId:userId,message:'已恢复主动推荐。现在想喝也可以直接点选。'}));
        return;
      }
    }

    const currentMode = getMode(userId);
    let mode;
    try {
      const classification = await classifyIntent({ userText, currentMode });
      if(classification.storeRequest) {
        await handleStoreLocationTurn(userId,chatId,userText,classification.storeRequest);return;
      }
      const pending=getPendingShopRequest(userId,chatId);
      if(pending && ['exclusive_recommendation','direct_order','scheduled_order'].includes(classification.intent)) {
        pending.continuation=userText;setPendingShopRequest(userId,chatId,pending);
        await orderUi.start({ownerId:userId,chatId});return;
      }
      mode = classification.intent;
      var scheduledAtHint = classification.scheduledAt;
    } catch (err) {
      // 意图模型不可用时禁止猜一个卡片类型；猜错会把团队活动发成饮品推荐。
      console.error('[意图识别失败]', err.message);
      await replyText(chatId, '我暂时没判断清楚你想发起哪种操作。请明确说“发起拼单”“打开愿望单”“预约下单”或“我到公司了”。');
      return;
    }
    setMode(userId, mode);

    if (mode === "team_party") {
      if (!chatId.startsWith("oc_")) {
        await replyText(chatId, "团队拼单需要在群聊里发起，请把我拉进团队群后再说“发起拼单”。");
        return;
      }
      const config = loadAfternoonTeaConfig();
      const { reused } = await startParty({
        chatId,
        initiatorId: userId,
        durationMinutes: config.durationMinutes,
        payerOpenId: config.payerOpenId,
      });
      if (reused) await replyText(chatId, "这局下午茶还在进行中，直接在上面那张卡上填就行～");
    } else if (mode === "exclusive_recommendation") {
      await handleRecommendationTurn(userId, chatId, userText);
    } else if (mode === "scheduled_order") {
      await handleOrderTurn(userId, chatId, userText, { forceSchedule: true, scheduledAtHint });
    } else if (mode === "direct_order") {
      await handleOrderTurn(userId, chatId, userText);
    } else if (mode === 'settings') {
      await handleSettingsTurn(userId, chatId, userText);
    } else if (mode === 'wish_pool') {
      await sendWishPool(chatId, userId);
    } else if (mode === 'chat') {
      await handleConversationTurn(userId, chatId, userText);
    } else {
      await handleWishTurn(userId, chatId, userText);
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
    if(/超时|abort/i.test(err.message??''))throw err;
    if(getMode(userId)==='scheduled_order'){await replyText(chatId,'预约卡片暂时发送失败，本次没有创建预约。请稍后重试。');return;}
    await orderUi.start({ownerId:userId,chatId,defaultShop:getDefaultShop(userId),notice:'刚才没能完成处理，请在卡片中继续选店、选饮品。'});
  }
}

async function handleOrderTurn(userId, chatId, userText, { forceSchedule = false, scheduledAtHint = null } = {}) {
  if(getPendingShopRequest(userId,chatId)){await orderUi.start({ownerId:userId,chatId});return;}
  invalidatePendingOrders(userId, chatId);
  const history = getHistory(userId);
  const pendingWishes = [];

  // 每轮都带上当前时间，供模型换算"明天早上8点"这类相对时间（预约下单要用）。
  const nowStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  let hints = [`当前时间：${nowStr}（北京时间）`];
  const defaultShop = getDefaultShop(userId);
  const currentUi=orderUi.current(userId,chatId);
  const activeShop = currentUi?.shopSource === 'explicit' ? currentUi.shop : (getActiveShop(userId, chatId) ?? defaultShop);
  if(defaultShop && (!activeShop || String(defaultShop.deptId)!==String(activeShop.deptId)))hints.push(`用户默认取餐门店：${defaultShop.deptName}，deptId=${defaultShop.deptId}，地址=${defaultShop.deptAddress||defaultShop.address||'未提供'}；只有用户明确换店时才使用它。`);
  if(activeShop)hints.push(`用户本轮已确认取餐门店：${activeShop.deptName}，deptId=${activeShop.deptId}，地址=${activeShop.deptAddress||activeShop.address||'未提供'}；后续所有菜单、报价和订单工具必须使用这个 deptId，除非用户再次明确要求换店。`);

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

  const { reply, updatedHistory, orderQrCodeUrl, orderedItems, previewOrder } = await runBaristaTurn({
    cardMode: true,
    lockedDeptId: activeShop?.deptId,
    systemPrompt: activeShop
      ? `${ORDER_PROMPT}\n\n【运行时已确认门店】本轮必须使用 ${activeShop.deptName}，deptId=${activeShop.deptId}，地址=${activeShop.deptAddress||activeShop.address||'未提供'}。用户已经提过或确认这家店，除非用户再次明确指定另一家门店，否则禁止切回默认店，也不要在卡片中替换门店。`
      : ORDER_PROMPT,
    history: newHistory,
    mcpUrl: process.env.LUCKIN_MCP_URL,
    mcpToken: process.env.LUCKIN_MCP_ORDER_TOKEN,
    mcpServers: AMAP_MCP ? [AMAP_MCP] : [],
    // 预约意图必须先进入卡片，不能让模型直接调用 scheduleOrder 绕过时间确认。
    extraTools: [FIND_NEARBY_SHOP_TOOL, ...(forceSchedule ? [] : [SCHEDULE_ORDER_TOOL]), RECORD_TASTE_TOOL, SAVE_WISH_TOOL],
    localToolHandler: async (name, args) => {
      if (name === "findNearbyShop") return handleFindNearbyShop(userId, args);
      if (name === "recordTaste") return handleRecordTaste(userId, chatId, args);
      if (name === "saveWish") return saveWishFromTurn({ userId, chatId, userText, args, pendingWishes });
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
  await orderUi.start({ownerId:userId,chatId,history:updatedHistory,previewOrder,userText,forceSchedule,scheduledAtHint,defaultShop:activeShop ?? getDefaultShop(userId)});
  if (orderQrCodeUrl) {
    await replyImageFromUrl(chatId, orderQrCodeUrl).catch((err) => console.error("发送支付二维码失败:", err));
  }
  if (orderedItems) {
    resolveUserName(chatId, userId)
      .then((userName) => appendOrder({ feishuUserId: userId, userName, chatId, items: orderedItems }))
      .catch((err) => console.error("记录点单口味失败:", err));
  }
  await flushWishCards(chatId, userId, pendingWishes);
}

// 许愿池：一轮说完，不做多轮访谈。
//
// 老版本的 DIY 访谈（最多追问 3 轮再收敛）已经下线。用户要的是"我说一句，它就记下来"，
// 连着追问三轮更像在填问卷，而且大部分人的灵感本来就在第一句话里说清楚了。
// 现在只做一次判定：菜单里有接近的就说出来，没有就直接进许愿池。
async function handleWishTurn(userId, chatId, userText) {
  const history = getHistory(userId);
  const pendingWishes = [];
  let savedWish = false;

  const { reply, updatedHistory, previewOrder } = await runBaristaTurn({
    cardMode: true,
    systemPrompt: WISH_PROMPT,
    history: [...history, { role: "user", content: userText }],
    mcpUrl: process.env.LUCKIN_MCP_URL,
    mcpToken: process.env.LUCKIN_MCP_ORDER_TOKEN,
    extraTools: [SAVE_WISH_TOOL, RECORD_TASTE_TOOL],
    localToolHandler: async (name, args) => {
      if (name === "recordTaste") return handleRecordTaste(userId, chatId, args);
      if (name !== "saveWish") return null;
      savedWish = true;
      return saveWishFromTurn({ userId, chatId, userText, args, pendingWishes, stop: true });
    },
  });

  saveHistory(userId, updatedHistory);
  // 菜单里有接近的 → 用户下一句大概率是"那就点它"，提前切到下单模式；
  // 已经存进许愿池的，这轮就结束了，回到普通模式。
  setMode(userId, savedWish ? null : "order");

  console.log(`[回复] userId=${userId} reply=${reply}`);
  if(savedWish)await replyText(chatId,reply);
  else await orderUi.start({ownerId:userId,chatId,history:updatedHistory,previewOrder,userText,defaultShop:getDefaultShop(userId)});
  await flushWishCards(chatId, userId, pendingWishes);
}

/**
 * 把用户这一句话记进许愿池。
 * 原话直接取消息里的文本，不经模型改写——「保留用户原话」是许愿池的底线，
 * 模型只负责补 fields 和 gapReason。
 */
async function saveWishFromTurn({ userId, chatId, userText, args, pendingWishes, stop = false }) {
  const userName = await resolveUserName(chatId, userId).catch(() => null);
  pendingWishes.push(
    recordWish({
      userId,
      userName,
      text: userText,
      fields: args?.fields ?? {},
      gapReason: args?.gapReason ?? "",
      chatId,
    }).catch((err) => {
      console.error("[许愿池] 愿望入池失败:", err);
      return null;
    })
  );

  if (!stop) {
    return {
      ok: true,
      note: "已经记进许愿池，卡片会由系统发给用户。你只需一句话说明这杯现在做不出来、已经放进许愿池了，然后继续处理其余能点的杯子。",
    };
  }
  return {
    __stop: true,
    reply: "这杯现在菜单里还做不出来，我给你放进许愿池了：同事点一下 +1，攒的人多了就有机会上新。",
  };
}

// 文字回复之后补一张愿望卡片：用户第一次能看到"我的愿望现在有几个人想要"。
async function flushWishCards(chatId, userId, pendingWishes) {
  if (!pendingWishes || pendingWishes.length === 0) return;
  const created = (await Promise.all(pendingWishes)).filter(Boolean);
  for (const result of created) {
    await sendWishCard(
      chatId,
      buildWishDoneCard({
        wish: result.wish,
        rank: rankOf(result.wish.id),
        total: wishStats().total,
        merged: result.merged,
      }),
      "done",
      userId
    ).catch((err) => console.error("[许愿池] 愿望卡片发送失败:", err));
  }
}

// ===== 到岗推荐：员工到公司 5 分钟后，私聊推一张"一键下单"的卡 =====
//
// 位置从哪来：飞书没有"随时读位置"的接口，位置只在打卡流水里（我们只读，不做考勤）。
// 打卡流水里没有经纬度，但公司 WiFi 的 MAC 是固定的——命中它就是"人在公司"，比 GPS 半径更稳。
// 地点配置要等下权限后看真实候选来定，见 /admin/office/candidates。

const RECO_DECLINE_WORDS = /别推|不要推|不要推荐|不用推|停止推送|别再推|别发|关掉推送/;
const RECO_ACCEPT_WORDS = /早上叫我|继续推|恢复推送|接着推|可以推/;
// 演示阶段只在用户明确表达“已经到公司/到岗”时触发，避免普通闲聊误推。
// 允许常见口语前缀，但不把“快到了/准备到了”算作已到岗。

// 触发一次到岗推荐。频控（当天推过没有、被拒绝过几次）由调用方把关：
// 自动触发那条路在 arrivals.js 的轮询里判，用户主动说"我到了"那条路不判——他自己要的，就给。
async function onArrived(arrival) {
  const day = dateKey(new Date(arrival.at));
  const existing = findOpenReco(arrival.userId, day);
  if (existing) {
    console.log(`[到岗推荐] ${arrival.userId} 今天那张卡还没处理，不重复推（reco=${existing.id}）`);
    return existing;
  }

  const shop = getDefaultShop(arrival.userId) ?? {
    deptId: PARTY_DEFAULTS.deptId,
    deptName: PARTY_DEFAULTS.shopName,
    longitude: PARTY_DEFAULTS.longitude,
    latitude: PARTY_DEFAULTS.latitude,
  };
  const candidates = await buildCandidates(arrival.userId, { shop });
  if (candidates.length === 0) {
    // 没有历史、门店又没有新品：不推空卡，留个口子
    await replyCardToUser(arrival.userId,buildOrderEntryCard({ownerId:arrival.userId,message:'今天的自动推荐暂时没准备好，可以直接点选门店和饮品。'}));
    return null;
  }

  const reco = createReco({
    userId: arrival.userId,
    name: arrival.name,
    day,
    arrivalAt: arrival.at,
    place: arrival.place,
    trigger: 'arrival',
    shop,
    candidates,
  });

  try {
    await prepareProductImages(reco.candidates);
    const cardId = await createCardEntity(buildRecoCard(reco));
    reco.cardId = cardId;
    saveReco(reco);
    await sendCardEntityToUser(arrival.userId, cardId);
  } catch (err) {
    // 卡没发出去就当这张推荐单不存在。否则它会以 "sent" 的状态赖在库里，
    // 把这个人一整天的推送都挡掉（findOpenReco 会以为"他今天已经有一张卡了"）。
    reco.status = "failed";
    reco.error = String(err.message ?? err);
    saveReco(reco);
    throw err;
  }

  // 标记"今天已经推过"：轮询那边直接跳过，不用每分钟再走一遍判断
  markSent(arrival.userId, day);
  console.log(`[到岗推荐] 已私聊推卡 userId=${arrival.userId} 主推=${candidates[0].name}（共 ${candidates.length} 个候选）`);
  return reco;
}

// 改这张卡的唯一入口：先排队，进了队列再读最新状态、序号 +1、发出去。
// 直接写 updateCardEntity 会在连点时撞号（飞书要求 sequence 严格递增），"换一杯"就是这么丢的。
function updateRecoCard(recoId, build) {
  return enqueueCardUpdate(recoId, async () => {
    const latest = getReco(recoId);
    if (!latest?.cardId) return;
    await prepareProductImages(latest.candidates.slice(latest.index,latest.index+1));
    latest.sequence = (latest.sequence ?? 0) + 1;
    saveReco(latest);
    return updateCardEntity(latest.cardId, build(latest), latest.sequence);
  });
}

async function handleRecoAction({ actionName, value, operatorId, chatId, form, res }) {
  const reco = getReco(value.reco_id);
  if (!reco) return res.status(200).json({ toast: { type: "warning", content: "这张卡已经过期了，明天早上再叫我～" } });
  if (reco.userId !== operatorId) return res.status(200).json({ toast: { type: "warning", content: "这张卡是发给别人的～" } });
  const selectedShop=getActiveShop(operatorId,chatId);
  if(getPendingShopRequest(operatorId,chatId) || (selectedShop && String(selectedShop.deptId)!==String(reco.shop?.deptId))) {
    return res.json({toast:{type:'warning',content:'取餐地点已变化，请使用最新门店卡片。'}});
  }
  if(actionName==='reco_search') {
    if(reco.status!=='sent'||reco.trigger!=='manual')return res.status(200).json({toast:{type:'warning',content:'请使用当前推荐卡片。'}});
    const query=String(form?.query??'').trim().slice(0,80);
    if(!query)return res.status(200).json({toast:{type:'warning',content:'先写一个想喝的饮品名。'}});
    res.json({toast:{type:'info',content:'正在按你的描述换推荐…'}});
    void (async()=>{
      const shop=reco.shop??{deptId:PARTY_DEFAULTS.deptId,deptName:PARTY_DEFAULTS.shopName,longitude:PARTY_DEFAULTS.longitude,latitude:PARTY_DEFAULTS.latitude};
      const candidates=await searchCandidates({shop,query,max:3});
      const latest=getReco(reco.id);
      if(!latest||latest.status!=='sent')return;
      if(!candidates.length){await replyText(chatId,`我在${shop.deptName}没找到“${query}”，可以换个叫法再搜。`);return;}
      latest.candidates=candidates;latest.index=0;saveReco(latest);
      await updateRecoCard(latest.id,current=>buildRecoCard(current));
    })().catch(err=>console.error('[到岗推荐] 卡片搜索失败',err.message??err));
    return;
  }
  if(actionName==='reco_resume') {
    optIn(operatorId);
    if(reco.status==='declined')reco.status='sent';
    saveReco(reco);
    res.json({toast:{type:'success',content:'已恢复推荐'}});
    void updateRecoCard(reco.id,latest=>buildRecoCard(latest)).catch(err=>console.error('[推荐恢复失败]',err.message));
    return;
  }
  if(actionName==='reco_buy') {
    if(reco.status!=='sent'||!chatId)return res.json({toast:{type:'warning',content:'请使用当前推荐卡片。'}});
    if(value.candidate_index!==reco.index) {
      res.json({toast:{type:'info',content:'推荐已更新，请在最新卡片上选择。'}});
      void updateRecoCard(reco.id,latest=>buildRecoCard(latest)).catch(err=>console.error('[推荐刷新]',err.message));return;
    }
    const candidate=reco.candidates[reco.index];
    const shop=reco.shop ?? {deptId:PARTY_DEFAULTS.deptId,deptName:PARTY_DEFAULTS.shopName,longitude:PARTY_DEFAULTS.longitude,latitude:PARTY_DEFAULTS.latitude};
    reco.status='customizing';saveReco(reco);
    res.json({toast:{type:'info',content:'正在打开饮品、门店和规格调整卡…'}});
    void enqueueForUser(operatorId,()=>{if(reco.status!=='customizing')return;return orderUi.start({ownerId:operatorId,chatId,defaultShop:shop,previewOrder:{args:{deptId:shop.deptId,productList:[{productId:candidate.productId,skuCode:candidate.skuCode,amount:1}]},result:{}},userText:''});}).catch(err=>{reco.status='sent';saveReco(reco);console.error('[推荐转点单卡]',err.message);});
    return;
  }

  if (actionName === "reco_switch") {
    if (reco.status !== "sent") return res.status(200).json({ toast: { type: "warning", content: "这张卡已经不能换了。" } });
    reco.index = (reco.index + 1) % reco.candidates.length;
    saveReco(reco);
    const shown = reco.candidates[reco.index];
    // 先回执再改卡：飞书要求 3 秒内返回，改卡是一次外发请求，不能卡在这条路上。
    // 回执里明确说出换成了什么——之前只有卡面在变，用户还以为没生效。
    res.status(200).json({ toast: { type: "success", content: `换成「${shown.name}」了` } });
    void updateRecoCard(reco.id, (latest) => buildRecoCard(latest)).catch((err) =>
      console.error("[到岗推荐] 换一杯失败:", err.message ?? err)
    );
    return;
  }

  if (actionName === "reco_decline") {
    if (reco.status !== "sent") return res.status(200).json({});
    reco.status = "declined";
    const pref = markDeclined(reco.userId);
    reco.declineNote = pref.enabled === false
      ? "连着几天都没喝，我先不推了。想喝的时候回我一句「早上叫我」，随时重新开。"
      : pref.skipUntil
        ? "好，那先隔两天再问你。"
        : "好，今天就到这，明天早上再问你～";
    saveReco(reco);
    res.status(200).json({ toast: { type: "info", content: "好，今天不打扰你了。" } });
    void updateRecoCard(reco.id, (latest) => buildRecoDeclinedCard(latest)).catch((err) =>
      console.error("[到岗推荐] 封卡失败:", err.message ?? err)
    );
    return;
  }


  return res.status(200).json({});
}

// 到岗推荐的管理入口：看今天谁到了、推没推、配置对不对
app.get("/admin/arrivals", (req, res) => {
  const day = req.query.day ?? dateKey();
  const map = loadEmployeeMap();
  res.json({
    day,
    config: loadOfficeConfig(),
    employeeMap: { updatedAt: map.updatedAt ? new Date(map.updatedAt).toISOString() : null, mapped: Object.keys(map.map ?? {}).length },
    arrivals: listArrivals(day),
    prefs: loadPrefs(),
    recos: listRecos()
      .filter((r) => (r.createdAt ?? "").startsWith(day) || dateKey(new Date(r.createdAt)) === day)
      .map((r) => ({ id: r.id, userId: r.userId, status: r.status, shown: r.candidates?.[r.index]?.name, orderId: r.order?.data?.orderIdStr ?? null })),
  });
});

// 打卡地点/WiFi 候选：权限批下来之后先看这个，再决定公司地点怎么配，不用猜
app.get("/admin/office/candidates", (req, res) => {
  res.json(loadCandidates());
});

app.post("/admin/office", (req, res) => {
  const allowed = [
    "enabled", "chats", "windowFrom", "windowTo", "delayMinutes", "staleMinutes",
    "wifiBssids", "wifiSsids", "locationKeywords", "pollFrom", "pollTo",
    "acceptLocationMessage", "officeLatitude", "officeLongitude", "officeRadiusMeters",
  ];
  const patch = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));
  res.json({ ok: true, config: saveOfficeConfig(patch) });
});

// 立刻跑一次到岗轮询，不用等定时器
app.post("/admin/arrivals/poll", (req, res) => {
  const force = req.query.force === "1"; // force=1 时跳过"轮询时段"限制，方便白天调试
  res.json({ ok: true, force });
  void runArrivalTickNow(onArrived, { force }).catch((err) => console.error("[到岗] 手动轮询失败", err));
});

// 直接给某人推一张推荐卡：测链路用，不看时间窗、不看频控
app.post("/admin/reco/test/:userId", async (req, res) => {
  try {
    const reco = await onArrived({
      userId: req.params.userId,
      name: req.body?.name ?? null,
      at: Date.now(),
      place: req.body?.place ?? "手动触发",
      via: "manual",
      source: "manual",
    });
    res.json({ ok: true, reco: reco && { id: reco.id, main: reco.candidates[reco.index]?.name } });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/admin/reset/:userId", (req, res) => {
  resetHistory(req.params.userId);
  res.json({ ok: true });
});

// 许愿池的管理入口：AI 绝不自动改状态、更不承诺上市，状态只能从这里人工推进。
app.get("/admin/wishes", (req, res) => {
  res.json({
    period: periodName(),
    stats: wishStats(),
    wishes: listWishes().map((w) => ({
      id: w.id,
      name: w.name,
      status: w.status,
      votes: w.votes?.length ?? 0,
      quotes: w.quotes?.length ?? 0,
      updatedAt: w.updatedAt,
    })),
  });
});

app.post("/admin/wishes/:id/status", async (req, res) => {
  const { status, note } = req.body ?? {};
  let result;
  try {
    result = setWishStatus(req.params.id, status, note);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (!result) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, wish: { id: result.wish.id, name: result.wish.name, status: result.wish.status } });

  // 形态 D：状态一变就回群里 @ 许愿的人。匿名许愿的人不能 @，否则等于把署名强行揭开。
  const { wish, previous } = result;
  const mentionOpenIds = [...new Set((wish.quotes ?? []).filter((q) => !q.anonymous).map((q) => q.userId).filter(Boolean))];
  if (wish.chatId) {
    await replyCard(wish.chatId, buildWishStatusCard({ wish, previous, note, mentionOpenIds })).catch((err) =>
      console.error("[许愿池] 状态通知发送失败:", err)
    );
  }
});

app.delete("/admin/wishes/:id", (req, res) => {
  const removed = removeWish(req.params.id);
  if (!removed) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, removed: { id: removed.id, name: removed.name } });
});

const port = process.env.PORT || 3000;

export { app, orderUi, handleMessage, handleRecoAction };
if (process.env.LUCKYDAY_TEST_MODE !== '1') {
mcpInitialize(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN)
  .then(async () => {
    const additionalServers = [];
    if (AMAP_MCP) {
      try {
        await mcpInitialize(AMAP_MCP.url, AMAP_MCP.token);
        additionalServers.push(AMAP_MCP);
        console.log(`地图 MCP 已初始化: ${AMAP_MCP.url.replace(/key=[^&]+/, "key=***")}`);
      } catch (err) {
        console.error("地图 MCP 初始化失败，位置语义暂时降级:", err.message);
      }
    } else {
      console.log("地图 MCP 未启用：缺少 AMAP_MAPS_API_KEY");
    }
    return loadMcpTools(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, { additionalServers });
  })
  .then((tools) => console.log(`MCP 已初始化，工具 schema 已从服务器拉取: ${tools.map((t) => t.function.name).join(", ")}`))
  .then(() => startScheduler(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN,{onNeedsConfirmation:(item,notice)=>enqueueForUser(item.userId,()=>orderUi.start({ownerId:item.userId,chatId:item.chatId,previewOrder:{args:{deptId:item.deptId,productList:item.productList},result:{}},notice}))}))
  .then(() => startAfternoonTeaScheduler())
  .then(() => startArrivalWatcher({ onArrived }))
  .catch((err) => console.error("MCP 初始化/拉取工具失败:", err));

app.listen(port, () => console.log(`Lucky Barista 飞书 bot 已启动: http://localhost:${port}/feishu/events`));
}
