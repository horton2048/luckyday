// 早上那杯的推荐引擎：只做三件事——挑候选、验证候选真能下单、下单。
//
// 取舍说明：
// - 主推新品（用户原话是"要么推新品，要么推他常点的"），备选是他上次真点过的那杯。
// - 候选一定要过一遍 previewOrder：既拿到真实到手价（卡片上写 ¥12.90 就得真是 12.90），
//   也顺手把售罄/下架的筛掉——不然用户点下去才发现下不了单，体验最差。
// - 常点那杯直接用他上次的 skuCode，规格（大杯/冰/少甜）就是他上次真实下单的那套，不用猜。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpCallTool } from "./mcpClient.js";
import { getRecentOrders } from "./tastes.js";
import { PARTY_DEFAULTS } from "./party.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECO_PATH = join(__dirname, "../data/recommendations.json");
const ATTR_ORDER = ["温度", "杯型", "糖度"];

function selectedAttrs(attrs) {
  const picked = [];
  for (const name of ATTR_ORDER) {
    const attr = (attrs ?? []).find((a) => a.attributeName === name);
    const selected = (attr?.productSubAttrs ?? []).find((s) => s.selected);
    if (selected) picked.push(selected.attributeName);
  }
  return picked.join("/");
}

async function call(tool, args) {
  return mcpCallTool(process.env.LUCKIN_MCP_URL, process.env.LUCKIN_MCP_ORDER_TOKEN, tool, args);
}

async function productDetail(deptId, productId) {
  const res = await call("queryProductDetailInfo", { deptId, productId });
  return res?.data ?? null;
}

async function newArrivals(deptId) {
  const res = await call("searchProductForMcp", { deptId, query: "新品" });
  return (res?.data ?? []).filter((p) => (p.tags ?? []).includes("新品"));
}

// Card search uses the same verification path as the curated recommendation:
// search the real menu, load each product's actual SKU/specs, then preview it
// before it is allowed onto the card.
export async function searchCandidates({ shop, query, max = 3 } = {}) {
  const deptId = shop?.deptId ?? PARTY_DEFAULTS.deptId;
  const res = await call("searchProductForMcp", { deptId, query: String(query ?? "").trim() });
  const items = Array.isArray(res?.data) ? res.data : [];
  const candidates = [];
  for (const item of items) {
    if (candidates.length >= max || !item?.productId) break;
    const detail = await productDetail(deptId, item.productId).catch(() => null);
    const candidate = {
      productId: item.productId,
      skuCode: detail?.skuCode ?? item.skuCode,
      name: detail?.productName ?? item.productName,
      pictureUrl: detail?.pictureUrl || item.pictureUrl,
      price: item.estimatePrice ?? item.initialPrice,
      attrText: selectedAttrs(detail?.productAttrs),
      source: "search",
      note: "按你的描述找到的饮品",
    };
    if (!candidate.skuCode) continue;
    const checked = await preview(deptId, candidate).catch(() => null);
    if (!checked) continue;
    candidates.push({ ...candidate, price: checked.price, couponCodeList: checked.couponCodeList });
  }
  return candidates;
}

// 真金白银的验证：这一杯现在能不能下单、到手多少钱。
async function preview(deptId, candidate) {
  const res = await call("previewOrder", {
    deptId,
    productList: [{ productId: candidate.productId, skuCode: candidate.skuCode, amount: 1 }],
  });
  if (res?.success === false || res?.code !== 0) return null;
  const data = res?.data ?? {};
  const price = data.discountPrice ?? data.totalPrice ?? data.price;
  return {
    price: Number.isFinite(Number(price)) ? Number(price) : candidate.price,
    couponCodeList: data.couponCodeList ?? [],
  };
}

