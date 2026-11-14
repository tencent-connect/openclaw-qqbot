/**
 * 出站防抖：发送失败必须传给入队方。
 *
 * 运行方式: npx tsx tests/debounce.test.ts
 */
import assert from 'node:assert/strict';
import { DeliverDebouncer } from '../src/outbound/debounce.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

await test('同一批文本在 flush 成功后一起 resolve', async () => {
  const sent: string[] = [];
  const d = new DeliverDebouncer({ windowMs: 5 }, async (_to, text) => {
    sent.push(text);
  });
  await Promise.all([d.enqueue('u', 'a'), d.enqueue('u', 'b')]);
  assert.deepEqual(sent, ['a\n\n---\n\nb']);
});

await test('flush 失败时入队 Promise 全部 reject', async () => {
  const d = new DeliverDebouncer({ windowMs: 5 }, async () => {
    throw new Error('qq timeout');
  });
  const first = d.enqueue('u', 'a');
  const second = d.enqueue('u', 'b');
  await assert.rejects(first, /qq timeout/);
  await assert.rejects(second, /qq timeout/);
});

await test('失败后队列清空，下一次可以重新发送', async () => {
  let fail = true;
  const d = new DeliverDebouncer({ windowMs: 5 }, async () => {
    if (fail) throw new Error('first fail');
  });
  await assert.rejects(d.enqueue('u', 'x'), /first fail/);
  fail = false;
  await d.enqueue('u', 'x');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
