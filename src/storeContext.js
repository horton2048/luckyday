import {existsSync, readFileSync, mkdirSync, writeFileSync, renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertTaskActive} from './taskContext.js';

// Separate a confirmed store from a still unresolved request. Both survive card
// expiry and process restarts; neither silently overwrites the user's default.
const path = process.env.LUCKYDAY_STORE_CONTEXT_PATH ||
  (process.env.LUCKYDAY_TEST_MODE === '1' || process.env.NODE_TEST_CONTEXT ? null : fileURLToPath(new URL('../data/store-context.json',import.meta.url)));
let contexts = {};
if (path && existsSync(path)) contexts=JSON.parse(readFileSync(path,'utf8'));
const key=(ownerId,chatId)=>JSON.stringify([ownerId,chatId]);
export function getShopContext(ownerId,chatId) {return structuredClone(contexts[key(ownerId,chatId)] ?? {});}
function update(ownerId,chatId,patch) {
  assertTaskActive();
  const next={...contexts,[key(ownerId,chatId)]:{...getShopContext(ownerId,chatId),...structuredClone(patch)}};
  if(path){mkdirSync(dirname(path),{recursive:true});writeFileSync(`${path}.tmp`,JSON.stringify(next),{mode:0o600});renameSync(`${path}.tmp`,path);}
  contexts=next;
}
export function getActiveShop(ownerId,chatId) {return getShopContext(ownerId,chatId).shop ?? null;}
export function setActiveShop(ownerId,chatId,shop) {
  if(!shop?.deptId || !shop?.deptName) throw new Error('必须使用查询确认过的真实门店');
  update(ownerId,chatId,{shop,pending:null});return getActiveShop(ownerId,chatId);
}
export function clearActiveShop(ownerId,chatId) {update(ownerId,chatId,{shop:null,pending:null});}
export function setPendingShopRequest(ownerId,chatId,pending) {update(ownerId,chatId,{pending});}
export function getPendingShopRequest(ownerId,chatId) {return getShopContext(ownerId,chatId).pending ?? null;}
