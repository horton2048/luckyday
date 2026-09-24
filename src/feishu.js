// 所有外发请求都必须带超时。
// 真实踩过的坑：有一次给飞书发消息的请求挂住不返回，既没成功也没报错，而每个用户的消息是串行处理的，
// 结果这个人之后发的每一条消息都被静默堵在队列里——机器人"突然不理我了"，日志里却什么都没有。
import { taskSignal } from './taskContext.js';
import { createHash } from 'node:crypto';
// Idempotency keys must distinguish cards and update operations, not just sequence numbers.
const updateId = (cardId, operation, sequence) => createHash('sha256').update(`${cardId}:${operation}:${sequence}`).digest('hex');
const FEISHU_TIMEOUT_MS = 15_000;

export function feishuFetch(url, init = {}, timeoutMs = FEISHU_TIMEOUT_MS) {
  return fetch(url, { ...init, signal: taskSignal(timeoutMs) });
}

let cachedToken = null;
let cachedExpiry = 0;

export async function getTenantAccessToken() {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;

  const res = await feishuFetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取 tenant_access_token 失败: ${JSON.stringify(data)}`);

  cachedToken = data.tenant_access_token;
  cachedExpiry = Date.now() + (data.expire - 60) * 1000;
  return cachedToken;
}

export async function getChatInfo(chatId) {
  const token = await getTenantAccessToken();
  const res = await feishuFetch(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`获取群信息失败: ${JSON.stringify(data)}`);
  return data.data; // 含 name / owner_id / description 等
}

export async function getChatMembers(chatId) {
  const token = await getTenantAccessToken();
  let members = [];
  let pageToken = "";
  do {
    const url = new URL(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}/members`);
    url.searchParams.set("member_id_type", "open_id");
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const res = await feishuFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`获取群成员失败: ${JSON.stringify(data)}`);
    members = members.concat(data.data.items ?? []);
    pageToken = data.data.has_more ? data.data.page_token : "";
  } while (pageToken);
  return members;
}

// open_id -> 姓名，按群缓存，避免每条消息都拉一次全量成员列表。
const memberNameCache = new Map();

export async function resolveUserName(chatId, userId) {
  let cache = memberNameCache.get(chatId);
  if (!cache || !cache.has(userId)) {
    const members = await getChatMembers(chatId);
    cache = new Map(members.map((m) => [m.member_id, m.name]));
    memberNameCache.set(chatId, cache);
  }
  return cache.get(userId) ?? userId;
}

export async function replyText(chatId, text) {
  const token = await getTenantAccessToken();
  const res = await feishuFetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    }
  );
  const data = await res.json();
  if (data.code !== 0) console.error("飞书发消息失败:", data);
}

export async function replyCard(chatId, card) {
  const token = await getTenantAccessToken();
  const res = await feishuFetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书发卡片失败: ${JSON.stringify(data)}`);
  return data.data;
}

// ==== 卡片实体：拼单卡需要"发出去之后还能改"，所以走 cardkit 实体而不是普通卡片消息 ====
// 限制：一个实体只能发送一次，实体有效期 14 天，且调用方必须和创建方是同一个应用身份。
// 另外卡片 JSON 里必须 update_multi != false（默认就是 true），否则更新接口会拒绝。

async function cardkit(path, init = {}) {
  const token = await getTenantAccessToken();
  const res = await feishuFetch(`https://open.feishu.cn/open-apis/cardkit/v1/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书卡片实体接口失败(${path}): ${JSON.stringify(data)}`);
  return data.data ?? {};
}

export async function createCardEntity(card) {
  const data = await cardkit("cards", {
    method: "POST",
    body: JSON.stringify({ type: "card_json", data: JSON.stringify(card) }),
  });
  return data.card_id;
}

// 私聊发消息：群 id 发不进去，只能按 open_id 发（拼单结束给每个人的回执用这个）。
export async function replyTextToUser(openId, text) {
  const token = await getTenantAccessToken();
  const res = await feishuFetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) }),
  });
  const data = await res.json();
  if (data.code !== 0) console.error("飞书私聊发消息失败:", data);
}

// 私聊发卡片实体：到岗推荐卡是发给个人的，不能落到群里
export async function sendCardEntityToUser(openId, cardId) {
  const token = await getTenantAccessToken();
  const res = await feishuFetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: openId, msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }) }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书私聊发卡片实体失败: ${JSON.stringify(data)}`);
  return data.data;
}

// 私聊发普通卡片（支付卡这类不需要后续修改的用这个）
export async function replyCardToUser(openId, card) {
  const token = await getTenantAccessToken();
  const res = await feishuFetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: openId, msg_type: "interactive", content: JSON.stringify(card) }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书私聊发卡片失败: ${JSON.stringify(data)}`);
  return data.data;
}

