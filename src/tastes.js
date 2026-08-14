import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASTES_PATH = join(__dirname, "../data/tastes.jsonl");

export function appendOrder({ feishuUserId, userName, chatId, items }) {
  mkdirSync(dirname(TASTES_PATH), { recursive: true });
  const record = {
    id: `order_${Date.now()}`,
    createdAt: new Date().toISOString(),
    feishuUserId,
    userName,
    chatId,
    items,
  };
  appendFileSync(TASTES_PATH, JSON.stringify(record) + "\n", "utf8");
  return record;
}

export function getRecentOrders(feishuUserId, limit = 5) {
  if (!existsSync(TASTES_PATH)) return [];
  const lines = readFileSync(TASTES_PATH, "utf8").trim().split("\n").filter(Boolean);
  const records = lines.map((l) => JSON.parse(l)).filter((r) => r.feishuUserId === feishuUserId);
  return records.slice(-limit).reverse();
}
