// 许愿池：把 DIY 里"现在做不出来"的愿望，从私聊里的一句话变成群里看得见、能投票、能追进度的资产。
//
// 和拼单（party.js）刻意的取舍差异：
// - 拼单是当天的一场活动，状态放内存、进程重启丢了也无所谓；许愿池是长期资产（几个月后
//   还要能回答"这个愿望当时有多少人想要"），所以落盘成 JSON 整体读写，投票和状态都能改。
// - 聚类必须保守：把两个不同的愿望合并，比不合并更伤口碑——用户会觉得"机器人根本没听懂我"。
//   所以拿不准一律新建。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendWish } from "./wishlist.js";
import { chatJson } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, "../data/wishes.json");
const LEGACY_PATH = join(__dirname, "../data/wishlist.jsonl");

// 状态只能由人推进（走 /admin/wishes/:id/status），AI 永远不自动改状态、更不承诺上市。
export const WISH_STATUS = {
  pooled: "已入池",
  candidate: "本期候选",
  evaluating: "评估中",
  launched: "已上市",
  rejected: "本轮未入选",
};

const HEAT_HALF_LIFE_DAYS = 7; // 热度半衰期：新愿望有机会冒头，老愿望也不会被永久顶在上面
// 模型偶发 429 会带退避重试（1s/2s/4s），给的时间太紧会把"能成功"的调用掐断，
// 降级成"新建愿望"——方向安全但会多出一个重复条目，所以留足重试预算。
const CLUSTER_TIMEOUT_MS = 20_000;
// 只把"字面就相近"的候选交给模型判断。纯靠模型判断实测不稳定：同一句"黑芝麻糊热奶茶"
// 有时会被它并进"果香清亮"里，用户会觉得机器人根本没听懂。合并错了比不合并伤口碑得多，
// 所以先用字符二元组相似度筛一道，模型只在真正接近的候选里做选择（一个都不接近时它无权合并）。
const SHORTLIST_MIN_SCORE = 0.12;
const SHORTLIST_MAX = 5;

let store = null;

function emptyStore() {
  return {
    period: { id: `p_${Date.now()}`, name: "第 1 期", startAt: new Date().toISOString() },
    wishes: [],
  };
}

function saveStore() {
  if (!store) return;
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

// 老的 wishlist.jsonl 是"只写不读"的流水账，第一次运行时把它当成历史愿望导进来，
// 否则线上已有的真实愿望会永远看不见（这正是当初做许愿池要解决的第一个问题）。
function migrateLegacy() {
  if (!existsSync(LEGACY_PATH)) return [];
  let lines = [];
  try {
    lines = readFileSync(LEGACY_PATH, "utf8").split("\n").filter(Boolean);
  } catch (err) {
    console.error("许愿池迁移：读取历史文件失败:", err.message);
    return [];
  }

  const migrated = [];
  // 同一个风味直接算同一个愿望：历史流水里"火龙果"出现过两次（都是同一个人先后许的），
  // 迁移时不合并的话，许愿池一上线就会自己跟自己重复，显得很傻。
  const byFlavor = new Map();
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const flavor = String(record.collected?.flavor ?? "").trim();
    // 过滤掉"用户没说清楚想喝什么"的流水记录（比如只说了"我要喝美式"），
    // 它们不是真正的愿望，放上榜反而像机器人在瞎记。
    if (!flavor || /^(未知|未指定|无|none)$/i.test(flavor)) continue;
    const words = Array.isArray(record.rawUserWords) ? record.rawUserWords : [String(record.rawUserWords ?? "")];
    const text = words.filter(Boolean).join("；").trim();
    if (!text) continue;
    const at = record.createdAt ?? new Date().toISOString();
    const existing = byFlavor.get(flavor);
    if (existing) {
      existing.quotes.push({ userId: record.feishuUserId, userName: null, text, anonymous: false, at });
      if (record.feishuUserId && !existing.votes.includes(record.feishuUserId)) existing.votes.push(record.feishuUserId);
      if (at > existing.lastQuoteAt) existing.lastQuoteAt = at;
      existing.updatedAt = existing.lastQuoteAt;
      continue;
    }
    const wish = {
      id: `wish_legacy_${migrated.length + 1}`,
      name: flavor.length > 16 ? `${flavor.slice(0, 16)}…` : flavor,
      quotes: [{ userId: record.feishuUserId, userName: null, text, anonymous: false, at }],
      fields: record.collected ?? {},
      votes: record.feishuUserId ? [record.feishuUserId] : [],
      status: "pooled",
      chatId: null,
      legacy: true,
      createdAt: at,
      updatedAt: at,
      lastQuoteAt: at,
      statusNote: record.gapReason ?? "",
    };
    byFlavor.set(flavor, wish);
    migrated.push(wish);
  }
  return migrated;
}

