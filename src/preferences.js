import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATH = join(ROOT, '../data/user-preferences.json');
const load = () => {
  try { return existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : {}; } catch { return {}; }
};
const save = value => { mkdirSync(dirname(PATH), { recursive:true }); writeFileSync(PATH, JSON.stringify(value, null, 2), 'utf8'); };

export function getPreferences(userId) { return load()[userId] ?? {}; }
export function getDefaultShop(userId) { return getPreferences(userId).defaultShop ?? null; }
export function setDefaultShop(userId, shop) {
  const all=load(); all[userId]={...(all[userId]??{}),defaultShop:{deptId:Number(shop.deptId),deptName:shop.deptName,address:shop.address,deptAddress:shop.deptAddress,longitude:Number(shop.longitude),latitude:Number(shop.latitude),updatedAt:new Date().toISOString()}}; save(all); return all[userId].defaultShop;
}
export function clearDefaultShop(userId) { const all=load(); if(all[userId]){delete all[userId].defaultShop;save(all);} }
