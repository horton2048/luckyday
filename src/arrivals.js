// 到岗识别：把"他今天到公司了吗、几点到的"变成一个可以查询的是非题。
//
// 三个必须记住的事实（都是实测 + 查官方文档确认过的，别再凭印象改）：
// 1. 飞书没有"随时读某个员工位置"的接口。位置只在两个地方出现：
//    ① 打卡流水——飞书打卡时自动记下地点名 + WiFi 的 SSID/MAC（全自动，但要只读权限）
//    ② 用户主动发的位置消息——有经纬度，但要人手动发
// 2. 打卡流水里【没有经纬度】，只有 location_name、ssid、bssid。
//    好在公司 WiFi 的 MAC（bssid）是固定的，命中它 = 人在公司，比 GPS 半径更准也更省事。
// 3. 我们只读，不写、不改、不做考勤统计、不把到岗数据汇报给任何人（包括老板）。
//
// 名称上刻意避开"考勤/签到"两个字：这个功能不碰考勤，只借位置。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getChatMembers, getUserEmployeeId, getTenantAccessToken, feishuFetch } from "./feishu.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "../data");
const OFFICE_PATH = join(DATA_DIR, "office.json");
const ARRIVALS_PATH = join(DATA_DIR, "arrivals.jsonl");
const PREFS_PATH = join(DATA_DIR, "reco-prefs.json");
const EMPLOYEE_MAP_PATH = join(DATA_DIR, "employee-map.json");
const CANDIDATES_PATH = join(DATA_DIR, "office-candidates.json");

// 打卡接口只认 employee_id / employee_no，不认 open_id（官方文档明确列出的可选值只有这两个），
// 所以必须先把 open_id 映射成 employee_id。缺的就是这两个权限。
export const SCOPE_APPLY_URL = () =>
  `https://open.feishu.cn/app/${process.env.FEISHU_APP_ID}/auth?q=attendance:task:readonly,contact:user.employee_id:readonly&op_from=openapi&token_type=tenant`;

const DEFAULT_CHATS = [
  "oc_49154fa588f4d2b88f0efd62eaeee245", // 测试群 luckyday
  "oc_3a24e746e8d8115b9e1f83fa66c30d39", // 大群 @老板，今天瑞吗
];

const OFFICE_DEFAULTS = {
  enabled: true,
  chats: DEFAULT_CHATS,
  // 按"打卡时间"判定算不算早上到岗；窗口外的打卡不触发也不补推
  windowFrom: "07:00",
  windowTo: "11:30",
  // 到岗后延迟多久推卡；超过 staleMinutes 就放弃，避免服务重启后下午突然冒出早上的卡
  delayMinutes: 5,
  staleMinutes: 30,
  // 命中任意一条就算"在公司"。三条都是一次性配置：
  //   wifiBssids —— 公司 WiFi 的 MAC 地址（最准，首选）
  //   wifiSsids  —— 公司 WiFi 名字
  //   locationKeywords —— 打卡地点名里包含的关键词（比如"XX大厦"）
  wifiBssids: [],
  wifiSsids: [],
  locationKeywords: [],
  // 轮询时段：只在这段时间调接口，其余时间一次都不调
  pollFrom: "06:30",
  pollTo: "12:00",
  // 位置消息兜底：飞书里用户主动发位置也能当到岗信号，但字段结构要先打真实日志确认
  acceptLocationMessage: false,
};

const PREFS_DEFAULTS = { enabled: true, consecutiveDeclines: 0, skipUntil: 0, lastSentDate: null };

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`[到岗] ${path} 解析失败，按默认值处理:`, err.message);
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

export function loadOfficeConfig() {
  return { ...OFFICE_DEFAULTS, ...readJson(OFFICE_PATH, {}) };
}

export function saveOfficeConfig(patch) {
  const next = { ...loadOfficeConfig(), ...patch };
  writeJson(OFFICE_PATH, next);
  return next;
}

// ==== 时间：全部按上海时区算。服务器在 UTC，直接 new Date().getHours() 会差 8 小时。 ====
export function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export function dateKey(date = new Date()) {
  return shanghaiParts(date).day;
}

