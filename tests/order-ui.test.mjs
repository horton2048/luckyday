import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrderUi, selectedSpecs } from '../src/orderUi.js';
const product=(id=1,temp='热')=>({productId:id,productName:`饮品${id}`,skuCode:`${id}-${temp}`,productAttrs:[{attributeId:10,attributeName:'温度',productSubAttrs:['热','冰'].map((name,i)=>({attributeId:i+20,attributeName:name,selected:name===temp,canSelected:1}))}]});
function harness(){
  const calls=[],bookings=[];let lastCard,clock=100,price=9.9,payFailures=0,failure=null;
  const ui=createOrderUi({now:()=>clock,call:async(name,args)=>{
    calls.push({name,args:structuredClone(args)});
    if(failure===name)throw new Error('injected failure');
    if(name==='searchProductForMcp')return {code:0,data:[product(1),product(2)]};
    if(name==='queryShopList')return {code:0,data:[{deptId:2,deptName:'第二门店',address:'新地址',longitude:1,latitude:2}]};
    if(name==='queryProductDetailInfo')return {code:0,data:product(args.productId)};
    if(name==='switchProduct')return {code:0,data:product(args.productId,args.attrOperationParam.subAttr.attributeId===21?'冰':'热')};
    if(name==='previewOrder')return {code:0,data:{discountPrice:price,couponCodeList:['verified-coupon']}};
    if(name==='createOrder')return {code:0,data:{orderId:'test-order',payOrderQrCodeUrl:'test://qr'}};
    throw new Error('unexpected tool');
  },publish:async(s,card)=>{if(failure==='publish')throw new Error('publish failed');lastCard=card;},pay:async()=>{if(payFailures-->0)throw new Error('payment card failed');},schedule:async entry=>bookings.push(entry)});
  const start=()=>ui.start({ownerId:'u',chatId:'c'});
  const find=(s,type)=>[...s.choices].find(([,c])=>c.type===type)?.[0];
  const value=(s,type)=>({ui_id:s.id,revision:s.revision,choice:find(s,type)});
  const click=async(s,type,form={})=>{const ticket=ui.claim(value(s,type),'u','c');assert.ok(!ticket.error,ticket.error);return ui.perform(ticket,form);};
  return {ui,start,click,value,calls,bookings,card:()=>lastCard,advance:ms=>clock+=ms,setPrice:p=>price=p,fail:name=>failure=name,payFail:()=>payFailures=1};
}
test('卡片选店→饮品→冰→数量→报价→支付，全程无需聊天输入',async()=>{
  const h=harness();const s=await h.start();await h.click(s,'shops');await h.click(s,'shop');
  assert.equal(s.shop.deptId,2);assert.ok(JSON.stringify(h.card()).includes('新地址'));
  await h.click(s,'product');await h.click(s,'attr'); // current hot option is valid too
  const ice=[...s.choices].find(([,c])=>c.type==='attr'&&c.subId===21)[0];
  await h.ui.perform(h.ui.claim({ui_id:s.id,revision:s.revision,choice:ice},'u','c'));
  assert.ok(selectedSpecs(s.cart[0]).includes('冰'));
  await h.click(s,'specDone');
  await h.click(s,'confirm');assert.equal(s.screen,'done');
  assert.equal(h.calls.filter(c=>c.name==='createOrder').length,1);
  const order=h.calls.find(c=>c.name==='createOrder').args;
  assert.equal(order.deptId,2);assert.equal(order.productList[0].skuCode,'1-冰');assert.deepEqual(order.couponCodeList,['verified-coupon']);
});
test('换店清空旧菜单购物车报价和券，同一状态卡片更新',async()=>{
  const h=harness(),s=await h.start();await h.click(s,'product');await h.click(s,'specDone');
  const id=s.id;await h.click(s,'shops');await h.click(s,'shop');assert.equal(s.id,id);assert.equal(s.cart.length,0);assert.equal(s.quote,null);
  assert.ok(!JSON.stringify(h.card()).includes('西大望路平乐园店'));
});
test('默认门店变化不会复用旧门店状态',async()=>{
  const h=harness();
  const first=await h.ui.start({ownerId:'u',chatId:'c',defaultShop:{deptId:603443,deptName:'旧默认店',longitude:1,latitude:2}});
  const next=await h.ui.start({ownerId:'u',chatId:'c',defaultShop:{deptId:9,deptName:'新默认店',address:'新地址',longitude:3,latitude:4}});
  assert.notEqual(next.id,first.id);
  assert.equal(next.shop.deptId,9);
  assert.equal(next.shop.deptName,'新默认店');
  assert.equal(next.cart.length,0);
  assert.match(JSON.stringify(h.card()),/新默认店/);
});

