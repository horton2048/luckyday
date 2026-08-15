// 口味记忆：来源是"对话里明确说过的偏好"（不管有没有真的下单），跟 tastes.js（下单成功后的
// 商品记录）是两回事——那个记的是"点过什么"，这个记的是"说过喜欢什么"，两者互补。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILES_PATH = join(__dirname, "../data/taste-profiles.json");

function loadAll() {
  if (!existsSync(PROFILES_PATH)) return {};
  return JSON.parse(readFileSync(PROFILES_PATH, "utf8"));
}

function saveAll(map) {
  mkdirSync(dirname(PROFILES_PATH), { recursive: true });
  writeFileSync(PROFILES_PATH, JSON.stringify(map, null, 2), "utf8");
}

export function recordTaste(feishuUserId, name, summary) {
  const all = loadAll();
  all[feishuUserId] = { name: name ?? all[feishuUserId]?.name ?? null, summary, updatedAt: new Date().toISOString() };
  saveAll(all);
  return all[feishuUserId];
}

export function getTaste(feishuUserId) {
  return loadAll()[feishuUserId] ?? null;
}
