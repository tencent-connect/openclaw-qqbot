/**
 * 出站发送账本：容量淘汰不能误删在途占位。
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
    assert.equal(reserveOutboundSend('acc', 'msg', text, now), true);
    confirmOutboundSend('acc', 'msg', text, now);
  }

  assert.equal(reserveOutboundSend('acc', 'msg', 'inflight', now + 1), true);
  // 触发一次淘汰：应该先删最旧的 confirmed，而不是这条 inflight
  assert.equal(reserveOutboundSend('acc', 'msg', 'new-entry', now + 2), true);

  // 同一段在途文本仍然不能被并发派发抢走
  assert.equal(reserveOutboundSend('acc', 'msg', 'inflight', now + 3), false);

  // 最旧的 confirmed 已被淘汰，可以重新占位
  assert.equal(reserveOutboundSend('acc', 'msg', 'confirmed-0', now + 4), true);
});

test('过期条目会被清掉，同一文本可以重新发送', () => {
  resetOutboundLedger();
  const now = 2_000_000;
  assert.equal(reserveOutboundSend('acc', 'msg', 'expired', now), true);
  // 超过 confirmed TTL 后，下一次 reserve 会先清理过期条目
  assert.equal(
    reserveOutboundSend('acc', 'msg', 'later', now + OUTBOUND_LEDGER_TTL_MS + 1),
    true,
  );
  assert.equal(
    reserveOutboundSend('acc', 'msg', 'expired', now + OUTBOUND_LEDGER_TTL_MS + 2),
    true,
  );
});

test('发送失败 release 后允许重试', () => {
  resetOutboundLedger();
  assert.equal(reserveOutboundSend('acc', 'msg', 'retry', 0), true);
  assert.equal(reserveOutboundSend('acc', 'msg', 'retry', 1), false);
  releaseOutboundSend('acc', 'msg', 'retry');
  assert.equal(reserveOutboundSend('acc', 'msg', 'retry', 2), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
