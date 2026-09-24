// 到岗推荐卡：私聊发给个人的一张卡，点一下就真下单。
//
// 和拼单卡一样走卡片实体（cardkit），因为"换一杯"要在原地把卡片内容换掉。
// 组件 id 只留一个 detail，局部更新时只换这一块，不会闪。

import { formatClock } from "./arrivals.js";
import { productRow } from './productImages.js';

const text = (content) => ({ tag: "plain_text", content });
const md = (content) => ({ tag: "markdown", content });
const callback = (action, recoId, value = {}) => [{ type: "callback", value: { action, reco_id: recoId, ...value } }];

export function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `¥${n.toFixed(2)}` : "以支付页为准";
}

function candidateBlock(candidate, total) {
  const spec = candidate.attrText ? `${candidate.attrText} ` : "";
  const hint = total > 1 ? `\n_点「换一杯」还有 ${total - 1} 个备选_` : "";
  return `**${candidate.name}**　${spec}${formatMoney(candidate.price)}\n_${candidate.note}_${hint}`;
}

function othersLine(reco) {
  const others = reco.candidates.filter((_, i) => i !== reco.index).map((c) => c.name);
  if (others.length === 0) return null;
  return `☕ 今天也可以试试：${others.join("　｜　")}`;
}

export function buildRecoCard(reco) {
  const candidate = reco.candidates[reco.index];
  const others = othersLine(reco);
  const manual = reco.trigger === "manual";
  const shopName = reco.shop?.deptName ?? "默认门店";
  const shopAddress = reco.shop?.deptAddress ?? reco.shop?.address;
  const elements = [
    md(`取餐门店：**${shopName}**${shopAddress ? `\n${shopAddress}` : ""}`),
    md(`第 ${reco.index + 1} 杯 · 为你挑的`),
    { tag: "hr" },
    productRow(candidate,[md(candidateBlock(candidate, reco.candidates.length))],'detail'),
  ];
  if (manual) {
    elements.push({
      tag: "form",
      name: "reco_search",
      elements: [
        { tag: "input", name: "query", placeholder: text("想喝什么？直接写饮品名") },
        { tag: "button", name: "submit", type: "primary", width: "fill", text: text("按描述换推荐"), action_type: "form_submit", value: { action: "reco_search", reco_id: reco.id } },
      ],
    });
  }
  elements.push(
    {
      tag: "column_set",
      flex_mode: "none",
      columns: [
        { tag: "column", width: "weighted", weight: 1, elements: [{ tag: "button", type: "primary", width: "fill", text: text("选这杯 / 调整规格"), behaviors: callback("reco_buy", reco.id, {candidate_index:reco.index}) }] },
        { tag: "column", width: "weighted", weight: 1, elements: [{ tag: "button", type: "default", width: "fill", text: text("换一杯"), behaviors: callback("reco_switch", reco.id) }] },
      ],
    },
    { tag: "button", type: "text", width: "fill", text: text("今天不喝"), behaviors: callback("reco_decline", reco.id) },
  );
  if (others) {
    elements.push({ tag: "hr" }, md(others));
  }

  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, enable_forward: false },
    header: {
      template: "blue",
      title: text("LuckyDay · 专属推荐"),
      subtitle: text(manual ? "结合新品和你的口味记忆，挑一杯现在就能下单" : `你 ${formatClock(reco.arrivalAt)} 到公司了${reco.place ? ` · ${reco.place}` : ""}`),
    },
    body: { padding: "12px 12px 12px 12px", elements },
  };
}

export function buildRecoOrderedCard(reco, candidate) {
  return {
    schema: "2.0",
    config: { width_mode: "fill", enable_forward: false },
    header: { template: "green", title: text("LuckyDay · 已经帮你下单"), subtitle: text(candidate.name) },
    body: {
      padding: "12px 12px 12px 12px",
      elements: [
        md(`**${candidate.name}**　${candidate.attrText ? `${candidate.attrText} ` : ""}${formatMoney(candidate.price)}\n订单号 ${reco.order?.data?.orderIdStr ?? "已生成"}`),
        { tag: "hr" },
        md("支付二维码已经发在下面了，扫一下就好。做好的咖啡在门店自取台等你～"),
      ],
    },
  };
}

export function buildRecoDeclinedCard(reco) {
  const pref = reco.declineNote ?? "";
  return {
    schema: "2.0",
    config: { width_mode: "fill", enable_forward: false },
    header: { template: "grey", title: text("LuckyDay · 今天不推了"), subtitle: text("想喝随时叫我") },
    body: { padding: "12px 12px 12px 12px", elements: [md(pref || "今天先不推荐。"),{tag:'button',text:text('恢复推荐 / 选一杯'),type:'primary',behaviors:callback('reco_resume',reco.id)}] },
  };
}

// 支付卡：和拼单一样的做法——二维码图片走飞书图床拿 img_key，不直接塞外链。
export function buildRecoPaymentCard(reco, candidate, imageKey) {
  return {
    schema: "2.0",
    config: { width_mode: "fill", enable_forward: false },
    header: {
      template: "green",
      title: text("LuckyDay · 已经帮你下单"),
      subtitle: text(`${candidate.name} ${formatMoney(candidate.price)}`),
    },
    body: {
      padding: "12px 12px 12px 12px",
      elements: [
        md(`订单号 ${reco.order?.data?.orderIdStr ?? "已生成"}`),
        md(imageKey ? "支付二维码将作为图片消息单独发送。" : "支付二维码暂未发送成功，可稍后重试。"),
        { tag: "hr" },
        md("扫一下就好，做好的咖啡在门店自取台等你～"),
      ],
    },
  };
}
