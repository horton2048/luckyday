import test from 'node:test';
import assert from 'node:assert/strict';
process.env.LUCKYDAY_TEST_MODE='1';
const rawFetch=globalThis.fetch;
const sent=[];const toolCalls=[];let updates=0;
globalThis.fetch=async(url,init={})=>{
  if(String(url).startsWith('http://127.0.0.1:'))return rawFetch(url,init);
  const body=JSON.parse(init.body??'{}');
  if(body.method==='tools/call') {
    toolCalls.push(body.params);
    const data=body.params.name==='queryShopList'?[{deptId:2,deptName:'第二店'}]:[{productId:1,productName:'美式',skuCode:'sku'}];
    return Response.json({result:{content:[{type:'text',text:JSON.stringify({code:0,data})}]}});
  }
  if(String(url).endsWith('/chat/completions')) {
    const classifier = String(body.messages?.[0]?.content ?? '').includes('交易流程路由器');
    return Response.json({choices:[{message:{role:'assistant',content:classifier?'{"intent":"single_order","scheduled":false,"collaborative":false}':'选一杯饮品'}}]});
  }
  if(String(url).includes('/auth/'))return Response.json({code:0,tenant_access_token:'mock',expire:7200});
  if(String(url).includes('/cardkit/')){updates++;return Response.json({code:0,data:{card_id:'mock-card'}});}
  if(String(url).includes('/im/v1/messages')){sent.push(body);return Response.json({code:0,data:{message_id:'mock-message'}});}
  if(String(url).includes('/members'))return Response.json({code:0,data:{items:[]}});
  throw new Error(`Unexpected HTTP in test: ${new URL(url).pathname}`);
};
const {app,orderUi}=await import('../src/server.js');
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const url=`http://127.0.0.1:${server.address().port}/feishu/events`;
const waitFor=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('background action did not finish');};
const post=async(body)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);const text=await r.text();return text?JSON.parse(text):null;};
test('真实HTTP消息入口只发送交互卡片，orderui表单回调不会落入拼单',async()=>{
  try {
    await post({header:{event_id:'test-event',event_type:'im.message.receive_v1'},event:{sender:{sender_id:{open_id:'u'}},message:{chat_id:'oc_test',chat_type:'group',message_type:'text',content:JSON.stringify({text:'来杯美式'})}}});
    await waitFor(()=>sent.length>0);assert.ok(sent.every(s=>s.msg_type==='interactive'));
    const s=orderUi.current('u','oc_test');assert.ok(s);
    const choice=[...s.choices].find(([,c])=>c.type==='productSearch')[0];
    const before=updates;
    const ack=await post({header:{event_type:'card.action.trigger'},event:{operator:{open_id:'u'},context:{open_chat_id:'oc_test'},action:{value:{action:'orderui',ui_id:s.id,revision:s.revision,choice},form_value:{query:'拿铁'}}}});
    assert.equal(ack.toast.type,'info');await waitFor(()=>updates>before);
    assert.equal(toolCalls.at(-1).name,'searchProductForMcp');assert.equal(toolCalls.at(-1).arguments.query,'拿铁');
    assert.equal(sent.length,1,'same card must update, not send another text/card each click');
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));globalThis.fetch=rawFetch;}
});
