/**
 * C2C 流式收尾：同一 target 的 finalize 必须串行。
 *
 * 运行方式: npx tsx tests/streaming-lock.test.ts
 */
import assert from 'node:assert/strict';
import type { QQBotGateway } from '../src/gateway/qqbot-gateway.js';
import { StreamingController } from '../src/outbound/streaming-controller.js';

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

const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return log; },
};

await test('两个 StreamingController 的 finalize 不会重叠', async () => {
  let activeCompletes = 0;
  let maxActiveCompletes = 0;
  const gateway = {
    openStream: () => ({
      update: async () => {},
      complete: async () => {
        activeCompletes += 1;
        maxActiveCompletes = Math.max(maxActiveCompletes, activeCompletes);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCompletes -= 1;
      },
    }),
  } as unknown as QQBotGateway;

  const deps = {
    gateway,
    target: { scope: 'c2c' as const, targetId: 'user-1' },
    accountId: 'acc',
    replyToId: 'msg-1',
    log,
  };

  const first = new StreamingController(deps);
  const second = new StreamingController(deps);

  await first.onPartialReply('first');
  await second.onPartialReply('second');
  await Promise.all([first.finalize(), second.finalize()]);

  assert.equal(maxActiveCompletes, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
