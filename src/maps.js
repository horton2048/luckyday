

export const FIND_NEARBY_SHOP_TOOL = {
  type: "function",
  function: {
    name: "findNearbyShop",
    description:
      "查找某个地点附近的真实瑞幸门店。用户说‘XX附近最近的店’、‘离我最近的瑞幸’、‘从XX去哪个店方便’等位置语义时调用。" +
      "place 填用户提到的地标、地址或商圈原话；用户只说‘离我最近’且系统有最近一次飞书定位时 place 留空。" +
      "不要把地点名直接当成瑞幸门店名，也不要凭记忆编门店 ID。",
    parameters: {
      type: "object",
      properties: {
        place: { type: "string", description: "用户提到的地标、地址或商圈；只说离我最近时可留空" },
        city: { type: "string", description: "城市名，能确定时填写，例如北京" },
        radius: { type: "number", description: "搜索半径，单位米，默认 5000，最大 10000" },
      },
      required: [],
    },
  },
};

export const RESOLVE_PLACE_TOOL = {
  type: "function",
  function: {
    name: "resolvePlace",
    description: "查询用户提到的地标、楼宇或地址，返回高德匹配的名称、详细地址和坐标。用户问‘这个地址在哪’、‘某某大厦地址是什么’时调用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "地标、楼宇或地址原话" },
        city: { type: "string", description: "城市名，能确定时填写" },
      },
      required: ["query"],
    },
  },
};

export function getAmapMcpConfig(env = process.env) {
  const key = String(env.AMAP_MAPS_API_KEY ?? "").trim();
  if (!key) return null;
  const base = String(env.AMAP_MCP_URL ?? "https://mcp.amap.com/mcp").trim();
  const url = new URL(base);
  url.searchParams.set("key", key);
  return { name: "amap", url: url.toString(), token: "", toolPrefix: "maps_" };
}

export async function resolvePlace({ query, city = "", mapCall }) {
  const text = String(query ?? "").trim();
  if (!text) return { error: "缺少要查询的地点名称。" };
  const result = await mapCall("maps_text_search", { keywords: text, ...(city ? { city: String(city).trim() } : {}) });
  const pois = Array.isArray(result?.pois) ? result.pois.slice(0, 5) : [];
  if (pois.length) return { query: text, city: city || undefined, matches: pois };
  const geo = await mapCall("maps_geo", { address: text, ...(city ? { city: String(city).trim() } : {}) });
  const origin = firstGeo(geo);
  return origin ? { query: text, city: city || undefined, matches: [{ name: text, address: origin.address, location: `${origin.longitude},${origin.latitude}`, level: origin.level }] } : { query: text, matches: [] };
}

function firstGeo(result) {
  // 高德 MCP 不同版本分别返回 return、results 或 geocodes；线上当前版本使用 results。
  const rows = result?.return ?? result?.results ?? result?.data?.return ?? result?.geocodes ?? [];
  const item = Array.isArray(rows) ? rows.find((row) => typeof row?.location === "string") : null;
  if (!item) return null;
  const [longitude, latitude] = item.location.split(",").map(Number);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return {
    longitude,
    latitude,
    address: [item.province, item.city, item.district, item.street, item.number].filter(Boolean).join(""),
    level: item.level,
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (n) => (n * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function coordinate(value, max) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= max ? number : null;
}

function poiOrigin(poi) {
  if (typeof poi?.location !== 'string') return null;
  const parts = poi.location.split(',');
  const longitude = coordinate(parts[0],180), latitude = coordinate(parts[1],90);
  return longitude != null && latitude != null ? {longitude,latitude,name:poi.name,address:poi.address,city:poi.city,level:'兴趣点'} : null;
}

function normalizeShop(shop, origin) {
  const longitude = coordinate(shop.longitude ?? shop.lng,180);
  const latitude = coordinate(shop.latitude ?? shop.lat,90);
  // Coordinates are authoritative. Do not guess distance units or turn null into 0.
  const apiDistance = shop.distance != null && String(shop.distance).trim() !== '' ? Number(shop.distance) : NaN;
  const distanceKm = longitude != null && latitude != null
    ? haversineKm(origin.latitude, origin.longitude, latitude, longitude)
    : Number.isFinite(apiDistance) && apiDistance >= 0 ? apiDistance : Infinity;
  return {...shop,longitude,latitude,distanceKm:Number.isFinite(distanceKm)?Number(distanceKm.toFixed(3)):null,
    distanceMeters:Number.isFinite(distanceKm)?Math.round(distanceKm*1000):null};
}

/**
 * 先用高德 MCP 解析地点，再用瑞幸 MCP 查询真实门店。
 * 这层组合比让模型自己猜经纬度可靠，也让“最近”有明确的排序依据。
 */
export async function findNearbyShops({ place = "", city = "", radius = 5000, userLocation, mapCall, shopCall }) {
  const query = String(place ?? "").trim();
  let origin = null;
  if (query) {
    const keywords = query.replace(/贵大/g,'贵州大学').replace(/北工大/g,'北京工业大学');
    const poi = await mapCall('maps_text_search', {keywords,...(city ? {city:String(city).trim()} : {})});
    const matches = Array.isArray(poi?.pois) ? poi.pois : [];
    const place = matches[0];
    if (place) {
      origin = poiOrigin(place);
      // Official Amap text search omits coordinates; resolve its verified POI ID.
      if (!origin && place.id) origin = poiOrigin(await mapCall('maps_search_detail',{id:place.id}));
    }
    if (!origin) {
      const geo = await mapCall('maps_geo',{address:keywords,...(city ? {city:String(city).trim()} : {})});
      const candidate = firstGeo(geo);
      if (candidate && !/国家|省|市|区县|乡镇|村庄/.test(candidate.level ?? '')) origin = candidate;
    }
    if (!origin) return { error: `地图没有解析出“${query}”的坐标，请补充城市或更完整的地址。`, place: query };
  } else if (userLocation && Number.isFinite(Number(userLocation.latitude)) && Number.isFinite(Number(userLocation.longitude))) {
    origin = {
      latitude: Number(userLocation.latitude),
      longitude: Number(userLocation.longitude),
      address: userLocation.address ?? "最近一次飞书定位",
    };
  } else {
    return { error: "我还不知道你要从哪里找最近的店，请说一个地标/地址，或先在飞书发一次位置。", needsLocation: true };
  }

  const raw = await shopCall("queryShopList", {
    longitude: origin.longitude,
    latitude: origin.latitude,
  });
  if (raw?.error || raw?.success === false || (raw?.code != null && Number(raw.code) !== 0)) throw new Error('门店查询暂时不可用，请重试');
  const rows = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.data?.data) ? raw.data.data : [];
  const maxKm = Math.max(0.5, Math.min(Number(radius) || 5000, 10000) / 1000);
  const shops = rows
    .map((shop) => normalizeShop(shop, origin))
    .filter((shop) => shop.deptId != null && shop.distanceKm != null && shop.distanceKm <= maxKm)
    .sort((a,b) => a.distanceKm - b.distanceKm)
    .slice(0, 8);

  return {
    origin,
    radiusMeters: Math.round(maxKm * 1000),
    shops,
    nearest: shops[0] ?? null,
    note: "按直线距离从近到远排列，营业状态单独展示，由用户选择。",
  };
}

export { firstGeo, haversineKm };
