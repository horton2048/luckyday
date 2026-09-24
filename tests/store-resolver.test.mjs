import test from 'node:test';
import assert from 'node:assert/strict';
import { bestStoreMatch, normalizeStoreText, rankStoreMatches } from '../src/storeResolver.js';

const shops = [
  { deptId: 11, deptName: '贵州大学北校区店', address: '贵州大学北校区东门', distanceKm: 0.4 },
  { deptId: 12, deptName: '花溪大学城店', address: '花溪区大学城', distanceKm: 2.1 },
];

test('门店简称会忽略瑞幸、门店等通用词并命中真实门店', () => {
  assert.equal(normalizeStoreText('贵州大学瑞幸'), '贵州大学');
  assert.equal(bestStoreMatch('贵大北校区店', shops).deptId, 11);
});

test('门店匹配结果保留真实地址并按语义得分排序', () => {
  const rows = rankStoreMatches('贵州大学北校区', shops);
  assert.equal(rows[0].shop.deptId, 11);
  assert.equal(rows[0].shop.address, '贵州大学北校区东门');
});

test('同一地点对应多家分店时不替用户猜分店', () => {
  const samePlace = [
    { deptId: 21, deptName: '贵州大学朝阳村店', address: '贵州大学附近' },
    { deptId: 22, deptName: '贵州大学西校区店', address: '贵州大学附近' },
  ];
  assert.equal(bestStoreMatch('贵州大学瑞幸', samePlace), null);
});

const {storeRequestFromText}=await import('../src/storeResolver.js');
test('截图原话拆分地点与新品需求',()=>{
  assert.deepEqual(storeRequestFromText('北京东升科技园附近的店，给我看看有哪些新品。'),{kind:'nearby',query:'北京东升科技园',continuation:'给我看看有哪些新品'});
  assert.equal(storeRequestFromText('我现在在贵州大学。').query,'贵州大学');
  assert.equal(storeRequestFromText('换成冰的'),null);
  assert.equal(storeRequestFromText('瑞幸有哪些新品'),null);
  assert.equal(storeRequestFromText('我到公司了，推荐一杯'),null);
});
test('不因共同“西校区”片段把两所大学当同一家店',()=>{
  assert.equal(bestStoreMatch('贵大西校区店',[{deptId:33,deptName:'广西大学西校区店'}]),null);
});