function parseHHMM(value, fallback) {
  const [h, m] = String(value ?? "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback;
  return h * 60 + m;
}

// 今天 00:00（上海）对应的秒级时间戳
function shanghaiDayStartSec(date = new Date()) {
  const { day } = shanghaiParts(date);
  return Math.floor(new Date(`${day}T00:00:00+08:00`).getTime() / 1000);
}

export function formatClock(ms) {
  return new Date(ms).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

// ==== 公司地点判定 ====
export function officeMatch(flow, config) {
  if (flow.is_field) return null; // 外勤打卡 = 人不在公司
  const bssid = String(flow.bssid ?? "").toLowerCase();
  const white = (config.wifiBssids ?? []).map((b) => String(b).toLowerCase()).filter(Boolean);
  if (bssid && white.includes(bssid)) return { via: "wifi", detail: flow.ssid || bssid };
  if (flow.ssid && (config.wifiSsids ?? []).includes(flow.ssid)) return { via: "wifi", detail: flow.ssid };
  const place = String(flow.location_name ?? "");
  const hit = (config.locationKeywords ?? []).find((k) => k && place.includes(k));
  if (hit) return { via: "place", detail: place };
  return null;
}

// ==== 到岗记录（追加日志，只增不改；推送状态放 prefs） ====
export function listArrivals(day = dateKey()) {
  if (!existsSync(ARRIVALS_PATH)) return [];
  return readFileSync(ARRIVALS_PATH, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.date === day);
}

export function getArrival(userId, day = dateKey()) {
  return listArrivals(day).find((a) => a.userId === userId) ?? null;
}

// 只认当天第一次。中午出去吃饭回来再打卡、下班打卡，都不算"早上到岗"。
export function recordArrival({ userId, name = null, at = Date.now(), via, place = "", source = "attendance", chatId = null }) {
  const day = dateKey(new Date(at));
  if (getArrival(userId, day)) return null;
  const record = { userId, name, date: day, at, via, place, source, chatId };
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(ARRIVALS_PATH, JSON.stringify(record) + "\n", "utf8");
  console.log(`[到岗] ${name ?? userId} ${formatClock(at)} 到公司（${via}${place ? ` · ${place}` : ""} · ${source}）`);
  return record;
}

// ==== 推送开关与频控 ====
export function loadPrefs() {
  return readJson(PREFS_PATH, {});
}

export function getPref(userId) {
  return { ...PREFS_DEFAULTS, ...(loadPrefs()[userId] ?? {}) };
}

export function patchPref(userId, patch) {
  const all = loadPrefs();
  all[userId] = { ...PREFS_DEFAULTS, ...(all[userId] ?? {}), ...patch };
  writeJson(PREFS_PATH, all);
  return all[userId];
}

export function optOut(userId) {
  return patchPref(userId, { enabled: false });
}

export function optIn(userId) {
  return patchPref(userId, { enabled: true, consecutiveDeclines: 0, skipUntil: 0 });
}

export function markSent(userId, day = dateKey()) {
  return patchPref(userId, { lastSentDate: day });
}

// 连续 3 次"今天不喝"→ 隔两天再推；连续 5 次 → 直接停，等他自己叫。
export function markDeclined(userId) {
  const pref = getPref(userId);
  const consecutiveDeclines = (pref.consecutiveDeclines ?? 0) + 1;
  const patch = { consecutiveDeclines };
  if (consecutiveDeclines >= 5) {
    Object.assign(patch, { enabled: false });
  } else if (consecutiveDeclines >= 3) {
    Object.assign(patch, { skipUntil: Date.now() + 48 * 3600 * 1000 });
  }
  return patchPref(userId, patch);
}

export function shouldPushToday(userId, day = dateKey()) {
  const pref = getPref(userId);
  if (!pref.enabled) return { ok: false, reason: "已关闭推送" };
  if (pref.lastSentDate === day) return { ok: false, reason: "今天已经推过了" };
  if (pref.skipUntil && Date.now() < pref.skipUntil) return { ok: false, reason: "刚拒绝过，降频中" };
  return { ok: true };
}

// ==== open_id -> employee_id 映射（打卡接口只认后者） ====
export function loadEmployeeMap() {
  return readJson(EMPLOYEE_MAP_PATH, { updatedAt: 0, map: {}, names: {} });
}

const MAP_TTL_MS = 12 * 3600 * 1000;
let mapRefreshing = null;

async function refreshEmployeeMap(config) {
  const openIds = new Set();
  const names = {};
  for (const chatId of config.chats ?? []) {
    const members = await getChatMembers(chatId).catch((err) => {
      console.error(`[到岗] 拉群成员失败 chat=${chatId}`, err.message);
      return [];
    });
    for (const m of members) {
      if (!String(m.member_id ?? "").startsWith("ou_")) continue;
      openIds.add(m.member_id);
      names[m.member_id] = m.name;
    }
  }

  const map = {};
  for (const openId of openIds) {
    const employeeId = await getUserEmployeeId(openId).catch(() => null);
    if (employeeId) map[openId] = employeeId;
  }

  const result = { updatedAt: Date.now(), map, names };
  writeJson(EMPLOYEE_MAP_PATH, result);
  const missing = openIds.size - Object.keys(map).length;
  console.log(
    `[到岗] 员工映射已刷新：${Object.keys(map).length}/${openIds.size} 人拿到 employee_id` +
      (missing > 0 ? `（${missing} 人没拿到，多半是缺 contact:user.employee_id:readonly 权限）` : "")
  );
  return result;
}

let scopeWarned = false;

async function ensureEmployeeMap(config) {
  const cached = loadEmployeeMap();
  if (cached.updatedAt && Date.now() - cached.updatedAt < MAP_TTL_MS) return cached;
  if (mapRefreshing) return mapRefreshing;
  mapRefreshing = refreshEmployeeMap(config)
    .catch((err) => {
      if (!scopeWarned) {
        scopeWarned = true;
        console.error(
          `[到岗] 拿不到员工映射，主业（读打卡）会一直空转。需要管理员开通两个只读权限：\n${SCOPE_APPLY_URL()}\n原因：${err.message}`
        );
      }
      return { ...cached, updatedAt: Date.now() };
    })
    .finally(() => {
      mapRefreshing = null;
    });
  return mapRefreshing;
}

// ==== 打卡流水 ====
// 注意：官方文档里 employee_type 的可选值只有 employee_id / employee_no，没有 open_id。
export async function queryUserFlows(employeeIds, fromSec, toSec) {
  const token = await getTenantAccessToken();
  const res = await feishuFetch(
    "https://open.feishu.cn/open-apis/attendance/v1/user_flows/query?employee_type=employee_id&include_terminated_user=false",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        user_ids: employeeIds.slice(0, 50),
        check_time_from: String(fromSec),
        check_time_to: String(toSec),
      }),
    }
  );
  const data = await res.json();
  if (data.code !== 0) {
    const err = new Error(`查询打卡流水失败: ${data.msg ?? JSON.stringify(data)}`);
    err.feishuCode = data.code;
    throw err;
  }
  return data.data?.user_flow_results ?? [];
}

