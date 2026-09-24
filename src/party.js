// 下午茶拼单：一天一群一局。
//
// 设计取舍（都是刻意的）：
// - 状态放内存，进程重启就没了。拼单是有时效的活动（默认 20 分钟窗口），丢了重新发起即可，
//   不值得为它引一套持久化；历史在结束时归档到 data/parties.jsonl 供复盘。
// - 名单刷新只更新 roster 这一个组件（updateCardElement），不用整卡重绘——整卡重绘会把
//   别人正在填的表单一起重置掉，这是这套交互里最容易踩的坑。
// - 下单用 bot 自己绑定的账号（就是老板账号），所以"谁付钱"不需要在流程里讨论。

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpCallTool } from "./mcpClient.js";
import { createCardEntity, sendCardEntity, updateCardEntity, updateCardElement, replyCard, replyImageKey, replyTextToUser, uploadImageFromUrl, getChatInfo, resolveUserName } from "./feishu.js";
import { buildPartyCard, buildPartyConfirmCard, buildPartyRosterElement, buildPartyClosedCard, buildPartyPaymentCard, formatMoney } from "./partyCards.js";
import { getRecentOrders } from "./tastes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_PATH = join(__dirname, "../data/parties.jsonl");

export const PARTY_DEFAULTS = {
  deptId: Number(process.env.PARTY_DEPT_ID ?? 603443),
  shopName: process.env.PARTY_SHOP_NAME ?? "西大望路平乐园店",
  longitude: Number(process.env.PARTY_LONGITUDE ?? 116.477017),
  latitude: Number(process.env.PARTY_LATITUDE ?? 39.886502),
  durationMinutes: Number(process.env.PARTY_DURATION_MINUTES ?? 20),
  // 老板（付款人）。默认黄运樟——拼单统一用老板账号下单，二维码发群里 @他扫。
  payerOpenId: process.env.PARTY_PAYER_OPEN_ID ?? "ou_a6891da2b2281c24a76bc81f7abce9bb",
};

const parties = new Map();
const activeByChat = new Map();

