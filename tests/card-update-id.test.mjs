import test from 'node:test';
import assert from 'node:assert/strict';
import { updateCardEntity, updateCardElement } from '../src/feishu.js';

test('不同卡片同序号不能被当作同一次更新，重复相同操作保持幂等', async () => {
  const original=globalThis.fetch, requests=[];
  globalThis.fetch=async(url,init)=>{
    if(String(url).includes('auth/v3'))return {json:async()=>({code:0,tenant_access_token:'fixture',expire:7200})};
    requests.push(JSON.parse(init.body));
    return {json:async()=>({code:0,data:{}})};
  };
  try {
    await updateCardEntity('card-a',{},1);
    await updateCardEntity('card-b',{},1);
    await updateCardEntity('card-a',{},1);
    await updateCardElement('card-a','body',{},1);
    assert.notEqual(requests[0].uuid,requests[1].uuid);
    assert.equal(requests[0].uuid,requests[2].uuid);
    assert.notEqual(requests[0].uuid,requests[3].uuid);
  } finally {globalThis.fetch=original;}
});