test('修改默认门店会原地刷新已打开的点单卡',async()=>{
  const h=harness();
  const first=await h.ui.start({ownerId:'u',chatId:'c',defaultShop:{deptId:603443,deptName:'旧默认店',longitude:1,latitude:2}});
  await h.ui.updateDefault('u',{deptId:88,deptName:'新默认店',address:'新地址',longitude:3,latitude:4});
  const state=h.ui.current('u','c');
  assert.equal(state.shop.deptId,88);
  assert.equal(state.shop.deptName,'新默认店');
  assert.equal(state.screen,'home');
  assert.equal(state.cart.length,0);
  const latest=h.card();
  assert.match(JSON.stringify(latest),/新默认店/);
  assert.match(JSON.stringify(latest),/新地址/);
  assert.equal(state.id,first.id);
});
test('自然语言附近门店候选会把地址放进卡片，文字选店后锁定门店',async()=>{
  const h=harness();
  const s=await h.ui.start({ownerId:'u',chatId:'c',shopCandidates:[
    {deptId:7,deptName:'贵州大学北校区店',address:'贵州大学北校区东门',distanceMeters:300},
    {deptId:8,deptName:'花溪大学城店',address:'花溪区大学城',distanceMeters:1800},
  ],shopNotice:'请先选择取餐门店'});
  assert.equal(s.screen,'shops');
  assert.match(JSON.stringify(h.card()),/贵州大学北校区东门/);
  assert.match(JSON.stringify(h.card()),/待选择/);
  assert.ok(!JSON.stringify(h.card()).includes('西大望路平乐园店'));
  const selected=await h.ui.selectShop('u','c','第二家');
  assert.equal(selected.shop.deptId,8);
  assert.equal(s.shop.deptId,8);
  assert.equal(s.shopSource,'explicit');
  assert.equal(s.storeSelectionPending,false);
});
test('附近门店工具结果能直接为预览卡提供真实门店和地址',async()=>{
  const h=harness();
  const history=[
    {role:'assistant',tool_calls:[{id:'nearby',function:{name:'findNearbyShop',arguments:'{"place":"贵州大学"}'}}]},
    {role:'tool',tool_call_id:'nearby',content:JSON.stringify({origin:{address:'贵州大学'},shops:[{deptId:77,deptName:'贵州大学店',address:'贵州大学东门'}]})},
  ];
  const s=await h.ui.start({ownerId:'u',chatId:'c',history,previewOrder:{args:{deptId:77,productList:[{productId:1,skuCode:'1-热',amount:1}]},result:{data:{discountPrice:9.9}}}});
  assert.equal(s.shop.deptId,77);
  assert.equal(s.shop.address,'贵州大学东门');
  assert.match(JSON.stringify(h.card()),/贵州大学东门/);
});
test('快速重复点击、跨用户、跨聊天、过期卡均被拦截',async()=>{
  const h=harness(),s=await h.start(),v=h.value(s,'product');
  assert.ok(h.ui.claim(v,'other','c').error);assert.ok(h.ui.claim(v,'u','other').error);
  const accepted=Array.from({length:100},()=>h.ui.claim(v,'u','c')).filter(t=>!t.error);assert.equal(accepted.length,1);
  await h.ui.perform(accepted[0]);assert.equal(s.cart.length,1);assert.ok(h.ui.claim(v,'u','c').error);
  h.advance(31*60*1000);assert.ok(h.ui.claim(h.value(s,'specDone'),'u','c').error);
});
test('报价变化先展示新价格，第二次明确确认才下单',async()=>{
  const h=harness(),s=await h.start();await h.click(s,'product');await h.click(s,'specDone');
  h.setPrice(12);await h.click(s,'confirm');assert.equal(h.calls.filter(c=>c.name==='createOrder').length,0);assert.equal(s.quote.price,12);
  await h.click(s,'confirm');assert.equal(h.calls.filter(c=>c.name==='createOrder').length,1);
});
test('预览失败清旧报价，可通过卡片重试',async()=>{
  const h=harness(),s=await h.start();await h.click(s,'product');await h.click(s,'specDone');
  h.fail('previewOrder');await h.click(s,'confirm');assert.equal(s.quote,null);assert.ok(h.value(s,'quote').choice);
  h.fail(null);await h.click(s,'quote');assert.ok(s.quote);
});
test('规格接口失败不会拿新温度文案搭配旧SKU',async()=>{
  const h=harness(),s=await h.start();await h.click(s,'product');h.fail('switchProduct');await h.click(s,'attr');
  assert.equal(s.cart[0].skuCode,'1-热');assert.equal(selectedSpecs(s.cart[0]),'热');assert.ok(s.notice);
});
test('下单超时保持不确定状态，绝不开放重试下单按钮',async()=>{
  const h=harness(),s=await h.start();await h.click(s,'product');await h.click(s,'specDone');h.fail('createOrder');
  await h.click(s,'confirm');assert.equal(s.screen,'uncertain');assert.equal(s.choices.size,0);
});
test('支付卡发送失败只重发支付卡，不重复创建订单',async()=>{
  const h=harness(),s=await h.start();await h.click(s,'product');await h.click(s,'specDone');h.payFail();
  await h.click(s,'confirm');assert.equal(s.screen,'done');await h.click(s,'payment');assert.equal(h.calls.filter(c=>c.name==='createOrder').length,1);
});
test('卡片更新失败后旧按钮只触发刷新，不重复添加饮品',async()=>{
  const h=harness(),s=await h.start(),v=h.value(s,'product');h.fail('publish');
  await assert.rejects(h.ui.perform(h.ui.claim(v,'u','c')));assert.equal(s.cart.length,1);
  h.fail(null);await h.ui.perform(h.ui.claim(v,'u','c'));assert.equal(s.cart.length,1);assert.equal(s.deliveryFailed,false);
});
test('卡片中可提交搜索表单，门店和饮品搜索互不串路由',async()=>{
  const h=harness(),s=await h.start();await h.click(s,'productSearch',{query:'美式'});assert.equal(s.query,'美式');
  await h.click(s,'shops');await h.click(s,'shopSearch',{query:'理科楼'});assert.equal(h.calls.at(-1).args.deptName,'理科楼');
});
test('未来点单必须在卡片选择预约时间，不会静默变成立即下单',async()=>{
  const h=harness(),s=await h.ui.start({ownerId:'u',chatId:'c',userText:'明天点一杯'});
  await h.click(s,'product');await h.click(s,'specDone');assert.equal(s.screen,'schedule');assert.equal(s.quote,null);
  await h.click(s,'scheduleSet',{query:'2099-01-01 08:00'});await h.click(s,'quote');await h.click(s,'confirm');
  assert.equal(s.screen,'scheduled');assert.equal(h.bookings.length,1);assert.equal(h.calls.filter(c=>c.name==='createOrder').length,0);
});

