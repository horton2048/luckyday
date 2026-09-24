const LUCKIN_BLUE = "blue";

export function buildOrderEntryCard({ownerId,title='LuckyDay · 选一杯',message='可以直接在卡片里选门店、选饮品和规格。',resume=false}) {
  const button=(label,action)=>({tag:'button',type:'primary',text:{tag:'plain_text',content:label},behaviors:[{type:'callback',value:{action,owner_id:ownerId}}]});
  return {schema:'2.0',config:{width_mode:'fill',enable_forward:false},header:{template:'blue',title:{tag:'plain_text',content:title}},body:{elements:[{tag:'markdown',content:message},button('打开点单卡','order_entry'),...(resume?[button('恢复主动推荐','order_resume')]:[])]}};
}

function text(content) {
  return { tag: "plain_text", content };
}

function callback(action, value) {
  return [{ type: "callback", value: { action, ...value } }];
}

function formatAmount(value) {
  if (value == null || String(value).trim() === "") return "以支付页为准";
  const amount = Number(value);
  return Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : "以支付页为准";
}

function orderLines(order) {
  const items = order.productList ?? [];
  return items
    .map((item, index) => {
      const name = item.productName ?? item.skuName ?? item.name ?? `饮品 ${index + 1}`;
      const quantity = item.amount ?? item.quantity ?? 1;
      return `- ${name} × ${quantity}`;
    })
    .join("\n");
}

export function buildOrderConfirmCard({ pendingId, order, summary }) {
  const price = order.preview?.data?.discountPrice ?? order.preview?.data?.totalPrice ?? order.preview?.data?.price;
  const itemText = orderLines(order) || "饮品明细已准备好";

  return {
    schema: "2.0",
    config: { width_mode: "fill", enable_forward: false },
    header: {
      template: LUCKIN_BLUE,
      title: text("LuckyDay · 订单确认"),
      subtitle: text("瑞幸企业点单服务"),
    },
    body: {
      padding: "12px 12px 12px 12px",
      elements: [
        { tag: "markdown", content: "**订单已为你准备好**\n确认后才会生成支付二维码。" },
        { tag: "hr" },
        { tag: "markdown", content: itemText },
        {
          tag: "column_set",
          flex_mode: "bisect",
          columns: [
            {
              tag: "column",
              elements: [{ tag: "div", text: { tag: "plain_text", content: "门店", text_color: "grey" } }, { tag: "div", text: text(order.shopName ?? (order.orderArgs?.deptId ? `门店 ${order.orderArgs.deptId}（名称待核实）` : "门店待核实")) }],
            },
            {
              tag: "column",
              elements: [{ tag: "div", text: { tag: "plain_text", content: "预计应付", text_color: "grey" } }, { tag: "div", text: { tag: "plain_text", content: formatAmount(price), text_size: "heading-2", text_color: "blue" } }],
            },
          ],
        },
        { tag: "hr" },
        { tag: "markdown", content: summary ? `_${summary}_` : "请核对饮品与金额。" },
        {
          tag: "column_set",
          flex_mode: "bisect",
          columns: [
            {
              tag: "column",
              elements: [{ tag: "button", type: "default", width: "fill", text: text("继续调整"), behaviors: callback("edit_order", { pending_id: pendingId }) }],
            },
            {
              tag: "column",
              elements: [{ tag: "button", type: "primary", width: "fill", text: text("确认并生成支付码"), confirm: { title: text("确认生成支付码？"), text: text("确认后将创建订单，并生成本次支付二维码。") }, behaviors: callback("confirm_order", { pending_id: pendingId }) }],
            },
          ],
        },
      ],
    },
  };
}

export function buildPaymentCard({ order, imageKey }) {
  const amount = order.result?.data?.discountPrice ?? order.result?.data?.totalPrice ?? order.result?.data?.price;
  const orderId = order.result?.data?.orderIdStr ?? order.result?.data?.orderId;
  return {
    schema: "2.0",
    config: { width_mode: "fill", enable_forward: false },
    header: { template: LUCKIN_BLUE, title: text("LuckyDay · 请完成支付"), subtitle: text("订单已创建"), },
    body: {
      padding: "12px 12px 12px 12px",
      elements: [
        { tag: "markdown", content: `**请使用微信扫码完成支付**\n订单号：${orderId ?? "已生成"}${amount ? ` · 应付 ${formatAmount(amount)}` : ""}` },
        { tag: "markdown", content: imageKey ? "支付二维码将作为图片消息单独发送，手机端可直接长按识别。" : "支付二维码暂未发送成功，可点击重发支付卡。" },
        { tag: "markdown", content: "支付成功后，瑞幸将按订单状态处理。" },
      ],
    },
  };
}
