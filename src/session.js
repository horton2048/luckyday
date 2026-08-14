// 内存会话存储：进程重启即丢失，够 MVP 用。生产化时换成 Redis。
const sessions = new Map();

function getState(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { history: [], mode: null, diyRound: 0, diySoFar: [] });
  }
  return sessions.get(userId);
}

export function getHistory(userId) {
  return getState(userId).history;
}

export function saveHistory(userId, history) {
  // 简单截断，避免上下文无限增长
  getState(userId).history = history.slice(-30);
}

export function getMode(userId) {
  return getState(userId).mode;
}

export function setMode(userId, mode) {
  const s = getState(userId);
  if (s.mode !== mode && mode === "diy") {
    s.diyRound = 0;
    s.diySoFar = [];
  }
  s.mode = mode;
}

export function getDiyRound(userId) {
  return getState(userId).diyRound;
}

export function incrDiyRound(userId) {
  getState(userId).diyRound += 1;
  return getState(userId).diyRound;
}

export function pushDiyWords(userId, text) {
  getState(userId).diySoFar.push(text);
}

export function getDiyWords(userId) {
  return getState(userId).diySoFar;
}

export function resetHistory(userId) {
  sessions.delete(userId);
}

// 同一用户的消息必须串行处理：并发的两轮对话会各自基于旧历史起跑，
// 互相看不到对方刚学到的信息（比如门店 ID），会导致重复/矛盾的工具调用。
const userQueues = new Map();

export function enqueueForUser(userId, task) {
  const prev = userQueues.get(userId) ?? Promise.resolve();
  const next = prev.then(task, task);
  userQueues.set(
    userId,
    next.catch(() => {})
  );
  return next;
}