// ==== 地点候选学习 ====
// 权限刚批下来时谁也不知道公司的打卡地点名和 WiFi MAC 长什么样。这里把见过的都按频次记下来，
// 用 /admin/office/candidates 看一眼就能定配置，不用猜。
export function recordCandidates(flows) {
  if (!flows?.length) return;
  const store = readJson(CANDIDATES_PATH, { places: {}, ssids: {}, bssids: {} });
  store.ssids = store.ssids ?? {};
  for (const flow of flows) {
    if (flow.location_name) {
      const key = flow.location_name;
      store.places[key] = store.places[key] ?? { count: 0, field: Boolean(flow.is_field), lastSeen: null };
      store.places[key].count += 1;
      store.places[key].lastSeen = new Date().toISOString();
    }
    if (flow.ssid) store.ssids[flow.ssid] = (store.ssids[flow.ssid] ?? 0) + 1;
    if (flow.bssid) {
      const key = String(flow.bssid).toLowerCase();
      store.bssids[key] = store.bssids[key] ?? { count: 0, ssid: flow.ssid ?? null };
      store.bssids[key].count += 1;
    }
  }
  writeJson(CANDIDATES_PATH, store);
}

export function loadCandidates() {
  return readJson(CANDIDATES_PATH, { places: {}, ssids: {}, bssids: {} });
}

