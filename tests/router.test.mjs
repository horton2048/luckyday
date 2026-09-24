import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntentResponse, parseClassificationResponse } from '../src/router.js';

test('预约请客不误判团队拼单', () => {
  assert.equal(parseIntentResponse('{"intent":"team_party","scheduled":true,"collaborative":false}'), 'scheduled_order');
});
test('只有需要他人参与才是团队拼单', () => {
  assert.equal(parseIntentResponse('{"intent":"team_party","scheduled":false,"collaborative":true}'), 'team_party');
  assert.equal(parseIntentResponse('{"intent":"single_order","scheduled":false,"collaborative":false}'), 'direct_order');
});
test('模型返回 JSON 代码块也能解析', () => {
  assert.equal(parseIntentResponse('```json\n{"intent":"scheduled_order","scheduled":true,"collaborative":false}\n```'), 'scheduled_order');
});
test('模糊需求和到岗统一进入专属推荐', () => {
  assert.equal(parseIntentResponse('{"intent":"arrival_reco","scheduled":false,"collaborative":false}'), 'exclusive_recommendation');
  assert.equal(parseIntentResponse('{"intent":"recommendation_order","scheduled":false,"collaborative":false}'), 'exclusive_recommendation');
});
test('分类同时保留预约时间供卡片预填', () => {
  const result = parseClassificationResponse('{"intent":"scheduled_order","scheduled":true,"collaborative":false,"scheduled_at":"2026-09-19 13:00"}');
  assert.equal(result.intent, 'scheduled_order');
  assert.equal(result.scheduledAt, '2026-09-19 13:00');
});
