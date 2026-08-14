let cachedToken = null;
let cachedExpiry = 0;

export async function getTenantAccessToken() {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;

  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
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
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}`, {
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
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
  const res = await fetch(
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

// 支付二维码走"下载图片字节 → 上传到飞书图床拿 image_key → 发图片消息"，
// 不能直接把外部 URL 塞进消息（飞书图片消息只认自己图床的 image_key）。
export async function replyImageFromUrl(chatId, imageUrl) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`下载二维码图片失败: HTTP ${imgRes.status}`);
  const buffer = await imgRes.arrayBuffer();

  const token = await getTenantAccessToken();
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", new Blob([buffer]), "qrcode.png");

  const uploadRes = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const uploadData = await uploadRes.json();
  if (uploadData.code !== 0) {
    console.error("飞书图片上传失败:", uploadData);
    throw new Error(`飞书图片上传失败: ${JSON.stringify(uploadData)}`);
  }

  const sendRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "image",
      content: JSON.stringify({ image_key: uploadData.data.image_key }),
    }),
  });
  const sendData = await sendRes.json();
  if (sendData.code !== 0) console.error("飞书发图片消息失败:", sendData);
}