// ==== 轮询 ====
const POLL_INTERVAL_MS = 60_000;
// 推卡最多试两次：一次失败多半是网络抖动，两次都失败就别再骚扰了。
const MAX_PUSH_ATTEMPTS = 2;
const pushAttempts = new Map();

function inWindow(atMs, config) {
  const { minutes } = shanghaiParts(new Date(atMs));
  return (
    minutes >= parseHHMM(config.windowFrom, 7 * 60) && minutes <= parseHHMM(config.windowTo, 11 * 60 + 30)
  );
}

async function tick(onArrived, { force = false } = {}) {
  const config = loadOfficeConfig();
  if (!config.enabled) return;

  const now = new Date();
  const { minutes } = shanghaiParts(now);
  // force 只给管理/调试用：跳过"轮询时段"限制，但到岗时间窗照旧生效
  if (!force && (minutes < parseHHMM(config.pollFrom, 6 * 60 + 30) || minutes > parseHHMM(config.pollTo, 12 * 60))) return;

  const { map, names } = await ensureEmployeeMap(config);
  const entries = Object.entries(map);
  if (entries.length === 0) return;

  const day = dateKey(now);
  const flows = await queryUserFlows(
    entries.map(([, employeeId]) => employeeId),
    shanghaiDayStartSec(now),
    Math.floor(now.getTime() / 1000) + 1
  );
  recordCandidates(flows);

  const openIdByEmployee = new Map(entries.map(([openId, employeeId]) => [employeeId, openId]));
  for (const flow of flows) {
    const at = Number(flow.check_time) * 1000;
    if (!Number.isFinite(at) || !inWindow(at, config)) continue;
    const match = officeMatch(flow, config);
    if (!match) continue;
    const userId = openIdByEmployee.get(flow.user_id);
    if (!userId) continue;
    recordArrival({ userId, name: names[userId] ?? null, at, via: match.via, place: match.detail, source: "attendance" });
  }

  for (const arrival of listArrivals(day)) {
    const gap = Date.now() - arrival.at;
    if (gap < config.delayMinutes * 60_000) continue;
    if (gap > config.staleMinutes * 60_000) continue; // 过期不补推
    const gate = shouldPushToday(arrival.userId, day);
    if (!gate.ok) continue;
    const key = `${day}:${arrival.userId}`;
    const attempts = pushAttempts.get(key) ?? 0;
    if (attempts >= MAX_PUSH_ATTEMPTS) continue;
    pushAttempts.set(key, attempts + 1);
    try {
      // "今天已经推过"由 onArrived 自己标记：私聊里手动说"我到公司了"那条路也要算数，
      // 否则自动轮询过了一会儿又推一张，同一天两张卡。
      await onArrived(arrival);
    } catch (err) {
      console.error(`[到岗] 推卡失败 userId=${arrival.userId} 第 ${attempts + 1} 次`, err);
    }
  }
}

export function startArrivalWatcher({ onArrived }) {
  setInterval(() => {
    tick(onArrived).catch((err) => console.error("[到岗] 轮询异常", err));
  }, POLL_INTERVAL_MS);
  const config = loadOfficeConfig();
  console.log(
    `到岗轮询已启动：${config.enabled ? `${config.pollFrom}-${config.pollTo} 每分钟一次，到岗 ${config.delayMinutes} 分钟后推卡` : "未启用"}` +
      `（公司地点已配置 ${(config.wifiBssids ?? []).length} 个 WiFi MAC / ${(config.locationKeywords ?? []).length} 个地点关键词）`
  );
}

// 给测试和管理用：立刻跑一次，不等定时器
export function runArrivalTickNow(onArrived, opts = {}) {
  return tick(onArrived, opts);
}

export { OFFICE_DEFAULTS };
