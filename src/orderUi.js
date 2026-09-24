import { randomUUID } from 'node:crypto';
import { assertTaskActive } from './taskContext.js';
import { bestStoreMatch, rankStoreMatches, selectionIndex } from './storeResolver.js';
import { productRow } from './productImages.js';

const DEFAULT_SHOP = { deptId: 603443, deptName: '西大望路平乐园店', longitude: 116.477017, latitude: 39.886502 };
const plain = content => ({ tag: 'plain_text', content: String(content) });
const md = content => ({ tag: 'markdown', content });
const escape = value => String(value ?? '').replace(/[\\*_`<>\[\]]/g, '');
const money = value => value != null && String(value).trim() && Number.isFinite(Number(value)) ? `¥${Number(value).toFixed(2)}` : '待报价';
export const selectedSpecs = product => (product.productAttrs ?? []).flatMap(a => (a.productSubAttrs ?? []).filter(s => s.selected).map(s => s.attributeName)).join(' / ');
const success = r => r && !r.error && r.success !== false && (r.code == null || Number(r.code) === 0) && r.data != null;
const beijingTime = value => new Date(new Date(value).getTime()+8*60*60*1000).toISOString().slice(0,16).replace('T',' ')+'（北京时间）';
const beijingInputTime = value => new Date(new Date(value).getTime()+8*60*60*1000).toISOString().slice(0,16).replace('T',' ');
const signature = items => JSON.stringify(items.map(i => ({ productId:i.productId, skuCode:i.skuCode, amount:i.amount })));
const scheduleRequest = text => /预约|预定|预订|定时|明天|后天|下周|稍后|等会|到点|(?:上午|中午|下午|今晚).{0,5}(?:\d|一|二|三|四|五|六|七|八|九|十)点?/u.test(String(text ?? ''));
const normalizeScheduleHint = (value, now) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)
    ? new Date(raw.replace(' ','T')+':00+08:00')
    : new Date(raw);
  return Number.isFinite(at.getTime()) && at.getTime() >= now-2*60*1000 ? at.toISOString() : null;
};

export function toolEvidence(history) {
  const calls = new Map(); const evidence = [];
  for (const m of history) {
    for (const c of m.tool_calls ?? []) calls.set(c.id, c.function);
    if (m.role !== 'tool') continue;
    try {
      const c = calls.get(m.tool_call_id); const result = JSON.parse(m.content);
      if (c && (success(result) || c.name === 'findNearbyShop')) evidence.push({ name:c.name, args:JSON.parse(c.arguments), data:result.data, result });
    } catch {}
  }
  return evidence;
}

// All button payloads refer to server-owned choices; the client never supplies order arguments.
export function createOrderUi({ call, publish, pay, schedule, prepareImages = async () => {}, now = Date.now, defaultShop = null, onShopSelected = null, getShopContext = () => ({}), onShopReady = null, resolveShops = null }) {
  const states = new Map(); const byOwner = new Map();
  const key = (ownerId,chatId) => `${ownerId}:${chatId}`;
  const suppliedShop = requested => ({...DEFAULT_SHOP,...(requested??defaultShop??{})});
  const valid = s => s && now() - s.touched < 30*60*1000;
  function current(ownerId,chatId) { const s=states.get(byOwner.get(key(ownerId,chatId))); return valid(s)?s:null; }
  function prune() { for(const [id,s] of states) if(!valid(s)&&!s.busy) {states.delete(id); if(byOwner.get(key(s.ownerId,s.chatId))===id)byOwner.delete(key(s.ownerId,s.chatId));} }
  async function invoke(name,args) {
    assertTaskActive(); const r=await call(name,args); assertTaskActive();
    if(!success(r)) throw new Error(r?.msg || r?.message || '门店接口暂时不可用，请点击重试');
    return r;
  }
  const clearQuote = s => {s.quote=null; if(s.screen==='confirm')s.screen='cart';};
  async function detail(s,productId) {
    const p=(await invoke('queryProductDetailInfo',{deptId:s.shop.deptId,productId})).data;
    return {...p,pictureUrl:p.pictureUrl || s.products.find(item=>String(item.productId)===String(productId))?.pictureUrl};
  }
  function requireShop(s) {if(s.storeSelectionPending){s.screen='shops';throw new Error('请先选择取餐门店，再查看饮品或下单');}}
  async function search(s,query) {
    requireShop(s);
    s.query=query; s.products=[]; s.screen='products';
    const r=await invoke('searchProductForMcp',{deptId:s.shop.deptId,query});
    s.products=Array.isArray(r.data)?r.data:[]; s.page=0;
    if(!s.products.length)s.notice='当前门店没有找到这款，可以点下面的分类换一杯。';
  }
  async function shops(s,query='') {
    s.screen='shops'; s.shops=[];
    if(query && resolveShops) {
      const result=await resolveShops(s,query);
      s.shops=result.shops ?? [];s.notice=result.error ?? '';s.page=0;return;
    }
    const r=await invoke('queryShopList',{longitude:Number(s.shop.longitude)||DEFAULT_SHOP.longitude,latitude:Number(s.shop.latitude)||DEFAULT_SHOP.latitude,...(query?{deptName:query}:{})});
    s.shops=Array.isArray(r.data)?r.data:[]; s.page=0;
    if(!s.shops.length)s.notice='没有找到门店，可在卡片内换个名称搜索。';
  }
  async function applyShop(s, p) {
    if (!p || p.deptId == null) throw new Error('门店选项已失效');
    s.shop={...p};s.shopSource='explicit';s.storeSelectionPending=false;
    await onShopSelected?.(s.ownerId,s.chatId,s.shop);
    s.cart=[];clearQuote(s);s.products=[];s.notice='已换门店，重新选择本店饮品和规格。';
    try {await search(s,s.query||'新品');} catch(e) {s.notice=`已选定${s.shop.deptName}，菜单暂未加载成功，请重试。`;s.screen='products';}
  }
  async function finishShopSelection(s) {
    const continuation=s.shopContinuation;s.shopContinuation=null;
    if(continuation)await onShopReady?.(s.ownerId,s.chatId,continuation);
  }
  async function switchAttr(s,index,attrId,subId) {
    const item=s.cart[index]; if(!item)throw new Error('饮品已变化，请重新选择');
    const attr=item.productAttrs?.find(a=>String(a.attributeId)===String(attrId));
    const sub=attr?.productSubAttrs?.find(a=>String(a.attributeId)===String(subId));
    if(!sub || sub.canSelected===0 || sub.canSelected===false)throw new Error('该规格当前不可选');
    clearQuote(s);
    const r=await invoke('switchProduct',{deptId:s.shop.deptId,productId:item.productId,skuCode:item.skuCode,amount:item.amount,attrOperationParam:{attributeId:attr.attributeId,subAttr:{attributeId:sub.attributeId,operation:1}}});
    const updated=r.data;
    const verified=updated.productAttrs?.find(a=>String(a.attributeId)===String(attrId))?.productSubAttrs?.find(a=>String(a.attributeId)===String(subId)&&a.selected);
    if(!updated.skuCode || !verified)throw new Error('门店没有确认该规格，已保留原选择，请换一种规格');
    s.cart[index]={...updated,pictureUrl:updated.pictureUrl || item.pictureUrl,amount:item.amount,verified:true};
  }
  async function quote(s) {
    clearQuote(s);requireShop(s);
    if(!s.cart.length)throw new Error('请先选择一杯饮品');
    if(s.needsSchedule&&!s.scheduleAt){s.screen='schedule';throw new Error('请先在卡片内设置预约时间，避免误按现在下单');}
    const unverified=s.cart.findIndex(i=>!i.verified);
    if(unverified>=0){s.screen='specs';s.item=unverified;throw new Error('请先核对这杯的规格，再查看报价');}
    const args={deptId:s.shop.deptId,productList:s.cart.map(i=>({productId:i.productId,skuCode:i.skuCode,amount:i.amount}))};
    const result=await invoke('previewOrder',args);
    const price=result.data.discountPrice ?? result.data.totalPrice ?? result.data.price;
    if(money(price)==='待报价')throw new Error('尚未取得有效价格，请点击重新报价');
    if(Array.isArray(result.data.couponCodeList))args.couponCodeList=[...result.data.couponCodeList];
    s.quote={args,result,price,at:now(),signature:signature(s.cart)};s.screen='confirm';
  }
  function render(s) {
    s.choices=new Map(); let choice=0;
    const action=(type,payload={})=>{const id=String(++choice);s.choices.set(id,{type,...payload});return {action:'orderui',ui_id:s.id,revision:s.revision,choice:id};};
    const button=(label,type,payload={},primary=false)=>({tag:'button',text:plain(label),type:primary?'primary':'default',behaviors:[{type:'callback',value:action(type,payload)}]});
    // 手机端优先：使用 flow + fill，让按钮在窄屏自动纵向排列；桌面端仍保持清晰的整行按钮。
    const row=buttons=>({tag:'column_set',flex_mode:'flow',horizontal_spacing:'8px',columns:buttons.map(b=>({tag:'column',width:'fill',elements:[b]}))});
    const form=(label,type,placeholder)=>({tag:'form',name:`search_${type}`,elements:[{tag:'input',name:'query',placeholder:plain(placeholder),max_length:150},{tag:'button',name:'submit',text:plain(label),type:'primary',action_type:'form_submit',value:action(type)}]});
    const drinkSummary=item=>productRow(item,[md(`**${escape(item.productName)} × ${item.amount}**\n${escape(selectedSpecs(item))||'门店默认规格'}${!item.verified?'\n请核对规格':''}`)]);
    const elements=[md(s.storeSelectionPending
      ? '**取餐门店：待选择**\n请先从下面的真实门店中选择一家。'
      : `**取餐门店：${escape(s.shop.deptName)}**${s.shop.deptAddress||s.shop.address?`\n${escape(s.shop.deptAddress||s.shop.address)}`:''}`)];
    if(s.notice)elements.push(md(escape(s.notice)));
    if(s.screen==='cancelled') {
      elements.push(md('本次点单已退出，没有创建订单。需要时可以重新打开点单卡。'),button('重新点单','new',{},true));
    } else if(s.screen==='scheduled') {
      elements.push(...s.cart.map(drinkSummary));
      elements.push(md(`已预约：${escape(beijingTime(s.scheduleAt))}\n到点将重新核价；价格变化会先发卡片请你确认。`),button('再点一单','new'));
    } else if(s.screen==='done') {
      elements.push(...s.cart.map(drinkSummary));
      elements.push(md(`订单已创建。订单号：${escape(s.result?.data?.orderIdStr??s.result?.data?.orderId??'已生成')}。请查看支付卡片完成支付。`));
      if(s.paymentRetry)elements.push(button('重发支付卡','payment',{},true));
      elements.push(button('再点一单','new'));
    } else if(s.screen==='uncertain') {
      elements.push(md('订单请求已发出，但暂时无法确认结果。为避免重复下单，本卡已暂停提交，请先核对订单状态。'));
    } else {

      if(s.screen==='schedule') {
        const current = beijingInputTime(now());
        const plus30 = beijingInputTime(now()+30*60*1000);
        const plus60 = beijingInputTime(now()+60*60*1000);
        elements.push(
          md(`**选择预约时间**\n默认时间：${current}（北京时间）`),
          row([button('按当前时间','scheduleSet',{query:current,immediate:true},true),button('30分钟后','scheduleSet',{query:plus30}),button('1小时后','scheduleSet',{query:plus60})]),
          {tag:'form',name:'schedule_time',elements:[{tag:'picker_datetime',name:'query',initial_datetime:current,placeholder:plain('选择北京时间')},{tag:'button',name:'submit',text:plain('使用这个时间'),type:'primary',action_type:'form_submit',value:action('scheduleSet')}]},
        );
      } else if(s.screen==='shops') {
        for(const p of s.shops.slice(s.page*6,s.page*6+6)) {
          const distance=p.distanceMeters!=null?` · ${p.distanceMeters}米`:p.distanceKm!=null?` · ${p.distanceKm}公里`:'';
          const address=p.deptAddress||p.address||'地址待确认';
          elements.push(md(`**${escape(p.deptName||`门店${p.deptId}`)}**${distance}${p.workStatus?` · ${escape(p.workStatus)}`:''}\n${escape(address)}`),button(`选择${p.deptName||`门店${p.deptId}`}`,'shop',{deptId:p.deptId}));
        }
        if(s.shops.length>6)elements.push(button('下一组门店','page',{list:'shops'}));
        elements.push(form('搜索门店','shopSearch','输入门店名称，直接在卡片内搜索'));
      } else if(s.screen==='products'||s.screen==='home') {
        for(const p of s.products.slice(s.page*6,s.page*6+6))elements.push(productRow(p,[button(`${p.productName} · ${money(p.estimatePrice??p.initialPrice)}（参考价）`,'product',{productId:p.productId})]));
        if(s.products.length>6)elements.push(button('换一组推荐','page',{list:'products'}));
        for(const query of ['新品','美式','拿铁','非咖啡'])elements.push(button(query,'search',{query}));
        elements.push(form('搜索饮品','productSearch','想喝什么？在这里搜索'));
      } else if(s.screen==='specs'&&s.cart[s.item]) {
        const item=s.cart[s.item];
        elements.push(drinkSummary(item),button('确认规格，查看订单','specDone',{index:s.item},true));
        for(const attr of item.productAttrs??[]) {
          const subs=(attr.productSubAttrs??[]).filter(x=>x.canSelected!==0&&x.canSelected!==false);
          if(subs.length<2)continue;
          elements.push(md(`**${escape(attr.attributeName)}**`));
          for(let offset=0;offset<subs.length;offset+=3)elements.push(row(subs.slice(offset,offset+3).map(sub=>button(`${sub.selected?'✓ ':''}${sub.attributeName}`,'attr',{index:s.item,attrId:attr.attributeId,subId:sub.attributeId},false))));
        }
        elements.push(row([button('− 一杯','quantity',{index:s.item,amount:Math.max(1,item.amount-1)}),button('＋ 一杯','quantity',{index:s.item,amount:Math.min(20,item.amount+1)}),button('移除这杯','remove',{index:s.item})]));
      } else {
        if(!s.cart.length)elements.push(md('还没有饮品，点“选饮品”开始。'));
        for(const [index,item]of s.cart.entries())elements.push(drinkSummary(item),button('调整规格 / 数量','specs',{index}));
        if(s.quote) {
          elements.push(md(`**预计应付：${money(s.quote.price)}**\n已按当前门店、规格、数量计算优惠。`));
          const b=button(s.scheduleAt?'确认预约':'确认并生成支付码','confirm',{},true);
          b.confirm={title:plain(s.scheduleAt?'确认预约？':'确认生成支付码？'),text:plain(`${s.shop.deptName}，${money(s.quote.price)}。${s.scheduleAt?`预约时间 ${beijingTime(s.scheduleAt)}`:'确认后创建订单。'}`)};elements.push(b);
        } else if(s.cart.length)elements.push(button('查看优惠后总价','quote',{},true));
        elements.push(button('继续加饮品','products'));
        if(schedule&&s.cart.length)elements.push(button(s.scheduleAt?'修改预约时间':'预约时间','schedule'));
        if(s.scheduleAt)elements.push(md(`预约：${escape(beijingTime(s.scheduleAt))}`),button('改为现在下单','scheduleClear'));
      }
    }
    if(!s.storeSelectionPending&&!['done','scheduled','uncertain','cancelled'].includes(s.screen))elements.push({tag:'hr'},row([button('换门店','shops'),button('选饮品 / 换推荐','products'),button(`购物车（${s.cart.reduce((n,i)=>n+i.amount,0)}杯）`,'cart')]));
    if(!['done','scheduled','uncertain','cancelled'].includes(s.screen))elements.push(button('退出点单','cancel'));
    const titles={shops:'选择取餐门店',products:'选择饮品',home:'选择饮品',specs:'确认饮品规格',cart:'购物车',confirm:'订单确认',schedule:'设置预约时间',scheduled:'预约成功',done:'订单已创建',uncertain:'订单状态待核对',cancelled:'已退出点单'};
    const timed = Boolean(s.needsSchedule || s.scheduleAt);
    const title = timed ? 'LuckyDay · 定时下单' : `LuckyDay · ${titles[s.screen]||'点单'}`;
    const subtitle = timed ? '先选饮品和门店，再确认预约时间；到点自动重新核价' : (s.screen==='confirm'?'请核对门店、饮品、数量和应付金额':'选择饮品 → 确认规格 → 订单确认');
    return {schema:'2.0',config:{width_mode:'fill',update_multi:true,enable_forward:false},header:{template:'blue',title:plain(title),subtitle:plain(subtitle)},body:{padding:'12px 12px 12px 12px',elements}};
  }
  async function show(s) {
    const wasBusy=s.busy;s.busy=true;
    try {
      const visible=['products','home'].includes(s.screen)?s.products.slice(s.page*6,s.page*6+6):s.screen==='specs'?[s.cart[s.item]].filter(Boolean):s.cart;
      await prepareImages(visible);
      assertTaskActive();s.revision++;s.touched=now();await publish(s,render(s));s.deliveryFailed=false;
      console.log('[orderui]',JSON.stringify({phase:'published',id:s.id,revision:s.revision,screen:s.screen,notice:s.notice||null}));
    } catch(e) {s.deliveryFailed=true;throw e;}
    finally {s.busy=wasBusy;}
  }
  async function start({ownerId,chatId,history=[],previewOrder=null,userText='',notice='',forceSchedule=false,scheduledAtHint=null,defaultShop:requestedDefaultShop=null,shopCandidates=null,shopNotice='',shopContinuation=null}) {
    prune();let s=current(ownerId,chatId);
    const context=getShopContext(ownerId,chatId);
    const preferredShop=suppliedShop(context.shop ?? requestedDefaultShop);
    if(context.pending && shopCandidates===null) {
      shopCandidates=context.pending.candidates ?? [];
      shopNotice=context.pending.notice || '请先选择你提到的位置附近的门店。';
      shopContinuation=context.pending.continuation;
    }
    // A saved default can change while an old menu card is still alive. Reusing
    // that state would keep rendering and quoting against the previous store.
    // Explicitly selected stores remain sticky for the current order; default
    // sourced states are safe to replace when the preference changes.
    if(s && !previewOrder && s.shopSource==='default' && String(s.shop.deptId)!==String(preferredShop.deptId)) {
      const oldId=s.id;
      states.delete(oldId); s=null;
      if(byOwner.get(key(ownerId,chatId))===oldId)byOwner.delete(key(ownerId,chatId));
    }
    if(!s||['done','uncertain','scheduled','cancelled'].includes(s.screen)){
      s={id:randomUUID(),ownerId,chatId,shop:preferredShop,shopSource:context.shop?'explicit':'default',cart:[],products:[],shops:[],page:0,screen:'home',revision:0,touched:now()};
      states.set(s.id,s);byOwner.set(key(ownerId,chatId),s.id);
    }
    clearQuote(s);s.notice=notice;s.busy=true;
    if(Array.isArray(shopCandidates)) {
      s.shops=shopCandidates.filter(p=>p&&p.deptId!=null);s.cart=[];s.products=[];
      s.screen='shops';s.page=0;s.storeSelectionPending=true;s.shopContinuation=shopContinuation;
      s.notice=shopNotice||'请选择取餐门店，选定后再继续。';s.busy=false;
      await show(s);return s;
    }
    if(s.storeSelectionPending) {s.busy=false;s.screen='shops';await show(s);return s;}
    if(forceSchedule || (schedule&&scheduleRequest(userText)))s.needsSchedule=true;
    if(forceSchedule && scheduledAtHint) s.scheduleAt=normalizeScheduleHint(scheduledAtHint, now());
    try {
      const evidence=toolEvidence(history);
      const shopResult=evidence.filter(e=>e.name==='queryShopList').at(-1);
      const nearbyResult=evidence.filter(e=>e.name==='findNearbyShop').at(-1);
      const evidenceShops = [
        ...(Array.isArray(shopResult?.data) ? shopResult.data : []),
        ...(Array.isArray(nearbyResult?.result?.shops) ? nearbyResult.result.shops : []),
      ];
      if(evidenceShops.length) {
        const seen=new Set();
        s.shops=evidenceShops.filter(p=>{const id=String(p.deptId);if(seen.has(id))return false;seen.add(id);return true;});
      }
      if(previewOrder) {
        const deptId=previewOrder.args.deptId;
        const shop=s.shops.find(p=>String(p.deptId)===String(deptId));
        if(String(s.shop.deptId)!==String(deptId)) {
          if(s.shopSource==='explicit' || context.shop)throw new Error('报价门店与已选门店不一致，已拦截，请按当前门店重新报价');
          // Recommendation cards carry a server-verified shop. Use it directly
          // when it matches the requested default so an old UI state cannot
          // block the handoff with a false "select a real shop" error.
          const preferred = String(preferredShop.deptId)===String(deptId) ? preferredShop : null;
          if(!shop&&!preferred)throw new Error('请先选择真实门店，再为你准备订单');
          s.shop=preferred??shop;
          s.shopSource='explicit';
        } else if(String(preferredShop.deptId)===String(deptId) && s.shopSource==='default') {
          s.shop=preferredShop;
        }
        s.cart=[];
        for(const item of previewOrder.args.productList??[]) {
          if(s.cart.length>=20)throw new Error('一单最多支持20种规格，请分单选择');
          if(!Number.isInteger(item.amount)||item.amount<1||item.amount>20)throw new Error('每款数量需在1到20杯之间');
          let verifiedProduct;
          for(const e of evidence.filter(e=>String(e.args.deptId)===String(deptId)&&['queryProductDetailInfo','switchProduct','searchProductForMcp'].includes(e.name))) {
            for(const p of Array.isArray(e.data)?e.data:[e.data])if(p.skuCode===item.skuCode&&String(p.productId)===String(item.productId)&&p.productAttrs?.length)verifiedProduct=p;
          }
          const p=verifiedProduct??await detail(s,item.productId);
          s.cart.push({...p,amount:item.amount,verified:p.skuCode===item.skuCode});
        }
        // A single drink with an explicit temperature is selected via the actual menu attributes.
        if(s.cart.length===1) {
          const requested=/去冰/.test(userText)?'去冰':/少冰/.test(userText)?'少冰':/热/.test(userText)?'热':/冰/.test(userText)?'冰':null;
          if(requested) {
            const attr=s.cart[0].productAttrs?.find(a=>a.attributeName==='温度');
            const sub=attr?.productSubAttrs?.find(a=>a.attributeName===requested&&a.canSelected!==0);
            if(!sub){s.cart[0].verified=false;s.notice=`门店没有提供“${requested}”，请在卡片中选择实际可用规格。`;}
            else if(!sub.selected)await switchAttr(s,0,attr.attributeId,sub.attributeId);
          }
        }
        s.screen='cart';
        if(s.cart.every(i=>i.verified))await quote(s);
        else {s.screen='specs';s.item=s.cart.findIndex(i=>!i.verified);s.notice||='已载入门店默认规格，请核对后再报价。';}
      } else {
        if(Array.isArray(shopCandidates)) {
          s.shops=shopCandidates.filter(p=>p&&p.deptId!=null);
          s.screen='shops';s.page=0;s.storeSelectionPending=true;
          s.notice=shopNotice || notice || '我找到这些附近门店，请选择一家；选定后下单会一直使用这家店。';
        } else {
        const productResult=evidence.filter(e=>e.name==='searchProductForMcp'&&String(e.args.deptId)===String(s.shop.deptId)).at(-1);
        s.products=Array.isArray(productResult?.data)?productResult.data:[];
        s.screen=(shopResult||nearbyResult)&&/店|门店|瑞幸|取餐/.test(userText)?'shops':'products';s.page=0;
        if(!s.products.length&&s.screen==='products')await search(s,'新品');
        }
      }
    } catch(e) {s.notice=e.message;clearQuote(s);} finally{s.busy=false;}
    if(forceSchedule && !s.scheduleAt){clearQuote(s);s.screen='schedule';s.notice='请先设置预约时间，再选择饮品并确认预约。';}
    else if(forceSchedule && s.scheduleAt){s.screen=s.quote?'cart':'schedule';s.notice='已按你的要求准备好订单，请确认预约时间和订单内容。';}
    else if(schedule&&!s.scheduleAt&&s.cart.length&&scheduleRequest(userText)){clearQuote(s);s.screen='schedule';s.notice='请先在卡片内确认具体预约时间，避免误按现在下单。';}
    await show(s);return s;
  }
  async function selectShop(ownerId,chatId,text) {
    const s=current(ownerId,chatId);
    if(!s || !s.storeSelectionPending) return { error:'当前没有等待确认的附近门店。' };
    const value=String(text??'').trim();
    const index=selectionIndex(value);
    let p=index!=null ? s.shops[index-1] : bestStoreMatch(value,s.shops);
    if(!p) {
      const matches=rankStoreMatches(value,s.shops,{limit:3}).filter(x=>x.score>0).map(x=>x.shop);
      return { error:'我没能唯一对应到你说的门店，请回复序号或完整门店名。',matches };
    }
    s.busy=true;
    try { await applyShop(s,p); await show(s); await finishShopSelection(s);return { shop:s.shop, state:s }; }
    finally { s.busy=false; }
  }
  async function setShop(ownerId,chatId,shop,notice='已换到这家门店，后续菜单、报价和下单都会固定使用它。') {
    let s=current(ownerId,chatId);
    if(!s) {
      await start({ownerId,chatId,defaultShop:shop,shopCandidates:[shop]});
      s=current(ownerId,chatId);
    }
    if(!s) throw new Error('点单卡暂时没有打开');
    s.busy=true;
    try { await applyShop(s,shop); s.notice=notice; await show(s); return s; }
    finally { s.busy=false; }
  }
  function claim(value,ownerId,chatId) {
    const s=states.get(value.ui_id);
    if(!s||!valid(s))return {error:'这张卡片已过期，正在为你打开新的点单卡。',expired:true};
    if(s.ownerId!==ownerId||s.chatId!==chatId)return {error:'这张卡片不属于你，请使用自己的点单卡。'};
    if(s.busy)return {error:'正在更新，请稍候。'};
    if(s.deliveryFailed){s.busy=true;return {s,choice:{type:'refresh'},revision:s.revision};}
    if(Number(value.revision)!==s.revision)return {error:'正在同步最新卡片，请稍候再操作。',stale:true,s};
    const choice=s.choices.get(String(value.choice));if(!choice)return {error:'该选项已失效。'};
    s.busy=true;return {s,choice,revision:s.revision};
  }
  async function perform(ticket,form={}) {
    const {s,choice:c}=ticket;s.notice='';
    console.log('[orderui]',JSON.stringify({phase:'action',id:s.id,revision:s.revision,action:c.type,screen:s.screen}));
    if(ticket.revision!==s.revision){s.busy=false;return s;}
    try {
      if(s.storeSelectionPending&&!['shops','shopSearch','shop','page','cancel','refresh'].includes(c.type))requireShop(s);
      if(c.type==='shops')await shops(s);
      else if(c.type==='shopSearch')await shops(s,String(form.query??'').trim().slice(0,150));
      else if(c.type==='shop') {
        const p=s.shops.find(p=>String(p.deptId)===String(c.deptId));
        await applyShop(s,p);
      } else if(c.type==='products')await search(s,s.query||'新品');
      else if(c.type==='search'||c.type==='productSearch')await search(s,c.query||String(form.query??'').trim().slice(0,150)||'新品');
      else if(c.type==='page')s.page=(s.page+1)%Math.max(1,Math.ceil(s[c.list].length/6));
      else if(c.type==='product') {
        if(!s.products.some(p=>String(p.productId)===String(c.productId)))throw new Error('饮品已失效');
        if(s.cart.length>=20)throw new Error('一单最多20种规格，请先移除部分饮品');
        const p=await detail(s,c.productId);s.cart.push({...p,amount:1,verified:true});s.item=s.cart.length-1;s.screen='specs';clearQuote(s);
      } else if(c.type==='cart'){s.screen='cart';}
      else if(c.type==='schedule'){s.screen='schedule';}
      else if(c.type==='scheduleClear'){s.scheduleAt=null;s.needsSchedule=false;s.screen='cart';}
      else if(c.type==='scheduleSet') {
        const raw=String(form.query??c.query??'').trim();
        if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw))throw new Error('请填写 YYYY-MM-DD HH:mm 格式的北京时间');
        const at=new Date(raw.replace(' ','T')+':00+08:00');
        if(!Number.isFinite(at.getTime())||new Date(at.getTime()+8*60*60*1000).toISOString().slice(0,16).replace('T',' ')!==raw||at.getTime()<now()-2*60*1000)throw new Error('请选择当前或未来的预约时间');
        s.scheduleImmediate=c.immediate===true;s.scheduleAt=at.toISOString();s.needsSchedule=false;clearQuote(s);s.screen='cart';
      }
      else if(c.type==='specs'){s.screen='specs';s.item=c.index;}
      else if(c.type==='attr')await switchAttr(s,c.index,c.attrId,c.subId);
      else if(c.type==='quantity'){s.cart[c.index].amount=c.amount;clearQuote(s);}
      else if(c.type==='remove'){s.cart.splice(c.index,1);clearQuote(s);s.screen='cart';}
      else if(c.type==='specDone'){s.cart[c.index].verified=true;s.screen='cart';await quote(s);}
      else if(c.type==='quote')await quote(s);
      else if(c.type==='confirm') {
        const old=s.quote;if(!old||String(old.args.deptId)!==String(s.shop.deptId)||old.signature!==signature(s.cart))throw new Error('订单已变化，请重新报价');
        await quote(s);
        if(Number(old.price)!==Number(s.quote.price)){s.notice='价格发生变化，请核对新价格后再次确认。';}
        else if(s.scheduleAt) {
          if(s.scheduleImmediate)s.scheduleAt=new Date(now()+1000).toISOString();
          if(new Date(s.scheduleAt).getTime()<=now())throw new Error('预约时间已过，请重新选择时间');
          await schedule({...s.quote.args,executeAt:s.scheduleAt,authorizedPrice:s.quote.price,chatId:s.chatId,userId:s.ownerId,summary:s.cart.map(i=>`${i.productName} ${selectedSpecs(i)} ×${i.amount}`).join('、')});
          s.screen='scheduled';
        } else {
          // Once createOrder starts, uncertainty must never reopen the same submit button.
          s.screen='uncertain';
          const result=await invoke('createOrder',s.quote.args);
          s.result=result;s.screen='done';
          try{await pay(s,result);}catch{ s.notice='订单已创建，支付卡发送失败，可点击重发支付卡。';s.paymentRetry=true; }
        }
      } else if(c.type==='payment'){await pay(s,s.result);s.paymentRetry=false;}
      else if(c.type==='cancel'){s.cart=[];s.scheduleAt=null;s.needsSchedule=false;clearQuote(s);s.screen='cancelled';}
      else if(c.type==='new'){s.cart=[];s.scheduleAt=null;s.needsSchedule=false;clearQuote(s);await search(s,'新品');}
    } catch(e){s.notice=e.message;if(s.screen!=='uncertain'&&s.screen!=='done')clearQuote(s);}
    finally{s.busy=false;}
    await show(s);if(c.type==='shop'&&!s.storeSelectionPending)await finishShopSelection(s);return s;
  }
  async function recover(s,notice='刚才更新超时，请在卡片中继续操作。') {s.busy=false;s.notice=notice;await show(s);return s;}
  async function cancel(ownerId,chatId) { const s=current(ownerId,chatId); if(!s)return null; s.busy=false;s.cart=[];s.scheduleAt=null;s.needsSchedule=false;clearQuote(s);s.screen='cancelled';await show(s);return s; }
  async function updateDefault(ownerId, shop, notice='默认门店已更新，旧购物车和报价已清空。') {
    prune(); let count=0;
    for(const s of states.values()) {
      if(s.ownerId!==ownerId || !valid(s) || s.busy)continue;
      s.shop={...DEFAULT_SHOP,...(shop??{})};
      s.shopSource='default';s.storeSelectionPending=false;s.shopContinuation=null; s.cart=[]; s.products=[]; s.shops=[]; s.page=0;
      s.scheduleAt=null; s.needsSchedule=false; clearQuote(s); s.screen='home'; s.notice=notice;
      await show(s); count++;
    }
    return count;
  }
  function reset(ownerId,chatId=null) {
    for(const [id,s] of states) {
      if(s.ownerId!==ownerId || (chatId!=null && s.chatId!==chatId))continue;
      states.delete(id);
      if(byOwner.get(key(s.ownerId,s.chatId))===id)byOwner.delete(key(s.ownerId,s.chatId));
    }
  }
  return {start,current,claim,perform,selectShop,setShop,render,states,recover,cancel,updateDefault,reset};
}
