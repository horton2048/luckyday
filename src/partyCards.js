// 下午茶拼单的卡片。全部是卡片 JSON 2.0；因为要"发出去之后还能改"，组装好后交给
// feishu.js 的卡片实体接口发送，而不是普通卡片消息。
//
// 组件分工（element_id 很重要，局部更新靠它精确命中，避免整卡重绘打断别人填表）：
//   roster  —— 已参与名单，每次有人提交只更新这一个组件
//   form    —— 收集表单，提交后由飞书把填好的值随回调一起送回来

const BLUE = "blue";

const text = (content) => ({ tag: "plain_text", content });
const md = (content) => ({ tag: "markdown", content });
// 每个按钮都把 party_id 带上：卡片回调里没有现成的"这是哪一局拼单"，
// 靠 value 带过去最省事（也避免了同一群多局时认错单）。
const callback = (action, partyId, value = {}) => [{ type: "callback", value: { action, party_id: partyId, ...value } }];

export function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `¥${n.toFixed(2)}` : "以支付页为准";
}

// 艾特别人靠 open_id 拼出来；open_id 缺失时宁可不艾特，也不能把 `<at id=></at>` 这种
// 半截标签漏到卡片上——用户看到的就是一行乱码。
export function mention(openId) {
  return openId ? `<at id=${openId}></at> ` : "";
}

export function deadlineText(deadline) {
  return new Date(deadline).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
}

function drinkOptions(party) {
  return (party.newProducts ?? []).map((p) => ({ text: text(`${p.name} ${formatMoney(p.price)}`), value: p.name }));
}

function options(list) {
  return list.map((v) => ({ text: text(v), value: v }));
}

export function rosterText(party) {
  const joined = party.participants.filter((p) => p.mode !== "declined");
  if (joined.length === 0) return "_还没有人点，第一个点的人享有绝对话语权_";
  const cups = joined.reduce((sum, p) => sum + (p.amount ?? 1), 0);
  const lines = joined.map((p) => `· **${p.userName}** ${p.productName}${p.attrText ? ` ${p.attrText}` : ""} ×${p.amount ?? 1}`);
  return `**已参与 ${joined.length} 人 · ${cups} 杯**\n${lines.join("\n")}`;
}

export function newProductsText(party) {
  const list = party.newProducts ?? [];
  if (list.length === 0) return "";
  const line = list.map((p) => `${p.name} ${formatMoney(p.price)}`).join("　｜　");
  return `🆕 **今日新品**\n${line}`;
}

export function buildPartyCard(party) {
  const due = deadlineText(party.deadline);
  const elements = [
    md(`🔔 <at id=all></at> 下午茶时间到，想喝的点一下，**${due} 截止**`),
    { tag: "hr" },
  ];

  const newText = newProductsText(party);
  if (newText) elements.push(md(newText), { tag: "hr" });

  elements.push(
    { ...md(rosterText(party)), element_id: "roster" },
    { tag: "hr" },
    {
      tag: "form",
      name: "party_form",
      elements: [
        {
          tag: "select_static",
          name: "drink",
          placeholder: text("选一杯（今日新品）"),
          options: drinkOptions(party),
        },
        { tag: "input", name: "other", placeholder: text("也可以直接输入想喝的，如「生椰拿铁」") },
        {
          tag: "column_set",
          flex_mode: "flow",
          columns: [
            { tag: "column", width: "auto", elements: [{ tag: "select_static", name: "temp", placeholder: text("温度"), options: options(["冰", "少冰", "去冰", "热"]) }] },
            { tag: "column", width: "auto", elements: [{ tag: "select_static", name: "size", placeholder: text("杯型"), options: options(["大杯", "超大杯"]) }] },
            { tag: "column", width: "auto", elements: [{ tag: "select_static", name: "amount", placeholder: text("数量"), options: options(["1", "2", "3", "4"]) }] },
          ],
        },
        // 表单容器里的提交按钮必须用 action_type=form_submit（用 behaviors 会被判成"没有提交按钮"），
        // party_id 只能挂在 value 上跟着回传。
        {
          tag: "button",
          name: "submit",
          type: "primary",
          width: "fill",
          text: text("提交我这杯"),
          action_type: "form_submit",
          value: { action: "party_submit", party_id: party.id },
        },
      ],
    },
    {
      tag: "column_set",
      flex_mode: "bisect",
      columns: [
        { tag: "column", elements: [{ tag: "button", type: "default", width: "fill", text: text("和上次一样"), behaviors: callback("party_same", party.id) }] },
        { tag: "column", elements: [{ tag: "button", type: "default", width: "fill", text: text("今天不喝"), behaviors: callback("party_decline", party.id) }] },
      ],
    },
  );

  if (party.initiatorId) {
    elements.push({ tag: "button", type: "default", width: "fill", text: text("提前截止并汇总"), behaviors: callback("party_close", party.id) });
  }

  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, enable_forward: false },
    header: {
      template: BLUE,
      title: text("LuckyDay · 今天下午茶"),
      subtitle: text(`${party.shopName} · ${due} 截止`),
    },
    body: { padding: "12px 12px 12px 12px", elements },
  };
}

