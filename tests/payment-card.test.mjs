import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentCard } from '../src/cards.js';

test('支付卡不内嵌受尺寸限制的 img，二维码由独立图片消息发送', () => {
  const card=buildPaymentCard({imageKey:'img_test',order:{result:{data:{orderIdStr:'o1',discountPrice:12.3}}}});
  assert.equal(card.body.elements.some(e=>e.tag==='img'),false);
  assert.match(card.body.elements.map(e=>e.content??'').join('\n'),/单独发送/);
});
