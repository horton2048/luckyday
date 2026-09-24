import { taskContext, assertTaskActive } from './taskContext.js';
// 内存会话存储：进程重启即丢失，够 MVP 用。生产化时换成 Redis。
const sessions = new Map();
const pendingOrders = new Map();
export {getActiveShop,setActiveShop,clearActiveShop} from './storeContext.js';

export function invalidatePendingOrders(ownerId, chatId) {
  for (const previous of pendingOrders.values()) {
    if (previous.ownerId === ownerId && previous.chatId === chatId && previous.status === "pending") {
      previous.status = "superseded";
    }
  }
}

export function createPendingOrder(order) {
  invalidatePendingOrders(order.ownerId, order.chatId);
  const id = `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingOrders.set(id, { ...order, id, status: "pending", createdAt: Date.now() });
  return pendingOrders.get(id);
}

export function getPendingOrder(id) {
  const order = pendingOrders.get(id);
  if (!order || Date.now() - order.createdAt > 30 * 60 * 1000) {
    pendingOrders.delete(id);
    return null;
  }
  return order;
}

export function setPendingOrderStatus(id, status, result = null) {
  const order = getPendingOrder(id);
  if (!order) return null;
  order.status = status;
  if (result) order.result = result;
  return order;
}

function getState(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { history: [], mode: null });
  }
  return sessions.get(userId);
}

export function getHistory(userId) {
  return getState(userId).history;
}

export function saveHistory(userId, history) {
  assertTaskActive();
  getState(userId).history = cleanHistory(history);
}

// Keep complete assistant/tool batches, including when repairing existing broken history.
export function cleanHistory(history, limit = 30) {
  const groups = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message.role === 'tool') continue;
    if (!message.tool_calls?.length) { groups.push([message]); continue; }
    const results = [];
    while (history[i + 1]?.role === 'tool') results.push(history[++i]);
    const ids = new Set(message.tool_calls.map(c => c.id));
    if (ids.size === message.tool_calls.length && results.length === ids.size && results.every(r => ids.delete(r.tool_call_id)) && ids.size === 0) groups.push([message, ...results]);
    else if (message.content) groups.push([{ role: 'assistant', content: message.content }]);
  }
  const kept = []; let size = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (size + groups[i].length > limit) break;
    kept.unshift(...groups[i]); size += groups[i].length;
  }
  return kept;
}

export function getMode(userId) {
  return getState(userId).mode;
}

export function setMode(userId, mode) {
  getState(userId).mode = mode;
}

export function resetHistory(userId) {
  sessions.delete(userId);
}

// 同一用户的消息必须串行处理：并发的两轮对话会各自基于旧历史起跑，
// 互相看不到对方刚学到的信息（比如门店 ID），会导致重复/矛盾的工具调用。
const userQueues = new Map();

// Timeout cancels outbound work; the queue advances only once the old task unwinds.
const TASK_TIMEOUT_MS = 120_000;

export function enqueueForUser(userId, task) {
  const prev = userQueues.get(userId) ?? Promise.resolve();
  const run = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('消息处理超时，请点击重试')), TASK_TIMEOUT_MS);
    timer.unref?.();
    try { return await taskContext.run({ signal: controller.signal }, () => task(controller.signal)); }
    finally { clearTimeout(timer); }
  };
  const next = prev.then(run, run);
  const settled = next.then(() => {}, () => {});
  userQueues.set(userId, settled);
  void settled.then(() => { if (userQueues.get(userId) === settled) userQueues.delete(userId); });
  return next;
}
