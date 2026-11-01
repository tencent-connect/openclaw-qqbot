/**
 * 出站发送账本：容量淘汰不能误删在途占位，confirm/release 必须有 ownership。
 *
 * 运行方式: npx tsx tests/send-ledger.test.ts
 */
import assert from 'node:assert/strict';
import {
  OUTBOUND_LEDGER_MAX_ENTRIES,
  OUTBOUND_LEDGER_TTL_MS,
  confirmOutboundSend,
  releaseOutboundSend,
  reserveOutboundSend,
  resetOutboundLedger,
} from '../src/dispatch/send-ledger.js';

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

test('容量满时淘汰 confirmed，保留 inflight', () => {
  resetOutboundLedger();
  const now = 1_000_000;

  for (let i = 0; i < OUTBOUND_LEDGER_MAX_ENTRIES; i += 1) {
    const text = `confirmed-${i}`;
    const token = reserveOutboundSend('acc', 'msg', text, now);
    assert.ok(token);
    confirmOutboundSend('acc', 'msg', text, token, now);
  }

  const inflight = reserveOutboundSend('acc', 'msg', 'inflight', now + 1);
  assert.ok(inflight);
  // 触发一次淘汰：应该先删最旧的 confirmed，而不是这条 inflight
  assert.ok(reserveOutboundSend('acc', 'msg', 'new-entry', now + 2));

  // 同一段在途文本仍然不能被并发派发抢走
  assert.equal(reserveOutboundSend('acc', 'msg', 'inflight', now + 3), null);

  // 最旧的 confirmed 已被淘汰，可以重新占位
  assert.ok(reserveOutboundSend('acc', 'msg', 'confirmed-0', now + 4));
});

test('confirmed 过期后同一文本可以重新发送', () => {
  resetOutboundLedger();
  const now = 2_000_000;
  const token = reserveOutboundSend('acc', 'msg', 'expired', now);
  assert.ok(token);
  confirmOutboundSend('acc', 'msg', 'expired', token, now);

  assert.ok(reserveOutboundSend('acc', 'msg', 'later', now + OUTBOUND_LEDGER_TTL_MS + 1));
  assert.ok(reserveOutboundSend('acc', 'msg', 'expired', now + OUTBOUND_LEDGER_TTL_MS + 2));
});

test('inflight 不会因为时长过期', () => {
  resetOutboundLedger();
  const token = reserveOutboundSend('acc', 'msg', 'long-media', 0);
  assert.ok(token);
  // 模拟超过旧的 2 分钟窗口，甚至一天后
  assert.ok(reserveOutboundSend('acc', 'msg', 'other', 24 * 60 * 60_000));
  assert.equal(reserveOutboundSend('acc', 'msg', 'long-media', 24 * 60 * 60_000), null);
});

test('发送失败 release 后允许重试，错误 token 不能释放他人占位', () => {
  resetOutboundLedger();
  const token = reserveOutboundSend('acc', 'msg', 'retry', 0);
  assert.ok(token);
  assert.equal(reserveOutboundSend('acc', 'msg', 'retry', 1), null);

  releaseOutboundSend('acc', 'msg', 'retry', 'wrong-token');
  assert.equal(reserveOutboundSend('acc', 'msg', 'retry', 2), null);

  releaseOutboundSend('acc', 'msg', 'retry', token);
  assert.ok(reserveOutboundSend('acc', 'msg', 'retry', 3));
});

test('旧 token 不能 confirm/release 新持有者的占位', () => {
  resetOutboundLedger();
  const oldToken = reserveOutboundSend('acc', 'msg', 'handover', 0);
  assert.ok(oldToken);
  releaseOutboundSend('acc', 'msg', 'handover', oldToken);

  const newToken = reserveOutboundSend('acc', 'msg', 'handover', 1);
  assert.ok(newToken);

  // 旧派发迟到的 confirm/release 必须无效
  confirmOutboundSend('acc', 'msg', 'handover', oldToken, 2);
  releaseOutboundSend('acc', 'msg', 'handover', oldToken);

  assert.equal(reserveOutboundSend('acc', 'msg', 'handover', 3), null);
  releaseOutboundSend('acc', 'msg', 'handover', newToken);
  assert.ok(reserveOutboundSend('acc', 'msg', 'handover', 4));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
