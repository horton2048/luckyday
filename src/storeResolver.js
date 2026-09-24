// 门店名称在真实对话里经常省略“瑞幸/咖啡/店”等通用词。
// 这里用可解释的字符匹配做最后一层确认，真实 deptId 和地址始终来自门店接口。

const GENERIC = /(?:瑞幸咖啡|瑞幸|luckincoffee|luckin|咖啡店|咖啡|门店|取餐店|店|附近|最近|我要|请|帮我|换到|换成|改到|改成|选|选择|就|这家|那个|一个)/giu;

export function normalizeStoreText(value) {
  return String(value ?? "")
    .replace(/贵大/g, "贵州大学").replace(/北工大/g, "北京工业大学").normalize("NFKC")
    .toLowerCase()
    .replace(GENERIC, "")
    .replace(/[\s\p{P}\p{S}_]+/gu, "")
    .trim();
}

function compact(value) {
  return String(value ?? "").replace(/贵大/g, "贵州大学").replace(/北工大/g, "北京工业大学").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function fields(shop) {
  return [shop?.deptName, shop?.address, shop?.deptAddress, shop?.shopName, shop?.name].filter(Boolean).map(compact);
}

export function scoreStoreMatch(query, shop) {
  const wanted = normalizeStoreText(query);
  if (!wanted) return 0;
  const haystacks = fields(shop);
  if (!haystacks.length) return 0;
  if (haystacks.some((field) => field === wanted)) return 1000;
  if (haystacks.some((field) => field.includes(wanted))) return 800 + Math.min(wanted.length, 100);

  return 0;
}

export function rankStoreMatches(query, shops, { limit = 3 } = {}) {
  const rows = (Array.isArray(shops) ? shops : [])
    .filter((shop) => shop && shop.deptId != null)
    .map((shop, index) => ({ shop, score: scoreStoreMatch(query, shop), index }))
    .sort((a, b) => b.score - a.score || (a.shop.distanceKm ?? Number.POSITIVE_INFINITY) - (b.shop.distanceKm ?? Number.POSITIVE_INFINITY) || a.index - b.index);
  return rows.slice(0, Math.max(1, limit));
}

export function bestStoreMatch(query, shops, { minScore = 48 } = {}) {
  const [first, second] = rankStoreMatches(query, shops, { limit: 2 });
  if (!first || first.score < minScore) return null;
  // 同一个地名下有多家店时（例如“贵州大学瑞幸”），不要替用户猜分店。
  if (second && second.score >= first.score - 10) return null;
  return first.shop;
}

export function isStoreSelectionText(text) {
  const value = String(text ?? "").trim();
  return /^(?:第\s*[一二三四五六七八九十\d]+\s*(?:个|家)?(?:门店)?|[1-9]\d?|就这家|这家|这个|选它|选这家|好的?就它|可以)$/iu.test(value);
}

export function selectionIndex(text) {
  const value = String(text ?? "").trim();
  const match = value.match(/^(?:第\s*([一二三四五六七八九十\d]+)\s*(?:个|家)?(?:门店)?|([1-9]\d?))$/iu);
  if (!match) return null;
  const raw = match[1] ?? match[2];
  const chinese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return chinese[raw] ?? Number(raw);
}

// Extract a location separately from the requested drink/action. Never send the
// entire "地点附近的店，看看新品" sentence to the geocoder.
export function storeRequestFromText(text, currentUi = null) {
  const value = String(text ?? '').trim().replace(/[。！!？?]+$/u, '');
  if (!value) return null;
  const clauses = value.split(/[，,；;。]/u).map(x => x.trim()).filter(Boolean);
  const continuation = clauses.filter(x => /新品|推荐|喝|[一二三四五六七八九十\d]+杯|来杯|下单|预约/u.test(x) && !/附近|周边|门店/u.test(x)).join('，');
  const selection = clauses[0]?.replace(/^(?:那就|就|选|选择|要)\s*/u, '');
  if (currentUi?.storeSelectionPending && selectionIndex(selection) != null) return {kind:'selection',query:selection,continuation};
  if (/^(?:帮我|请)?换(?:个|一下)?门店$/u.test(value)) return {kind:'list',query:'',continuation};
  for (let part of clauses) {
    part = part.replace(/^(?:帮我|请|麻烦)?(?:找一下|找|换到|换成|改到|改成|改为|我现在在|我目前在|我在|现在在|目前在|就在|我到了|我到|到了)\s*/u, '');
    if (/^(?:离我最近(?:的)?|我附近)(?:瑞幸咖啡|瑞幸|门店|店)?$/u.test(part)) return {kind:'nearby',query:'',continuation};
    if(/新品|推荐|美式|拿铁|预约|下单|杯/.test(part) && clauses.length===1)continue;
    const nearby = part.match(/^(.+?)(?:附近|周边|旁边)(?:的)?(?:最近的)?(?:瑞幸咖啡|瑞幸|咖啡店|门店|店)?(?:.*)$/u);
    if (nearby) return {kind:'nearby',query:nearby[1].trim(),continuation};
    if (/^(?:离我最近(?:的)?|我附近)(?:瑞幸咖啡|瑞幸|门店|店)?$/u.test(part)) return {kind:'nearby',query:'',continuation};
    // Company arrival remains a recommendation signal; a real landmark is required.
    if (/^(?:我(?:现在|目前)?在|现在在|目前在|我到了)/u.test(clauses.find(c=>c.includes(part)) ?? '') && !/^(?:公司|办公室|工位|家|这里|那边)(?:了)?$/u.test(part)) {
      return {kind: /店$/u.test(part) ? 'named' : 'nearby',query:part,continuation};
    }
    if (/(?:店|校区|园区)$/u.test(part) && !/^(?:瑞幸|咖啡|门店|换门店|退出点单|不换店)$/u.test(part) && !/不要|别|不换|不去/u.test(part)) {
      return {kind:'named',query:part,continuation};
    }
  }
  if (currentUi?.storeSelectionPending && bestStoreMatch(value,currentUi.shops)) return {kind:'selection',query:value,continuation:''};
  return null;
}
