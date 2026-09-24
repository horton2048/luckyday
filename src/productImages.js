// Product pictures come from the verified menu, never from generated prose.
export function createProductImages({ upload, now = Date.now, onError = () => {} }) {
  const cache = new Map();
  async function prepare(product) {
    const url = product?.pictureUrl;
    if (!url) return product;
    if (product.imageKey && product.imageSource === url) return product;
    delete product.imageKey;
    delete product.imageSource;
    let entry = cache.get(url);
    if (!entry || entry.expires <= now()) {
      entry = { expires: now() + 24 * 60 * 60 * 1000 };
      entry.promise = Promise.resolve().then(() => upload(url)).catch(error => {
        entry.expires = now() + 30_000;
        onError(error);
        return null;
      });
      cache.set(url, entry);
      if (cache.size > 512) cache.delete(cache.keys().next().value);
    }
    const imageKey = await entry.promise;
    // An async refresh must not attach a previous picture to a changed product.
    if (imageKey && product.pictureUrl === url) {
      product.imageKey = imageKey;
      product.imageSource = url;
    }
    return product;
  }
  return async function prepareProducts(products) {
    const queue = [...products];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) await prepare(queue.shift());
    }));
  };
}

export function productRow(product, elements, elementId) {
  const picture = product.imageKey
    ? { tag: 'img', img_key: product.imageKey, alt: { tag: 'plain_text', content: product.productName || product.name || '饮品图片' }, size: '80px 80px', scale_type: 'crop_center', preview: true }
    : { tag: 'markdown', content: '☕\n图片暂不可用' };
  return {
    tag: 'column_set', ...(elementId ? { element_id: elementId } : {}),
    flex_mode: 'none', horizontal_spacing: '12px',
    columns: [
      { tag: 'column', width: 'auto', elements: [picture] },
      { tag: 'column', width: 'weighted', weight: 1, elements },
    ],
  };
}
