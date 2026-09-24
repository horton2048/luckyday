// 下午茶定时器：每天到点自动发起，到点自动截止。
//
// 和 scheduler.js（预约下单）分开写，是因为两者节奏不一样：
// 预约单要精确到分钟地执行，拼单只需要"到点开一局、到点收一局"，30 秒一轮足够。

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startParty, listOpenParties, closeParty, hasPartyToday, PARTY_DEFAULTS } from "./party.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "../data/afternoon-tea.json");
const POLL_INTERVAL_MS = 30_000;
const FIRE_WINDOW_MINUTES = 5; // 超过这个窗口就不补发，避免服务重启后下午六点突然冒出一局

export function loadAfternoonTeaConfig() {
  const fallback = {
    enabled: false,
    time: "17:00",
    durationMinutes: 20,
    weekdaysOnly: true,
    chats: [],
    payerOpenId: PARTY_DEFAULTS.payerOpenId,
  };
  if (!existsSync(CONFIG_PATH)) return fallback;
  try {
    return { ...fallback, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
  } catch (err) {
    console.error("下午茶配置解析失败，按未启用处理:", err.message);
    return fallback;
  }
}

function shanghaiNow() {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return { hour: Number(get("hour")), minute: Number(get("minute")), weekday: get("weekday") };
}

function minutesOfDay({ hour, minute }) {
  return hour * 60 + minute;
}

function parseHHMM(value) {
  const [h, m] = String(value).split(":").map(Number);
  return (Number.isFinite(h) ? h : 17) * 60 + (Number.isFinite(m) ? m : 0);
}

async function tick() {
  const config = loadAfternoonTeaConfig();

  // 先收：到点的拼单先截止，避免"该截止的还没截止，新的又发出去"
  for (const party of listOpenParties()) {
    if (Date.now() >= party.deadline) {
      await closeParty(party.id).catch((err) => console.error("[拼单自动截止失败]", party.id, err));
    }
  }

  if (!config.enabled) return;

  const now = shanghaiNow();
  if (config.weekdaysOnly && ["周六", "周日"].includes(now.weekday)) return;

  const target = parseHHMM(config.time);
  const current = minutesOfDay(now);
  if (current < target || current > target + FIRE_WINDOW_MINUTES) return;

  for (const chat of config.chats ?? []) {
    if (hasPartyToday(chat.chatId)) continue;
    await startParty({
      chatId: chat.chatId,
      initiatorId: null,
      durationMinutes: config.durationMinutes,
      payerOpenId: config.payerOpenId,
    }).catch((err) => console.error("[拼单自动发起失败]", chat.chatId, err));
  }
}

export function startAfternoonTeaScheduler() {
  setInterval(() => {
    tick().catch((err) => console.error("[下午茶定时器异常]", err));
  }, POLL_INTERVAL_MS);
  const config = loadAfternoonTeaConfig();
  console.log(
    `下午茶定时器已启动：${config.enabled ? `${config.time} 自动发起（${(config.chats ?? []).length} 个群）` : "未启用"}，每 ${POLL_INTERVAL_MS / 1000}s 检查一次`
  );
}
