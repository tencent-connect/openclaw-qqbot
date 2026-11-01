/**
 * 被动回复 msg_id 失效处理。
 *
 * 运行方式: npx tsx tests/msgid-fallback.test.ts
 */
import assert from 'node:assert/strict';
import { ReplyLimiter } from '../src/outbound/reply-limiter.js';
import { isInvalidMsgIdError } from '../src/outbound/msgid-error.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

test('识别 QQ msg_id 无效/越权错误', () => {
  const err = new Error(
    'Failed to route reply to qqbot: API Error [/v2/users/abc/messages]: 请求参数msg_id无效或越权',
  );
  assert.equal(isInvalidMsgIdError(err), true);
});

test('识别英文 invalid msg_id 错误', () => {
  assert.equal(isInvalidMsgIdError(new Error('invalid msg_id provided')), true);
});

test('超时等非 msg_id 错误不触发降级', () => {
  assert.equal(isInvalidMsgIdError(new Error('出站超时: sendText (30000ms)')), false);
});

test('平台拒绝过期的 msg_id 后不再使用', () => {
  const limiter = new ReplyLimiter({ limit: 4 });
  assert.equal(limiter.checkLimit('ROBOT1.0_expired').allowed, true);
  limiter.record('ROBOT1.0_expired');
  limiter.expire('ROBOT1.0_expired');
  const result = limiter.checkLimit('ROBOT1.0_expired');
  assert.equal(result.allowed, false);
  assert.equal(result.shouldFallbackToProactive, true);
  assert.equal(result.fallbackReason, 'expired');
});

test('过期的 msg_id 不影响其他消息', () => {
  const limiter = new ReplyLimiter();
  limiter.expire('old');
  assert.equal(limiter.checkLimit('new').allowed, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
