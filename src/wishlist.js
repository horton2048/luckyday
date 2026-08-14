import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WISHLIST_PATH = join(__dirname, "../data/wishlist.jsonl");

export function appendWish({ feishuUserId, rawUserWords, collected, gapReason }) {
  mkdirSync(dirname(WISHLIST_PATH), { recursive: true });
  const record = {
    id: `wish_${Date.now()}`,
    createdAt: new Date().toISOString(),
    feishuUserId,
    rawUserWords,
    collected,
    gapReason,
    status: "待聚类",
  };
  // JSON Lines：每行一条记录，追加写入不需要读全量文件再改写。
  appendFileSync(WISHLIST_PATH, JSON.stringify(record) + "\n", "utf8");
  return record;
}
