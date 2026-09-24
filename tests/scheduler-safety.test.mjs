import test from 'node:test';
import assert from 'node:assert/strict';
import {executeScheduled} from '../src/scheduler.js';
for(const changed of [true,false])test(`预约到点重新核价：${changed?'价格变化先回卡确认':'同价使用新券下单'}`,async()=>{
  const item={deptId:1,productList:[],authorizedPrice:10};const calls=[];let confirmation=0;
  await executeScheduled(item,{call:async(name,args)=>{calls.push({name,args});return name==='previewOrder'?{code:0,data:{discountPrice:changed?11:10,couponCodeList:['fresh']}}:{code:0,data:{payOrderQrCodeUrl:'test'}};},persist:async()=>{},onNeedsConfirmation:async()=>{confirmation++;},notify:async()=>{}});
  assert.equal(confirmation,changed?1:0);assert.equal(calls.filter(c=>c.name==='createOrder').length,changed?0:1);
  if(!changed)assert.deepEqual(calls[1].args.couponCodeList,['fresh']);
});
test('预约支付卡发送失败不会把已创建订单改成可重试',async()=>{
  const item={deptId:1,productList:[],authorizedPrice:10};let creates=0;
  await executeScheduled(item,{call:async(name)=>name==='previewOrder'?{code:0,data:{discountPrice:10}}:(creates++,{data:{payOrderQrCodeUrl:'test'}}),persist:async()=>{},onNeedsConfirmation:async()=>assert.fail('must not reopen'),notify:async()=>{throw new Error('send failed');}});
  assert.equal(item.status,'done');assert.equal(creates,1);
});
