// 定时预约下单：预约单落盘（进程重启不丢），每 30 秒扫一遍到期的，直接调 MCP createOrder。
// 到点后不再二次确认——这是设计时明确做出的取舍（对现有"下单前必须用户当场确认"安全边界的
// 一次让步），预约时的确认就是唯一一次人工确认。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpCallTool } from "./mcpClient.js";
import { replyText, replyImageFromUrl } from "./feishu.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, "../data/scheduled-orders.json");
const POLL_INTERVAL_MS = 30_000;

function loadAll() {
  if (!existsSync(STORE_PATH)) return [];
  return JSON.parse(readFileSync(STORE_PATH, "utf8"));
}

function saveAll(list) {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), "utf8");
}

export function addScheduledOrder(entry) {
  const list = loadAll();
  const record = {
    id: `sched_${Date.now()}`,
    status: "pending",
    createdAt: new Date().toISOString(),
    ...entry,
  };
  list.push(record);
  saveAll(list);
  return record;
}

export function listScheduledOrders() {
  return loadAll();
}

async function runDueOrders(mcpUrl, mcpToken) {
  const list = loadAll();
  const now = Date.now();
  let dirty = false;

  for (const item of list) {
    if (item.status !== "pending") continue;
    if (new Date(item.executeAt).getTime() > now) continue;

    dirty = true;
    try {
      const result = await mcpCallTool(mcpUrl, mcpToken, "createOrder", {
        deptId: item.deptId,
        productList: item.productList,
        longitude: item.longitude,
        latitude: item.latitude,
        ...(item.couponCodeList ? { couponCodeList: item.couponCodeList } : {}),
      });
      item.status = "done";
      item.result = result;
      await replyText(item.chatId, `预约到点了，已经帮你下单：${item.summary}。扫下面二维码支付～`);
      if (result?.data?.payOrderQrCodeUrl) {
        await replyImageFromUrl(item.chatId, result.data.payOrderQrCodeUrl).catch((err) =>
          console.error("预约单发二维码失败:", err)
        );
      }
    } catch (err) {
      item.status = "failed";
      item.error = String(err);
      console.error(`[预约单执行失败] id=${item.id}`, err);
      await replyText(item.chatId, `预约的"${item.summary}"到点了，但下单失败了，麻烦手动下一单。`).catch(() => {});
    }
  }

  if (dirty) saveAll(list);
}

export function startScheduler(mcpUrl, mcpToken) {
  setInterval(() => {
    runDueOrders(mcpUrl, mcpToken).catch((err) => console.error("[预约单轮询异常]", err));
  }, POLL_INTERVAL_MS);
  console.log(`预约下单调度器已启动，每 ${POLL_INTERVAL_MS / 1000}s 检查一次`);
}
