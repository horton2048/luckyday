import test from "node:test";
import assert from "node:assert/strict";
import { FIND_NEARBY_SHOP_TOOL, RESOLVE_PLACE_TOOL, findNearbyShops, getAmapMcpConfig, resolvePlace } from "../src/maps.js";

test("高德 MCP 配置使用官方 streamable endpoint 且不泄露 key 到日志对象", () => {
  const config = getAmapMcpConfig({ AMAP_MAPS_API_KEY: "demo-key", AMAP_MCP_URL: "https://mcp.amap.com/mcp" });
  assert.equal(config.toolPrefix, "maps_");
  assert.equal(new URL(config.url).searchParams.get("key"), "demo-key");
  assert.equal(FIND_NEARBY_SHOP_TOOL.function.name, "findNearbyShop");
  assert.equal(RESOLVE_PLACE_TOOL.function.name, "resolvePlace");
});

test("地址问法可以通过地点解析工具返回高德 POI", async () => {
  const result = await resolvePlace({
    query: "融中心A座",
    city: "北京",
    mapCall: async (name) => name === "maps_text_search" ? {
      pois: [{ name: "融中心A座", address: "太阳宫地区七圣中街12号", location: "116.435815,39.971212" }],
    } : {},
  });
  assert.equal(result.matches[0].name, "融中心A座");
  assert.match(result.matches[0].address, /七圣中街/);
});

test("位置语义先检索POI，地理编码兜底，按真实坐标距离返回门店", async () => {
  const calls = [];
  const result = await findNearbyShops({
    place: "国贸三期",
    city: "北京",
    mapCall: async (name, args) => {
      calls.push(["map", name, args]);
      return { return: [{ location: "116.46,39.91", city: "北京市", level: "兴趣点" }] };
    },
    shopCall: async (name, args) => {
      calls.push(["shop", name, args]);
      return {
        data: [
          { deptId: 2, deptName: "较远营业店", longitude: 116.50, latitude: 39.91, distance: 4.2, workStatus: "营业中" },
          { deptId: 1, deptName: "最近打烊店", longitude: 116.461, latitude: 39.91, distance: 0.1, workStatus: "打烊中" },
          { deptId: 3, deptName: "近处营业店", longitude: 116.462, latitude: 39.91, distance: 0.2, workStatus: "营业中" },
        ],
      };
    },
  });
  assert.deepEqual(calls[0], ["map", "maps_text_search", { keywords: "国贸三期", city: "北京" }]);
  assert.equal(calls[2][1], "queryShopList");
  assert.deepEqual(calls[2][2], { longitude: 116.46, latitude: 39.91 });
  assert.equal(result.nearest.deptId, 1);
  assert.equal(result.shops[1].deptId, 3);
});

test("没有地点或最近定位时返回补充定位提示", async () => {
  const result = await findNearbyShops({ mapCall: async () => ({}), shopCall: async () => ({}) });
  assert.equal(result.needsLocation, true);
});

test('北京东升科技园使用POI详情坐标，不接受错误村庄坐标',async()=>{
  const calls=[];
  const result=await findNearbyShops({place:'北京东升科技园',mapCall:async(name,args)=>{
    calls.push(name);
    if(name==='maps_text_search')return {pois:[{id:'B000A8XGV2',name:'中关村东升科技园',address:'西小口路66号'}]};
    if(name==='maps_search_detail')return {location:'116.358199,40.044056',name:'中关村东升科技园',address:'西小口路66号'};
    throw new Error('应直接使用POI，不能调用可能返回房山村庄的geo');
  },shopCall:async(name,args)=>{
    assert.equal(args.longitude,116.358199);
    return {data:[{deptId:100,deptName:'园区店',longitude:116.359,latitude:40.044,distance:1000},
      {deptId:101,deptName:'远店',longitude:116.43,latitude:39.97,distance:0},
      {deptId:102,deptName:'未知距离店',distance:null}]};
  }});
  assert.deepEqual(calls,['maps_text_search','maps_search_detail']);
  assert.deepEqual(result.shops.map(s=>s.deptId),[100]);
});

test('查不到POI且geo只有城市或村庄时拒绝猜测',async()=>{
  const result=await findNearbyShops({place:'未知园区',mapCall:async(name)=>name==='maps_geo'?{results:[{location:'116.35,40.04',level:'村庄'}]}:{pois:[]},shopCall:async()=>{assert.fail('不应按错误坐标查店');}});
  assert.ok(result.error);
});