export function loadStore() {
  if (store) return store;
  if (existsSync(STORE_PATH)) {
    try {
      store = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    } catch (err) {
      console.error("许愿池数据解析失败，从空池开始（原文件保留）:", err.message);
      store = emptyStore();
    }
  } else {
    store = emptyStore();
    store.wishes = migrateLegacy();
    if (store.wishes.length > 0) {
      console.log(`许愿池：已从 wishlist.jsonl 迁移 ${store.wishes.length} 个历史愿望`);
      saveStore();
    }
  }
  store.wishes ??= [];
  store.period ??= emptyStore().period;
  return store;
}

export function periodName() {
  return loadStore().period?.name ?? "本期";
}

export function listWishes() {
  return [...loadStore().wishes].sort((a, b) => heatOf(b) - heatOf(a));
}

export function getWish(id) {
  return loadStore().wishes.find((w) => w.id === id) ?? null;
}

export function heatOf(wish, now = Date.now()) {
  const last = new Date(wish.updatedAt ?? wish.createdAt ?? now).getTime();
  const days = Math.max(0, (now - last) / 86_400_000);
  return (wish.votes?.length ?? 0) * 0.5 ** (days / HEAT_HALF_LIFE_DAYS);
}

export function rankOf(wishId) {
  const sorted = listWishes();
  const index = sorted.findIndex((w) => w.id === wishId);
  return index < 0 ? null : index + 1;
}

export function wishesOfUser(userId) {
  return loadStore().wishes.filter((w) => w.quotes?.some((q) => q.userId === userId));
}

export function wishStats() {
  const all = loadStore().wishes;
  return {
    total: all.length,
    candidate: all.filter((w) => w.status === "candidate").length,
  };
}

function candidatesForClustering() {
  // 已上市/已否掉的愿望不再作为合并目标：这杯已经做出来了，再许一个也不该并进去。
  return loadStore().wishes.filter((w) => !["launched", "rejected"].includes(w.status));
}

function fallbackName(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > 12 ? `${clean.slice(0, 12)}…` : clean;
}

// 中文字符二元组 Dice 相似度。不上分词库：许愿原话都很短，二元组对这种短文本够用了，
// 而且没有依赖、不会因为分词结果不同而漂移。
function bigrams(value) {
  const clean = String(value ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const set = new Set();
  if (clean.length === 1) set.add(clean);
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

export function bigramSimilarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const g of left) if (right.has(g)) hit++;
  return (2 * hit) / (left.size + right.size);
}

function wishBlob(wish) {
  return [wish.name, ...(wish.quotes ?? []).map((q) => q.text), ...Object.values(wish.fields ?? {})].filter(Boolean).join(" ");
}

function blobOf(text, fields = {}) {
  return [text, ...Object.values(fields ?? {})].filter(Boolean).join(" ");
}

// "奶香""热""拿铁"这类词几乎每杯咖啡都沾边，拿它当合并依据等于没依据。
// 真正能证明"是同一杯"的必须是具体的主风味词（葡萄、西瓜、黑芝麻、生椰…）。
const GENERIC_FLAVOR = /^(热|冰|冷|温|温热|甜|糖|不加糖|少甜|标准甜|奶|奶香|拿铁|咖啡|奶茶|饮品|饮料|美式|味道|口感|风味|清爽|提神|咖啡因|下午茶)$/;

/** 字面相近的候选，只有它们才有资格被合并。 */
export function shortlistFor(text, fields = {}) {
  const blob = blobOf(text, fields);
  return candidatesForClustering()
    .map((wish) => ({ wish, score: bigramSimilarity(blob, wishBlob(wish)) }))
    .filter((x) => x.score >= SHORTLIST_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_MAX);
}


