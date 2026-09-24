// Resolve display fields from matching tool evidence, never from the model's prose.
export function buildOrderSnapshot(previewOrder, history) {
  const args = structuredClone(previewOrder.args);
  const preview = structuredClone(previewOrder.result);
  const calls = new Map();
  let shopName = String(args.deptId) === '603443' ? '西大望路平乐园店' : null;
  const products = new Map();
  const visit = (node, fn) => {
    if (!node || typeof node !== 'object') return;
    fn(node);
    Object.values(node).forEach(value => visit(value, fn));
  };
  for (const message of history) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, call.function);
    if (message.role !== 'tool') continue;
    try {
      const call = calls.get(message.tool_call_id);
      if (!call) continue;
      const input = JSON.parse(call.arguments);
      const result = JSON.parse(message.content);
      if (result.error || result.success === false || (result.code != null && Number(result.code) !== 0)) continue;
      if (call.name === 'queryShopList') {
        visit(result.data, node => {
          if (String(node.deptId) === String(args.deptId) && typeof node.deptName === 'string') shopName = node.deptName;
        });
      }
      if (['searchProductForMcp', 'queryProductDetailInfo', 'switchProduct'].includes(call.name) && String(input.deptId) === String(args.deptId)) {
        visit(result.data, node => {
          if (node.productId != null && typeof node.skuCode === 'string') products.set(`${node.productId}:${node.skuCode}`, node);
        });
      }
    } catch { /* Incomplete historic evidence must not invent display data. */ }
  }
  if (Array.isArray(preview.data?.couponCodeList)) args.couponCodeList = [...preview.data.couponCodeList];
  return {
    orderArgs: args, preview, shopName,
    productList: (args.productList ?? []).map(item => ({ ...item, productName: products.get(`${item.productId}:${item.skuCode}`)?.productName })),
  };
}