// open_id -> 企业内的 user_id。飞书打卡接口只认 employee_id/employee_no，不认 open_id，所以必须先翻这一道。
// 需要权限：获取用户 user ID（contact:user.employee_id:readonly）。没权限时这个字段会静默不返回。
export async function getUserEmployeeId(openId) {
  const token = await getTenantAccessToken();
  const res = await feishuFetch(
    `https://open.feishu.cn/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`查用户 ${openId} 失败: ${data.msg ?? JSON.stringify(data)}`);
  return data.data?.user?.user_id ?? null;
}

export async function sendCardEntity(chatId, cardId) {
  const token = await getTenantAccessToken();
  const res = await feishuFetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }) }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书发送卡片实体失败: ${JSON.stringify(data)}`);
  return data.data;
}

// 全量更新：整张卡替换（截止、状态变化这类大改动用）
export async function updateCardEntity(cardId, card, sequence) {
  return cardkit(`cards/${cardId}`, {
    method: "PUT",
    body: JSON.stringify({ card: { type: "card_json", data: JSON.stringify(card) }, uuid: updateId(cardId, 'card', sequence), sequence }),
  });
}

// 卡片实体的更新必须"排队"发出去。
// 真实踩到的坑：飞书要求每次 PUT 的 sequence 严格大于上一次，而并发发出去的请求到达顺序不保证——
// 用户连点几下「换一杯」，后发的先到，先发的就被拒（300317 sequence number compare failed），
// 表现就是"点了没反应 / 换不成功"。这里按卡片串成一条队列，保证顺序。
const cardUpdateQueues = new Map();

export function enqueueCardUpdate(cardKey, task) {
  const prev = cardUpdateQueues.get(cardKey) ?? Promise.resolve();
  const next = prev.then(task, task);
  // 队列自己吞掉失败，否则一次失败会把后面所有更新一起带崩
  cardUpdateQueues.set(cardKey, next.then(() => {}, () => {}));
  return next;
}

// 局部更新：只换掉某个组件。拼单名单刷新用这个——避免整卡重绘打断别人正在填的表单。
export async function updateCardElement(cardId, elementId, element, sequence) {
  return cardkit(`cards/${cardId}/elements/${elementId}`, {
    method: "PUT",
    body: JSON.stringify({ element: JSON.stringify(element), uuid: updateId(cardId, `element:${elementId}`, sequence), sequence }),
  });
}

// 支付二维码走"下载图片字节 → 上传到飞书图床拿 image_key → 发图片消息"，
// 不能直接把外部 URL 塞进消息（飞书图片消息只认自己图床的 image_key）。
export async function uploadImageFromUrl(imageUrl, { timeoutMs = 30_000, filename = 'qrcode.png' } = {}) {
  const imgRes = await feishuFetch(imageUrl, {}, timeoutMs);
  if (!imgRes.ok) throw new Error(`下载图片失败: HTTP ${imgRes.status}`);
  const buffer = await imgRes.arrayBuffer();

  const token = await getTenantAccessToken();
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", new Blob([buffer], { type: imgRes.headers?.get('content-type') || 'application/octet-stream' }), filename);

  const uploadRes = await feishuFetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  }, Math.min(timeoutMs, FEISHU_TIMEOUT_MS));
  const uploadData = await uploadRes.json();
  if (uploadData.code !== 0) {
    console.error("飞书图片上传失败:", uploadData);
    throw new Error(`飞书图片上传失败: ${JSON.stringify(uploadData)}`);
  }

  return uploadData.data.image_key;
}

export async function replyImageFromUrl(chatId, imageUrl) {
  const imageKey = await uploadImageFromUrl(imageUrl);
  const token = await getTenantAccessToken();
  const sendRes = await feishuFetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
    }),
  });
  const sendData = await sendRes.json();
  if (sendData.code !== 0) console.error("飞书发图片消息失败:", sendData);
}

// 卡片里的 img 组件对尺寸和图片来源有额外限制。支付二维码改发为普通图片消息，
// 这样卡片内容失败时不会吞掉二维码，也兼容手机端和桌面端。
export async function replyImageKey(chatId, imageKey) {
  if (!imageKey) throw new Error('支付二维码图片未上传成功');
  const token = await getTenantAccessToken();
  const sendRes = await feishuFetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: "image", content: JSON.stringify({ image_key: imageKey }) }),
  });
  const data = await sendRes.json();
  if (data.code !== 0) throw new Error(`飞书发二维码图片失败: ${JSON.stringify(data)}`);
  return data.data;
}
