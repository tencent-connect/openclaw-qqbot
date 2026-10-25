/**
 * 静默回复识别 + delta 部分正文 的回归测试。
 *
 * 运行方式: npx tsx tests/silent-reply.test.ts
 */
import assert from 'node:assert/strict';
import { isQQBotDeliveryFailureNotice, isQQBotSilentReply, shouldSuppressQQBotSend } from '../src/utils/silent-reply.js';
import { createQqbotReplyOptions } from '../src/dispatch/reply-options.js';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  \u2717 ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

await test('静默 token：NO_REPLY / HEARTBEAT_OK 精确匹配', () => {
  assert.equal(isQQBotSilentReply('NO_REPLY'), true);
  assert.equal(isQQBotSilentReply('no_reply'), true);
  assert.equal(isQQBotSilentReply('  NO_REPLY  '), true);
  assert.equal(isQQBotSilentReply('HEARTBEAT_OK'), true);
  assert.equal(isQQBotSilentReply('NO_REPLY NO_REPLY'), true);
});

await test('静默 token：前缀匹配（全大写、长度>=2）', () => {
  assert.equal(isQQBotSilentReply('NO'), true);
  assert.equal(isQQBotSilentReply('NO_'), true);
  assert.equal(isQQBotSilentReply('HE'), true);
  assert.equal(isQQBotSilentReply('N'), false);
  assert.equal(isQQBotSilentReply('No'), false);
});

await test('静默 token：普通回复不被误判', () => {
  assert.equal(isQQBotSilentReply('你好'), false);
  assert.equal(isQQBotSilentReply('NO_REPLY please'), false);
  assert.equal(isQQBotSilentReply(''), false);
  assert.equal(isQQBotSilentReply(undefined), false);
  assert.equal(isQQBotSilentReply(null), false);
});

await test('投递失败提示：只有整条提示语本身才算数', () => {
  const notice = 'I generated a reply but could not deliver it to this chat. Please try again.';
  assert.equal(isQQBotDeliveryFailureNotice(notice), true);
  assert.equal(isQQBotDeliveryFailureNotice(`  ${notice}  `), true);
  assert.equal(isQQBotDeliveryFailureNotice(undefined), false);
  assert.equal(isQQBotDeliveryFailureNotice(''), false);
});

await test('投递失败提示：允许前缀措辞差异，但结尾必须是完整句子', () => {
  assert.equal(
    isQQBotDeliveryFailureNotice('Sorry, could not deliver it to this chat. Please try again.'),
    true,
  );
  assert.equal(
    isQQBotDeliveryFailureNotice('could not deliver it to this chat. Please try again'),
    false,
    '结尾不完整不算提示语',
  );
});

await test('投递失败提示：只是提到该文案的回复不能被当作静默丢弃', () => {
  const mentioning = '刚才那条回复提示 could not deliver it to this chat，所以我重发了一遍。';
  assert.equal(isQQBotDeliveryFailureNotice(mentioning), false);
  assert.equal(isQQBotSilentReply(mentioning), false);
  assert.equal(shouldSuppressQQBotSend(mentioning), false, '提到该文案的正常回复必须照常发出');

  const partial = 'could not deliver it to this chat';
  assert.equal(shouldSuppressQQBotSend(partial), false, '只包含片段的回复不能被丢弃');
});

await test('静默 token 与完整投递失败提示仍然会被抑制', () => {
  assert.equal(shouldSuppressQQBotSend('NO_REPLY'), true);
  assert.equal(shouldSuppressQQBotSend('HEARTBEAT_OK'), true);
  assert.equal(
    shouldSuppressQQBotSend('I generated a reply but could not deliver it to this chat. Please try again.'),
    true,
  );
});

await test('onPartialReply：只有 delta 时也要把正文交给流', async () => {
  const got: string[] = [];
  const options = createQqbotReplyOptions({
    streamingController: {
      onPartialReply: async (text: string) => {
        got.push(text);
      },
    } as never,
  });
  const handler = options.onPartialReply as (p: { text?: string; delta?: string }) => Promise<boolean>;
  const r = await handler({ delta: 'delta-only' });
  assert.equal(r, true);
  assert.deepEqual(got, ['delta-only']);
});

await test('onPartialReply：text 优先于 delta', async () => {
  const got: string[] = [];
  const options = createQqbotReplyOptions({
    streamingController: {
      onPartialReply: async (text: string) => {
        got.push(text);
      },
    } as never,
  });
  const handler = options.onPartialReply as (p: { text?: string; delta?: string }) => Promise<boolean>;
  const r = await handler({ text: 'from-text', delta: 'from-delta' });
  assert.equal(r, true);
  assert.deepEqual(got, ['from-text']);
});

await test('onPartialReply：空正文返回 false', async () => {
  const got: string[] = [];
  const options = createQqbotReplyOptions({
    streamingController: {
      onPartialReply: async (text: string) => {
        got.push(text);
      },
    } as never,
  });
  const handler = options.onPartialReply as (p: { text?: string; delta?: string }) => Promise<boolean>;
  const r = await handler({});
  assert.equal(r, false);
  assert.deepEqual(got, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`Failed: ${failedTests.join(', ')}`);
  process.exit(1);
}
