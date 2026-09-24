import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductImages} from '../src/productImages.js';
import {createOrderUi} from '../src/orderUi.js';
import {buildRecoCard} from '../src/recoCards.js';

const pictures = node => {
  if (!node || typeof node !== 'object') return [];
  return [...(node.tag === 'img' ? [node.img_key] : []), ...Object.values(node).flatMap(pictures)];
};

test('图片上传合并并缓存，来源变化重新上传，失败可重试',async()=>{
  const calls=[];let now=0,fail=true;
  const prepare=createProductImages({now:()=>now,upload:async url=>{
    calls.push(url);if(url==='broken'&&fail)throw new Error('offline');return `img_${url}`;
  }});
  const a={pictureUrl:'a'},b={pictureUrl:'a'};
  await Promise.all([prepare([a]),prepare([b])]);
  assert.deepEqual(calls,['a']);assert.equal(a.imageKey,b.imageKey);
  a.pictureUrl='b';await prepare([a]);assert.equal(a.imageKey,'img_b');
  a.pictureUrl='broken';await prepare([a]);assert.equal(a.imageKey,undefined);
  await prepare([a]);assert.equal(calls.filter(c=>c==='broken').length,1);
  now=31_000;fail=false;await prepare([a]);assert.equal(a.imageKey,'img_broken');
});

test('两杯不同饮品在规格、购物车、确认中逐项带图，切换规格保留商品图且不污染下单参数',async()=>{
  let card;
  const product=id=>({productId:id,productName:`饮品${id}`,skuCode:`sku${id}`,pictureUrl:`picture${id}`,productAttrs:[{attributeId:1,attributeName:'温度',productSubAttrs:[{attributeId:2,attributeName:'冰',selected:true,canSelected:1}]}]});
  const prepare=createProductImages({upload:async url=>`img_${url}`});
  const ui=createOrderUi({prepareImages:prepare,publish:async(s,c)=>card=c,call:async(name,args)=>{
    if(name==='searchProductForMcp')return {code:0,data:[product(1),product(2)]};
    if(name==='queryProductDetailInfo')return {code:0,data:product(args.productId)};
    if(name==='switchProduct'){const p=product(args.productId);delete p.pictureUrl;return {code:0,data:p};}
    if(name==='previewOrder')return {code:0,data:{discountPrice:19.8}};
    throw new Error(`Unexpected ${name}`);
  }});
  const s=await ui.start({ownerId:'u',chatId:'c'});
  const click=async(type,match=()=>true)=>{
    const [choice]=[...s.choices].find(([,c])=>c.type===type&&match(c));
    const ticket=ui.claim({ui_id:s.id,revision:s.revision,choice},'u','c');assert.ok(!ticket.error);
    await ui.perform(ticket);
  };
  assert.deepEqual(pictures(card),['img_picture1','img_picture2']);
  await click('product',c=>c.productId===1);
  assert.equal(s.screen,'specs');assert.deepEqual(pictures(card),['img_picture1']);
  // Exercise the same switch path when the API omits its optional picture field.
  await ui.perform({s,revision:s.revision,choice:{type:'attr',index:0,attrId:1,subId:2}});
  assert.deepEqual(pictures(card),['img_picture1']);
  await click('products');await click('product',c=>c.productId===2);await click('cart');
  assert.deepEqual(pictures(card),['img_picture1','img_picture2']);
  await click('quote');assert.equal(s.screen,'confirm');
  assert.deepEqual(pictures(card),['img_picture1','img_picture2']);
  assert.deepEqual(s.quote.args.productList,[{productId:1,skuCode:'sku1',amount:1},{productId:2,skuCode:'sku2',amount:1}]);
});

test('推荐换一杯同步切换商品图，缺图也有明确占位',()=>{
  const reco={id:'r',trigger:'manual',index:0,candidates:[{name:'第一杯',imageKey:'img_1',price:10,note:'新品'},{name:'第二杯',imageKey:'img_2',price:11,note:'新品'}]};
  assert.deepEqual(pictures(buildRecoCard(reco)),['img_1']);
  reco.index=1;assert.deepEqual(pictures(buildRecoCard(reco)),['img_2']);
  delete reco.candidates[1].imageKey;
  const card=buildRecoCard(reco);
  assert.deepEqual(pictures(card),[]);assert.match(JSON.stringify(card),/图片暂不可用/);
});
