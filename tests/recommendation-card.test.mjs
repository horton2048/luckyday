import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecoCard } from '../src/recoCards.js';

test('主动推荐卡展示当前门店并提供可更新的换一杯动作', () => {
  const card = buildRecoCard({
    id: 'reco_test',
    trigger: 'manual',
    arrivalAt: Date.now(),
    shop: { deptId: 9, deptName: '新默认店', address: '新地址' },
    index: 0,
    candidates: [
      { name: '第一杯', price: 9.9, note: '今天的新品' },
      { name: '第二杯', price: 10.9, note: '你之前点过的那杯' },
    ],
  });
  const json = JSON.stringify(card);
  assert.match(json, /专属推荐/);
  assert.match(json, /新默认店/);
  assert.match(json, /新地址/);
  assert.match(json, /reco_switch/);
  assert.match(json, /换一杯/);
  assert.match(json, /reco_search/);
  assert.match(json, /按描述换推荐/);
});
