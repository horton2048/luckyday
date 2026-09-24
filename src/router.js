import { taskSignal } from './taskContext.js';

// MiniMax 做语义判断，服务端只消费这组稳定的业务意图。
export const INTENTS = ['exclusive_recommendation', 'team_party', 'wish_pool', 'wish_submit', 'scheduled_order', 'direct_order', 'settings', 'chat'];

function stripJson(raw) {
  return String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

/**
 * 解析模型的结构化判断，并应用一条业务安全优先级：明确预约且不需要他人参与时，
 * 必须进入预约下单。这里不从用户原话猜关键词，只使用模型自己抽取的字段。
 */
export function parseClassificationResponse(raw) {
  const text = stripJson(raw);
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const lower = text.toLowerCase();
    for (const intent of INTENTS) if (lower.includes(intent)) return { intent, scheduled: false, collaborative: false, scheduledAt: null };
    if (lower === 'order' || lower === 'single_order') return { intent: 'direct_order', scheduled: false, collaborative: false, scheduledAt: null };
    if (lower === 'arrival_reco' || lower === 'recommendation_order') return { intent: 'exclusive_recommendation', scheduled: false, collaborative: false, scheduledAt: null };
    if (lower === 'wish') return { intent: 'wish_submit', scheduled: false, collaborative: false, scheduledAt: null };
    return { intent: 'chat', scheduled: false, collaborative: false, scheduledAt: null };
  }

  let intent = result?.intent;
  if (intent === 'arrival_reco' || intent === 'recommendation_order') intent = 'exclusive_recommendation';
  if (intent === 'single_order' || intent === 'order') intent = 'direct_order';
  if (!INTENTS.includes(intent)) intent = 'chat';
  const scheduled = result?.scheduled === true || result?.schedule?.requested === true;
  const collaborative = result?.collaborative === true || result?.collaboration?.required === true;
  if (scheduled && !collaborative) intent = 'scheduled_order';
  if (intent === 'team_party' && !collaborative) intent = scheduled ? 'scheduled_order' : 'direct_order';
  const request=result?.store_request;
  const storeRequest=request && ['nearby','named','selection'].includes(request.kind) && typeof request.query==='string'
    ? {kind:request.kind,query:request.query.trim().slice(0,100),city:typeof request.city==='string'?request.city:'',continuation:typeof request.continuation==='string'?request.continuation:''} : null;
  return { intent, scheduled, collaborative, scheduledAt: result?.scheduled_at ?? result?.scheduledAt ?? null, storeRequest };
}

// 兼容旧测试和其他调用方的名称。
export function parseIntentResponse(raw) { return parseClassificationResponse(raw).intent; }
export const parseIntent = parseIntentResponse;

export async function classifyIntent({ userText, currentMode }) {
  const prompt = `你是 LuckyDay 的交易流程路由器。请理解整句话后输出 JSON，不要输出解释：{"intent":"...","scheduled":true/false,"collaborative":true/false,"scheduled_at":"YYYY-MM-DD HH:mm"或null}。

intent 只能是：
- exclusive_recommendation：用户表达模糊饮品需求、想让 LuckyDay 推荐，或明确说已经到公司/到岗；基于新品和用户记忆进入专属推荐卡。
- team_party：需要一个群体共同参与点单，例如发起拼单、让大家各自选、接龙、报名、下午茶活动。
- wish_pool：打开/查看/投票愿望单或许愿池。
- wish_submit：提出菜单没有的饮品创意，想共创新品。
- scheduled_order：现在替用户准备一张未来时间下单的卡片。
- direct_order：用户已经说清楚具体饮品，或明确要代买/请别人喝但不需要其他人参与；进入普通下单流程。
- settings：修改默认门店、默认地址或偏好。
- chat：以上都不是。

字段判断：
- store_request：用户本轮提出取餐地点/附近找店/换门店时，额外输出 {"kind":"nearby或named或selection","query":"仅地点或店名","city":"明确城市或空字符串","continuation":"剥离地点后剩下的饮品/推荐/预约需求"}。没有地点需求时为 null。不要把普通“瑞幸有哪些新品”“我到公司了”“换成冰的”当换店。不得编造门店 ID 或坐标；简称可展开常见地名，拿不准保留原话。附近找店是 nearby，指定分店是 named，确认候选序号是 selection。
- “北京东升科技园附近的店，给我看看有哪些新品。” => store_request={"kind":"nearby","query":"北京东升科技园","city":"北京","continuation":"给我看看有哪些新品"}
- “我现在在贵州大学” => store_request={"kind":"nearby","query":"贵州大学","city":"","continuation":""}
- “帮我在贵大学府里店来杯冰美式” => store_request={"kind":"named","query":"贵州大学学府里店","city":"","continuation":"来杯冰美式"}
- 默认地址设置由 settings 处理，store_request=null；否定旧店并指定新店时只抽取肯定的新店，不能选否定的店。
- scheduled：是否明确有未来时间（如“下午一点”“明天”“稍后”“预约”）。
- scheduled_at：结合当前北京时间，把能确定的时间标准化为 YYYY-MM-DD HH:mm；无法确定则填 null。
- collaborative：是否需要其他人参与填写、选饮品、接龙或报名。仅仅“我请大家喝”“给观众买几杯”“我来付款”都不是 collaborative。

优先理解这些例子：
“下午一点预定三杯热门新品，我请参赛观众喝” => {"intent":"scheduled_order","scheduled":true,"collaborative":false}
“下午一点在群里发起拼单，大家自选” => {"intent":"team_party","scheduled":true,"collaborative":true}
“今天有新人报道，我请客，发起一次拼单” => {"intent":"team_party","scheduled":false,"collaborative":true}
“我请团队喝三杯，直接下单” => {"intent":"direct_order","scheduled":false,"collaborative":false}
“我到公司了，推荐一杯” => {"intent":"exclusive_recommendation","scheduled":false,"collaborative":false}
“我现在不知道喝什么，推荐几杯” => {"intent":"exclusive_recommendation","scheduled":false,"collaborative":false}

当前北京时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}
当前会话状态：${currentMode ?? '无'}
用户原话：${userText}`;

  const res = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
    signal: taskSignal(30_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      messages: [{ role: 'user', content: prompt }],
      thinking: { type: 'disabled' },
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`意图分类 HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseClassificationResponse(data?.choices?.[0]?.message?.content);
}