function dateKey(date = new Date()) {
  return date.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function archived(party) {
  return { ...party, participants: party.participants ?? [] };
}

function archive(party) {
  try {
    mkdirSync(dirname(ARCHIVE_PATH), { recursive: true });
    appendFileSync(ARCHIVE_PATH, JSON.stringify(archived(party)) + "\n", "utf8");
  } catch (err) {
    console.error("拼单归档失败:", err);
  }
}

export function getParty(id) {
  return parties.get(id) ?? null;
}

export function getActiveParty(chatId) {
  const id = activeByChat.get(chatId);
  if (!id) return null;
  const party = parties.get(id);
  if (!party || ["cancelled", "failed"].includes(party.status)) return null;
  return party;
}

export function hasPartyToday(chatId) {
  const today = dateKey();
  return [...parties.values()].some((p) => p.chatId === chatId && p.dateKey === today);
}

export function listOpenParties() {
  return [...parties.values()].filter((p) => p.status === "open");
}

// 发起时就把新品的商品详情一并取回来缓存住。这样后面每个人点单都能在内存里直接解析出
// productId/skuCode 和可用属性，不用再打两次接口——卡片回调必须 3 秒内返回，这里的省时很关键。
async function fetchNewProducts(deptId) {
  const res = await mcpCallTool(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, "searchProductForMcp", {
    deptId,
    query: "新品",
  });
  const list = (res?.data ?? []).filter((p) => (p.tags ?? []).includes("新品")).slice(0, 3);
  const detailed = [];
  for (const p of list) {
    const detail = await mcpCallTool(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, "queryProductDetailInfo", {
      deptId,
      productId: p.productId,
    }).catch(() => null);
    const product = detail?.data;
    detailed.push({
      productId: p.productId,
      skuCode: product?.skuCode ?? p.skuCode,
      name: product?.productName ?? p.productName,
      price: p.estimatePrice ?? p.initialPrice,
      attrs: product?.productAttrs ?? [],
    });
  }
  return detailed;
}

export async function startParty({ chatId, initiatorId, durationMinutes, deptId, shopName, payerOpenId }) {
  const existing = getActiveParty(chatId);
  if (existing) return { party: existing, reused: true };

  const duration = durationMinutes ?? PARTY_DEFAULTS.durationMinutes;
  const party = {
    id: `party_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    chatId,
    dateKey: dateKey(),
    initiatorId,
    deptId: deptId ?? PARTY_DEFAULTS.deptId,
    shopName: shopName ?? PARTY_DEFAULTS.shopName,
    payerOpenId: payerOpenId ?? PARTY_DEFAULTS.payerOpenId,
    status: "open",
    deadline: Date.now() + duration * 60 * 1000,
    participants: [],
    newProducts: [],
    sequence: 0,
    createdAt: new Date().toISOString(),
  };

  party.newProducts = await fetchNewProducts(party.deptId).catch((err) => {
    console.error("拼单取新品失败:", err);
    return [];
  });

  party.cardId = await createCardEntity(buildPartyCard(party));
  const sent = await sendCardEntity(chatId, party.cardId);
  party.messageId = sent?.message_id;

  parties.set(party.id, party);
  activeByChat.set(chatId, party.id);
  console.log(`[拼单发起] id=${party.id} chat=${chatId} 截止=${new Date(party.deadline).toISOString()}`);
  return { party, reused: false };
}

// 名单刷新：只替换 roster 组件，不动表单。
async function refreshRoster(party) {
  party.sequence += 1;
  await updateCardElement(party.cardId, "roster", buildPartyRosterElement(party), party.sequence).catch((err) =>
    console.error("拼单刷新名单失败:", err)
  );
}

export async function joinParty(partyId, entry) {
  const party = getParty(partyId);
  if (!party || party.status !== "open") {
    return { ok: false, reason: party?.status === "open" ? "not_found" : "closed" };
  }

  const participants = party.participants.filter((p) => p.userId !== entry.userId);
  participants.push({ ...entry, updatedAt: new Date().toISOString() });
  party.participants = participants;
  await refreshRoster(party);
  return { ok: true, party };
}

export async function setPartyStatus(partyId, status, patch = {}) {
  const party = getParty(partyId);
  if (!party) return null;
  Object.assign(party, patch, { status });
  return party;
}

// 解析用户填的饮品：关键词 → 真实商品 → （按需）切换温度/杯型拿到正确 skuCode。
// 命中缓存（卡片下拉里的新品）时全程零接口调用；只有手输关键词才需要联网查。
async function resolveDrink(party, { keyword, temp, size }) {
  const cached = (party.newProducts ?? []).find((p) => p.name === keyword);

  let base;
  if (cached) {
    base = { productId: cached.productId, skuCode: cached.skuCode, productName: cached.name, attrs: cached.attrs };
  } else {
    const search = await mcpCallTool(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, "searchProductForMcp", {
      deptId: party.deptId,
      query: keyword,
    });
    const hit = (search?.data ?? [])[0];
    if (!hit) return null;
    const detail = await mcpCallTool(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, "queryProductDetailInfo", {
      deptId: party.deptId,
      productId: hit.productId,
    });
    base = {
      productId: hit.productId,
      skuCode: detail?.data?.skuCode ?? hit.skuCode,
      productName: detail?.data?.productName ?? hit.productName,
      attrs: detail?.data?.productAttrs ?? [],
    };
  }

  let skuCode = base.skuCode;

  // 温度/杯型要逐项切换：用户的表述是"冰/大杯"，接口要的是 attributeId + 子属性 id。
  const chosen = [
    { attrName: "温度", value: temp },
    { attrName: "杯型", value: size },
  ].filter((c) => c.value);

  const appliedAttrs = [];
  for (const { attrName, value } of chosen) {
    const attr = (base.attrs ?? []).find((a) => a.attributeName === attrName);
    const sub = (attr?.productSubAttrs ?? []).find((s) => s.attributeName === value);
    // 这杯本身没有这个属性选项（比如「苹果碰」只有特调杯，没有大杯）——忽略即可，
    // 不该因为用户没改默认值就报错，也不该把「大杯(未识别)」这种噪音写进名单。
    if (!attr || !sub) {
      if(attrName==='温度')return {ok:false,reason:'attr_unavailable',detail:`${value}${attrName}`};
      continue;
    }
    if (sub.selected) {
      appliedAttrs.push(value);
      continue;
    }
    try {
      const switched = await mcpCallTool(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, "switchProduct", {
        deptId: party.deptId,
        productId: base.productId,
        skuCode,
        amount: 1,
        attrOperationParam: { attributeId: attr.attributeId, subAttr: { attributeId: sub.attributeId, operation: 1 } },
      });
      // 这里必须判业务码：组合售罄时接口返回 success:false，但不算 RPC 错误，不会被 mcpCallTool 抛出来。
      // 不拦住的话就会拿着旧 skuCode 去下单，用户明明选了「热」结果收到「冰」。
      if (switched?.code !== 0 || !switched?.data?.skuCode) {
        return { ok: false, reason: "attr_unavailable", detail: `${value}${attrName}`, message: switched?.msg };
      }
      skuCode = switched.data.skuCode;
      if(switched.data.productAttrs)base.attrs=switched.data.productAttrs;
      appliedAttrs.push(value);
    } catch (err) {
      console.error("拼单切换商品属性失败:", err.message);
      return { ok: false, reason: "attr_unavailable", detail: `${value}${attrName}`, message: err.message };
    }
  }

  // 没选温度/杯型时，用商品详情里的默认组合说明它是什么，避免名单上信息缺失。
  if (appliedAttrs.length === 0) {
    for (const attr of base.attrs ?? []) {
      const selected = (attr.productSubAttrs ?? []).find((s) => s.selected);
      if (selected && ["温度", "杯型"].includes(attr.attributeName)) appliedAttrs.push(selected.attributeName);
    }
  }

  return {
    productId: base.productId,
    skuCode,
    productName: base.productName,
    attrText: appliedAttrs.join("/"),
  };
}

export async function submitPartyDrink(partyId, { userId, form }) {
  const party = getParty(partyId);
  if (!party || party.status !== "open") return { ok: false, reason: "closed" };

  const keyword = (form?.other ?? "").trim() || (form?.drink ?? "").trim();
  if (!keyword) return { ok: false, reason: "no_drink" };

  let userName = userId;
  try {
    userName = (await resolveUserName(party.chatId, userId)) ?? userId;
  } catch {
    // 拿不到名字不影响下单，退回 open_id 展示
  }

  const drink = await resolveDrink(party, { keyword, temp: form?.temp, size: form?.size });
  if (!drink) return { ok: false, reason: "not_found", keyword };
  if (drink.ok === false) return { ok: false, reason: drink.reason, detail: drink.detail, keyword };

  const amount = Math.min(Math.max(Number(form?.amount ?? form?.quantity ?? 1) || 1, 1), 4);
  await joinParty(partyId, { userId, userName, mode: "custom", amount, ...drink });
  return { ok: true, party, drink, userName, amount };
}

export async function joinWithLastOrder(partyId, userId) {
  const party = getParty(partyId);
  if (!party || party.status !== "open") return { ok: false, reason: "closed" };

  const last = getRecentOrders(userId, 1)[0];
  const item = last?.items?.[0];
  if (!item?.productId) return { ok: false, reason: "no_history" };

  let productName = "上次那杯";
  try {
    const detail = await mcpCallTool(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, "queryProductDetailInfo", {
      deptId: party.deptId,
      productId: item.productId,
    });
    productName = detail?.data?.productName ?? productName;
  } catch (err) {
    console.error("拼单取上次商品失败:", err.message);
  }

  let userName = userId;
  try {
    userName = (await resolveUserName(party.chatId, userId)) ?? userId;
  } catch {
    // 同上
  }

  await joinParty(partyId, {
    userId,
    userName,
    mode: "same_as_last",
    amount: item.amount ?? 1,
    productId: item.productId,
    skuCode: item.skuCode,
    productName,
    attrText: "同上次",
  });
  return { ok: true, party, productName, amount: item.amount ?? 1 };
}

export async function declineParty(partyId, userId, userName) {
  const party = getParty(partyId);
  if (!party || party.status !== "open") return null;
  await joinParty(partyId, { userId, userName, mode: "declined", amount: 0, productName: "今天不喝" });
  return party;
}

// 截止 → 汇总报价 → 出确认卡（@老板）
export async function closeParty(partyId) {
  const party = getParty(partyId);
  if (!party || party.status !== "open") return null;

  party.status = "summarizing";
  const joined = party.participants.filter((p) => p.mode !== "declined");
  if (joined.length === 0) {
    party.status = "cancelled";
    activeByChat.delete(party.chatId);
    party.sequence += 1;
    await updateCardEntity(party.cardId, buildPartyClosedCard(party, { title: "**这场下午茶没有人点**", note: "已取消" }), party.sequence).catch((err) =>
      console.error("拼单封口失败:", err)
    );
    archive(party);
    return { party, empty: true };
  }

  const productList = joined.map((p) => ({ productId: p.productId, skuCode: p.skuCode, amount: p.amount ?? 1 }));
  const preview = await mcpCallTool(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, "previewOrder", {
    deptId: party.deptId,
    productList,
  });
  party.preview = preview;
  party.status = "confirming";
  party.sequence += 1;
  await updateCardEntity(party.cardId, buildPartyConfirmCard(party), party.sequence);
  console.log(`[拼单截止] id=${party.id} ${joined.length} 人 ${productList.length} 项 合计=${formatMoney(preview?.data?.discountPrice)}`);
  return { party, empty: false };
}

// 老板确认 → 真下单 → 支付卡发群里 @老板
export async function confirmPartyOrder(partyId) {
  const party = getParty(partyId);
  if (!party || party.status !== "confirming") return { ok: false, reason: "not_confirming" };

  party.status = "ordering";
  const joined = party.participants.filter((p) => p.mode !== "declined");
  const productList = joined.map((p) => ({ productId: p.productId, skuCode: p.skuCode, amount: p.amount ?? 1 }));

  try {
    const order = await mcpCallTool(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, "createOrder", {
      deptId: party.deptId,
      productList,
      longitude: PARTY_DEFAULTS.longitude,
      latitude: PARTY_DEFAULTS.latitude,
      ...(party.preview?.data?.couponCodeList ? { couponCodeList: party.preview.data.couponCodeList } : {}),
    });
    const qrCodeUrl = order?.data?.payOrderQrCodeUrl;
    if (!qrCodeUrl) throw new Error(`创建订单未返回支付二维码: ${JSON.stringify(order).slice(0, 300)}`);

    party.status = "ordered";
    party.order = order;
    activeByChat.delete(party.chatId);
    archive(party);

    // 支付卡：直接发群里 @老板，符合"老板统一付款"的约定
    const imageKey = await uploadImageFromUrl(qrCodeUrl).catch((err) => {
      console.error("拼单二维码上传失败:", err.message);
      return null;
    });
    await replyCard(party.chatId, buildPartyPaymentCard(party, imageKey)).catch((err) =>
      console.error("拼单支付卡发送失败:", err)
    );
    if (imageKey) await replyImageKey(party.chatId, imageKey).catch((err) => console.error("拼单二维码图片发送失败:", err));

    party.sequence += 1;
    await updateCardEntity(party.cardId, buildPartyClosedCard(party, {
      title: "**已下单，等老板扫码支付**",
      note: `订单号 ${order?.data?.orderIdStr ?? ""}`,
      template: "green",
    }), party.sequence).catch((err) => console.error("拼单下单后封口失败:", err));

    await notifyParticipants(party, order).catch((err) => console.error("拼单私聊回执失败:", err));
    return { ok: true, party, order, qrCodeUrl };
  } catch (err) {
    party.status = "failed";
    party.error = String(err);
    console.error(`[拼单下单失败] id=${party.id}`, err);
    return { ok: false, reason: "order_failed", error: err.message };
  }
}

async function notifyParticipants(party, order) {
  for (const p of party.participants.filter((x) => x.mode !== "declined")) {
    await replyTextToUser(p.userId, `你那杯「${p.productName}」已经在下午茶拼单里下单啦（订单号 ${order?.data?.orderIdStr ?? ""}），老板统一付款～`);
  }
}

export async function chatOwnerId(chatId) {
  const info = await getChatInfo(chatId).catch(() => null);
  return info?.owner_id ?? null;
}
