// 定时预约下单：预约单落盘（进程重启不丢），每 30 秒扫一遍到期的，直接调 MCP createOrder。
// 到点后不再二次确认——这是设计时明确做出的取舍（对现有"下单前必须用户当场确认"安全边界的
// 一次让步），预约时的确认就是唯一一次人工确认。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpCallTool } from "./mcpClient.js";
import { replyCard, replyImageKey, uploadImageFromUrl } from "./feishu.js";
import { buildPaymentCard } from './cards.js';
import { randomUUID } from 'node:crypto';

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
    id: `sched_${randomUUID()}`,
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

export async function executeScheduled(item,{call,persist,onNeedsConfirmation,notify}) {
  const args={deptId:item.deptId,productList:item.productList};
  let creating=false;
  try {
    const preview=await call('previewOrder',args);
    const price=preview?.data?.discountPrice??preview?.data?.totalPrice??preview?.data?.price;
    if(preview?.success===false||preview?.code!==0||price==null||item.authorizedPrice==null||Number(price)!==Number(item.authorizedPrice)) {
      item.status='needs_confirmation';await persist(item);
      await onNeedsConfirmation(item,'预约到点了，价格或可售情况需要重新确认。');return;
    }
    if(Array.isArray(preview.data.couponCodeList))args.couponCodeList=preview.data.couponCodeList;
    item.status='processing';await persist(item);creating=true;
    const result=await call('createOrder',args);
    if(!result?.data?.payOrderQrCodeUrl)throw new Error('未取得支付二维码，需要核对订单结果');
    item.status='done';item.result=result;await persist(item);
    await notify(item,result);
  }catch(err){
    if(item.status==='done'){item.notificationError=String(err);await persist(item);return;}
    item.status=creating?'uncertain':'needs_confirmation';item.error=String(err);await persist(item);
    if(!creating)await onNeedsConfirmation(item,'预约报价暂时不可用，可在卡片中重新选择。');
    else console.error(`[预约订单结果待核对] ${item.id}`);
  }
}

export function startScheduler(mcpUrl, mcpToken, {onNeedsConfirmation} = {}) {
  let running=false;
  const persist=async item=>{const all=loadAll();const i=all.findIndex(x=>x.id===item.id);if(i>=0){all[i]=item;saveAll(all);}};
  setInterval(() => {
    if(running)return;running=true;
    void (async()=>{
      for(const item of loadAll()) {
        if(item.status!=='pending'||!Number.isFinite(new Date(item.executeAt).getTime())||new Date(item.executeAt).getTime()>Date.now())continue;
        await executeScheduled(item,{
          call:(name,args)=>mcpCallTool(mcpUrl,mcpToken,name,args),persist,
          onNeedsConfirmation:onNeedsConfirmation??(async()=>{}),
          notify:async(item,result)=>{const imageKey=await uploadImageFromUrl(result.data.payOrderQrCodeUrl);await replyCard(item.chatId,buildPaymentCard({order:{result},imageKey}));await replyImageKey(item.chatId,imageKey);},
        });
      }
    })().catch(err=>console.error('[预约轮询失败]',err.message)).finally(()=>{running=false;});
  }, POLL_INTERVAL_MS);
  console.log(`预约下单调度器已启动，每 ${POLL_INTERVAL_MS / 1000}s 检查一次`);
}