// 顺序是「今日新品 → 他常点的那杯 → 第二杯新品」，「换一杯」就按这个顺序轮。
export async function buildCandidates(userId, { deptId = PARTY_DEFAULTS.deptId, shop = null, max = 3 } = {}) {
  // The recommendation engine used to be permanently tied to the demo store.
  // Resolve the effective store once so both product lookup and preview use the
  // user's saved default when one exists.
  deptId = shop?.deptId ?? deptId;
  const last = getRecentOrders(userId, 5)
    .flatMap((order) => order.items ?? [])
    .filter((item) => item?.productId)[0];

  let usual = null;
  if (last) {
    const detail = await productDetail(deptId, last.productId).catch(() => null);
    if (detail) {
      usual = {
        productId: detail.productId,
        skuCode: last.skuCode ?? detail.skuCode,
        name: detail.productName,
        pictureUrl: detail.pictureUrl,
        price: detail.estimatePrice ?? detail.initialPrice,
        attrText: selectedAttrs(detail.productAttrs),
        source: "usual",
        note: "你之前点过的那杯",
      };
    }
  }

  const news = [];
  for (const item of await newArrivals(deptId).catch(() => [])) {
    if (usual && item.productId === usual.productId) continue;
    if (news.some((n) => n.productId === item.productId)) continue;
    const detail = await productDetail(deptId, item.productId).catch(() => null);
    news.push({
      productId: item.productId,
      skuCode: detail?.skuCode ?? item.skuCode,
      name: detail?.productName ?? item.productName,
      pictureUrl: detail?.pictureUrl || item.pictureUrl,
      price: item.estimatePrice ?? item.initialPrice,
      attrText: selectedAttrs(detail?.productAttrs),
      source: "new",
      note: "今天的新品",
    });
    if (news.length >= 2) break;
  }

  const raw = [news[0], usual, news[1]].filter(Boolean);

  const candidates = [];
  for (const candidate of raw) {
    if (candidates.length >= max) break;
    if (!candidate?.productId || !candidate.skuCode) continue;
    const checked = await preview(deptId, candidate).catch(() => null);
    if (!checked) {
      console.log(`[推荐] 候选当前下不了单，已剔除：${candidate.name}`);
      continue;
    }
    candidates.push({ ...candidate, price: checked.price, couponCodeList: checked.couponCodeList });
  }
  return candidates;
}

export async function placeRecoOrder(candidate, { deptId = PARTY_DEFAULTS.deptId } = {}) {
  return call("createOrder", {
    deptId,
    productList: [{ productId: candidate.productId, skuCode: candidate.skuCode, amount: 1 }],
    longitude: PARTY_DEFAULTS.longitude,
    latitude: PARTY_DEFAULTS.latitude,
    ...(candidate.couponCodeList?.length ? { couponCodeList: candidate.couponCodeList } : {}),
  });
}

// ==== 推荐单状态 ====
// 卡片发出去之后还要能改（换一杯/已下单），而且支付可能隔几分钟才完成，所以状态落盘，重启不丢。
function loadStore() {
  if (!existsSync(RECO_PATH)) return {};
  try {
    return JSON.parse(readFileSync(RECO_PATH, "utf8"));
  } catch (err) {
    console.error("[推荐] recommendations.json 解析失败，按空处理:", err.message);
    return {};
  }
}

function persistStore(store) {
  mkdirSync(dirname(RECO_PATH), { recursive: true });
  writeFileSync(RECO_PATH, JSON.stringify(store, null, 2), "utf8");
}

export function createReco(record) {
  const store = loadStore();
  const id = `reco_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const reco = { id, status: "sent", index: 0, sequence: 1, createdAt: new Date().toISOString(), ...record };
  store[id] = reco;
  persistStore(store);
  return reco;
}

export function getReco(id) {
  return loadStore()[id] ?? null;
}

export function saveReco(reco) {
  const store = loadStore();
  store[reco.id] = reco;
  persistStore(store);
  return reco;
}

export function listRecos() {
  return Object.values(loadStore());
}

// 当天还没被处理掉的那张卡（sent/ordering）。用来挡住重复推卡：
// 用户连说几次「我到公司了」，不该收到一叠一模一样的卡。
export function findOpenReco(userId, day) {
  return Object.values(loadStore()).find((r) => r.userId === userId && r.day === day && ["sent", "ordering"].includes(r.status)) ?? null;
}