test('下午一点等口语时间也必须进入预约流程',async()=>{
  const h=harness(),s=await h.ui.start({ownerId:'u',chatId:'c',userText:'下午一点的三杯热门新品'});
  await h.click(s,'product');await h.click(s,'specDone');
  assert.equal(s.screen,'schedule');
  assert.equal(s.quote,null);
  assert.match(JSON.stringify(h.card()),/定时下单/);
});

test('定时下单路由强制首屏进入预约时间卡',async()=>{
  const h=harness(),s=await h.ui.start({ownerId:'u',chatId:'c',forceSchedule:true});
  assert.equal(s.screen,'schedule');
  assert.match(JSON.stringify(h.card()),/设置预约时间/);
  assert.match(JSON.stringify(h.card()),/按当前时间/);
  assert.match(JSON.stringify(h.card()),/30分钟后/);
});

test('确认规格直接到订单确认，预约显示北京时间且拒绝不存在日期',async()=>{
  const h=harness(),s=await h.start();await h.click(s,'product');await h.click(s,'specDone');
  assert.equal(s.screen,'confirm');assert.match(JSON.stringify(h.card()),/LuckyDay · 订单确认/);
  await h.click(s,'schedule');await h.click(s,'scheduleSet',{query:'2027-02-30 08:00'});
  assert.equal(s.scheduleAt,undefined);assert.equal(s.screen,'schedule');
  await h.click(s,'scheduleSet',{query:'2027-02-28 08:00'});
  assert.match(JSON.stringify(h.card()),/2027-02-28 08:00（北京时间）/);
});