export function buildPartyRosterElement(party) {
  return { ...md(rosterText(party)), element_id: "roster" };
}

export function buildPartyConfirmCard(party) {
  const joined = party.participants.filter((p) => p.mode !== "declined");
  const cups = joined.reduce((sum, p) => sum + (p.amount ?? 1), 0);
  const price = party.preview?.data?.discountPrice ?? party.preview?.data?.totalPrice ?? party.preview?.data?.price;
  const lines = joined.map((p) => `· ${p.userName}  ${p.productName}${p.attrText ? ` ${p.attrText}` : ""} ×${p.amount ?? 1}`);

  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, enable_forward: false },
    header: { template: BLUE, title: text("LuckyDay · 确认拼单"), subtitle: text(`${joined.length} 人 · ${cups} 杯`) },
    body: {
      padding: "12px 12px 12px 12px",
      elements: [
        md(`**合计 ${formatMoney(price)}**\n${lines.join("\n")}`),
        { tag: "hr" },
        md(`${mention(party.payerOpenId)}老板，用你的账号统一下单，确认后二维码发到群里 @你。`),
        {
          tag: "column_set",
          flex_mode: "bisect",
          columns: [
            { tag: "column", elements: [{ tag: "button", type: "default", width: "fill", text: text("回去改一改"), behaviors: callback("party_reopen", party.id) }] },
            { tag: "column", elements: [{ tag: "button", type: "primary", width: "fill", text: text("确认下单"), behaviors: callback("party_confirm", party.id) }] },
          ],
        },
      ],
    },
  };
}

// 截止后没人参与 / 已下单完成，都用这张卡把原卡"封口"，避免有人继续点已经过期的按钮。
export function buildPartyClosedCard(party, { title, note, template = "grey" }) {
  const joined = party.participants.filter((p) => p.mode !== "declined");
  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, enable_forward: false },
    header: { template, title: text("LuckyDay · 今天下午茶"), subtitle: text(note) },
    body: {
      padding: "12px 12px 12px 12px",
      elements: [
        md(title),
        { tag: "hr" },
        { ...md(joined.length ? rosterText(party) : "_这场下午茶没有人点，明天见_"), element_id: "roster" },
      ],
    },
  };
}

// 下单后的支付卡：直接发群里并 @老板 扫码，符合"老板统一付款"的约定。
export function buildPartyPaymentCard(party, imageKey) {
  const joined = party.participants.filter((p) => p.mode !== "declined");
  const cups = joined.reduce((sum, p) => sum + (p.amount ?? 1), 0);
  const amount = party.order?.data?.discountPrice ?? party.order?.data?.totalPrice;
  const orderId = party.order?.data?.orderIdStr ?? party.order?.data?.orderId;

  return {
    schema: "2.0",
    config: { width_mode: "fill", enable_forward: false },
    header: { template: "green", title: text("LuckyDay · 下午茶已下单"), subtitle: text(`${joined.length} 人 · ${cups} 杯 · ${formatMoney(amount)}`) },
    body: {
      padding: "12px 12px 12px 12px",
      elements: [
        md(`${mention(party.payerOpenId)}老板，麻烦扫下面的码付一下～\n订单号：${orderId ?? "已生成"}`),
        md(imageKey ? "支付二维码将作为图片消息单独发送。" : "支付二维码暂未发送成功，请联系发起人重试。"),
        { tag: "hr" },
        md(rosterText(party)),
      ],
    },
  };
}