function mergeFields(oldFields = {}, newFields = {}) {
  const merged = { ...oldFields };
  for (const [key, value] of Object.entries(newFields ?? {})) {
    const v = String(value ?? "").trim();
    if (!v || /^(未知|未指定|无)$/.test(v)) continue;
    if (!merged[key] || /^(未知|未指定|无)$/.test(String(merged[key]))) merged[key] = v;
  }
  return merged;
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超时 ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const NAME_ONLY_SYSTEM =
  "你在给咖啡店的顾客许愿起名字。给愿望起一个 4-12 字的短名字，要像菜单上的商品名，" +
  "保留用户原话里的关键特征（主风味、基底、温度等），不要用'某味饮品''特色咖啡'这类空话。" +
  '只输出 JSON，格式：{"name": "短名字"}';

function describeFields(fields = {}) {
  return Object.entries(fields ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
}

// 让模型做两件事：① 在这条愿望的"字面相近候选"里判断是不是同一杯；② 给新愿望起个短名。
// 一次调用干完，因为这条路径在用户提交后是要立刻回卡片的，多一次往返就是多等好几秒。
// 关键约束：没有相近候选时，模型无权合并——这一步是代码保证的，不依赖模型自觉。
async function decideCluster({ text, fields }) {
  const shortlist = shortlistFor(text, fields);
  if (shortlist.length === 0) {
    const named = await withTimeout(
      chatJson({
        system: NAME_ONLY_SYSTEM,
        user: `愿望原话：${text}\n结构化信息：${describeFields(fields) || "（无）"}`,
        maxTokens: 200,
      }),
      CLUSTER_TIMEOUT_MS
    ).catch((err) => {
      console.error("[许愿池] 起名失败，先用原话兜底:", err.message);
      return null;
    });
    return { mergeId: null, name: typeof named?.name === "string" ? named.name.trim().slice(0, 20) : "" };
  }

  const described = shortlist
    .map(({ wish }, i) => {
      const quotes = (wish.quotes ?? []).slice(0, 3).map((q) => q.text).join(" / ");
      return `${i}. ${wish.name}（原话：${quotes || "无"}｜${describeFields(wish.fields) || "无结构化信息"}）`;
    })
    .join("\n");

  const result = await withTimeout(
    chatJson({
      system:
        "你在维护一个咖啡店的顾客许愿池，任务是把新愿望和候选愿望做去重。" +
        "最重要的规则：**主风味不一样就一定是两条不同的愿望**，哪怕基底、温度、甜度都一样。" +
        "主风味指那个让人一眼记住它的味道（黑芝麻、烤地瓜、葡萄、西瓜、生椰、火龙果……）。" +
        "参考判例：" +
        "①'黑芝麻糊味道的热奶茶'和'烤地瓜味道的热拿铁'——都是热饮、都有奶，但主风味不同，算两条；" +
        "②'不加糖的冰爽果香咖啡'和'果香清亮、冰、不加糖'——同一杯，可以合并；" +
        "③'想喝生椰拿铁'和'低糖葡萄气泡冰咖'——完全不同，算两条。" +
        "只是风格相近但主风味或温度对不上，一律新建——合并错了会让用户觉得你根本没听懂他，比不合并严重得多。" +
        "给出的候选里没有同一杯时，merge_index 必须是 null。" +
        "决定合并时，必须同时给出 shared_flavor：那个让两杯成为同一杯的具体主风味词，" +
        "而且这个词必须在新愿望原话和候选原话里都原样出现过（不能是'热''奶香''拿铁'这类什么咖啡都沾边的词）。" +
        "拿不出这样的词，就说明它们不是同一杯，merge_index 用 null。" +
        "另外给新愿望起一个 4-12 字的短名字，要像菜单上的商品名，保留用户原话里的关键特征，" +
        "不要用'某味饮品''特色咖啡'这类空话。" +
        '只输出 JSON，格式：{"merge_index": 数字或null, "shared_flavor": "共同主风味或空字符串", "name": "短名字"}',
      user: `候选愿望：\n${described}\n\n新愿望原话：${text}\n新愿望结构化信息：${describeFields(fields) || "（无）"}`,
      maxTokens: 300,
    }),
    CLUSTER_TIMEOUT_MS
  );

  const rawIndex = result?.merge_index;
  const index = Number.isInteger(rawIndex) ? rawIndex : Number.isInteger(Number(rawIndex)) ? Number(rawIndex) : null;
  const valid = index !== null && index >= 0 && index < shortlist.length ? index : null;
  let mergeId = valid === null ? null : shortlist[valid].wish.id;

  // 不能只信模型说"这两个是同一杯"——要求它把共同主风味举出来，并在两边原文里核对。
  // 核不上就当新愿望：多一个重复条目的代价，远小于把用户的愿望并进一个不相干的名字里。
  if (mergeId) {
    const shared = String(result?.shared_flavor ?? "").trim();
    const newBlob = blobOf(text, fields);
    const oldBlob = wishBlob(shortlist[valid].wish);
    const verifiable = shared.length >= 2 && !GENERIC_FLAVOR.test(shared) && newBlob.includes(shared) && oldBlob.includes(shared);
    if (!verifiable) {
      console.warn(`[许愿池] 模型想合并但拿不出可核对的共同主风味（shared_flavor="${shared}"），按新愿望处理`);
      mergeId = null;
    }
  }

  return { mergeId, name: typeof result?.name === "string" ? result.name.trim().slice(0, 20) : "" };
}

/**
 * 记一个愿望：先尝试挂靠到已有愿望上，挂不上就新建一条。
 * 返回 { wish, merged }，调用方拿它去渲染卡片。
 */
export async function recordWish({ userId, userName, text, fields = {}, gapReason = "", anonymous = false, chatId = null }) {
  const clean = String(text ?? "").trim();
  if (!clean) return null;

  // 老流水账继续写，保留最原始的输入痕迹（出问题时能回溯"用户到底说了什么"）。
  appendWish({ feishuUserId: userId, rawUserWords: [clean], collected: fields, gapReason });

  let decision = { mergeId: null, name: "" };
  try {
    decision = await decideCluster({ text: clean, fields });
  } catch (err) {
    console.error("[许愿池] 聚类失败，按新愿望入库:", err.message);
  }

  const s = loadStore();
  const now = new Date().toISOString();
  const quote = { userId, userName: userName ?? null, text: clean, anonymous: anonymous === true, at: now };

  const target = decision.mergeId ? s.wishes.find((w) => w.id === decision.mergeId) : null;
  if (target) {
    const duplicated = (target.quotes ?? []).some((q) => q.userId === userId && q.text === clean);
    if (!duplicated) target.quotes.push(quote);
    target.fields = mergeFields(target.fields, fields);
    if (!target.votes.includes(userId)) target.votes.push(userId);
    target.updatedAt = now;
    target.lastQuoteAt = now;
    if (!target.chatId && chatId) target.chatId = chatId;
    saveStore();
    return { wish: target, merged: true };
  }

  const wish = {
    id: `wish_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: decision.name || fallbackName(clean),
    quotes: [quote],
    fields,
    votes: [userId], // 许愿的人自己当然算一个"想要"，不然新愿望一上榜就是 0 人，看着很心酸
    status: "pooled",
    chatId,
    createdAt: now,
    updatedAt: now,
    lastQuoteAt: now,
  };
  s.wishes.push(wish);
  saveStore();
  return { wish, merged: false };
}

/** 投票是 toggle：再点一次就是取消，避免"手滑点错了撤不掉"。 */
export function toggleVote(wishId, userId) {
  const wish = getWish(wishId);
  if (!wish) return null;
  wish.votes ??= [];
  const index = wish.votes.indexOf(userId);
  // 作者那一票是"许愿本身自带的"，不能被自己点掉。
  // 线上实测：作者好奇点了一下自己那张卡上的 +1，愿望直接从 2 人掉到 0 人、沉到榜单底部，
  // 而他其实什么都没想撤销。这一票对他不可撤销，避免误伤。
  const isAuthor = (wish.quotes ?? []).some((q) => q.userId === userId);
  if (index >= 0 && isAuthor) return { wish, voted: true, unchanged: true };
  if (index >= 0) wish.votes.splice(index, 1);
  else wish.votes.push(userId);
  wish.updatedAt = new Date().toISOString();
  saveStore();
  return { wish, voted: index < 0 };
}

export function setWishStatus(wishId, status, note = "") {
  if (!WISH_STATUS[status]) throw new Error(`未知状态: ${status}`);
  const wish = getWish(wishId);
  if (!wish) return null;
  const previous = wish.status;
  wish.status = status;
  wish.statusNote = note;
  wish.statusUpdatedAt = new Date().toISOString();
  saveStore();
  return { wish, previous };
}

/** 人工清掉一条不该在池子里的愿望（比如误记的、或提的人已经离职）。 */
export function persistWishes() {
  saveStore();
}

export function removeWish(wishId) {
  const s = loadStore();
  const index = s.wishes.findIndex((w) => w.id === wishId);
  if (index < 0) return null;
  const [removed] = s.wishes.splice(index, 1);
  saveStore();
  return removed;
}