test('预约首屏使用原生日期时间选择器，表单提交后登记预约而非立即下单',async()=>{
  const h=harness(),s=await h.ui.start({ownerId:'u',chatId:'c',forceSchedule:true});
  const form=h.card().body.elements.find(e=>e.name==='schedule_time');
  assert.equal(form.elements[0].tag,'picker_datetime');
  assert.ok(form.elements[0].initial_datetime);
  assert.equal(form.elements[0].input_type,undefined);
  const choice=[...s.choices].find(([,c])=>c.type==='scheduleSet'&&!c.query)[0];
  await h.ui.perform(h.ui.claim({ui_id:s.id,revision:s.revision,choice},'u','c'),{query:'2099-01-01 13:00'});
  await h.click(s,'products');await h.click(s,'product');await h.click(s,'specDone');await h.click(s,'confirm');
  assert.equal(h.bookings.length,1);assert.equal(h.bookings[0].executeAt,'2099-01-01T05:00:00.000Z');
  assert.equal(h.calls.filter(c=>c.name==='createOrder').length,0);
});

test('换店候选未确认不能查看旧店饮品或继续旧报价',async()=>{
 const h=harness(),s=await h.start();await h.click(s,'product');await h.click(s,'specDone');
 const previous=h.value(s,'confirm');const before=h.calls.length;
 await h.ui.start({ownerId:'u',chatId:'c',shopCandidates:[{deptId:8,deptName:'东升店',address:'西小口路'}]});
 assert.equal(s.cart.length,0);assert.equal(s.quote,null);
 assert.ok(h.ui.claim(previous,'u','c').error);
 assert.equal(h.value(s,'products').choice,undefined);
 await h.ui.start({ownerId:'u',chatId:'c',userText:'来杯新品'});
 assert.equal(s.screen,'shops');assert.equal(h.calls.length,before);
});
test('已明确选店后，模型或旧推荐预览无法换回旧店',async()=>{
 const h=harness(),s=await h.start();await h.ui.setShop('u','c',{deptId:8,deptName:'东升店',address:'西小口路'});
 await h.ui.start({ownerId:'u',chatId:'c',defaultShop:{deptId:603443},previewOrder:{args:{deptId:603443,productList:[{productId:1,skuCode:'1-热',amount:1}]},result:{}}});
 assert.equal(s.shop.deptId,8);assert.equal(s.quote,null);assert.match(s.notice,/门店不一致/);
 assert.ok(!h.calls.some(c=>c.name==='previewOrder'));
});
