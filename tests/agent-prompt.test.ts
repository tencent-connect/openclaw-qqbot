/**
 * agentPrompt 声明测试：message 工具能力声明。
 *
 * OpenClaw 9.8+ 在群聊下强制走 message 工具，频道插件必须通过
 * `agentPrompt.messageToolHints` / `agentPrompt.messageToolCapabilities`
 * 声明自己支持的能力，否则群聊里的消息工具不可用。
 *
 * 这里断言的是**源码里的声明**而不是运行时对象：`src/channel.ts` 会经由
 * `src/adapter/resolve.ts` 拖入 `src/adapter/media.ts`，而后者使用了
 * `createRequire(__filename)`，在 tsx 的 ESM 运行时下会抛
 * ERR_AMBIGUOUS_MODULE_SYNTAX（上游现有测试也都没有 import 插件定义对象）。
 *
 * 运行方式: npx tsx tests/agent-prompt.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

const channelSrc = readFileSync(
  fileURLToPath(new URL('../src/channel.ts', import.meta.url)),
  'utf-8',
);

await test('插件定义声明了 agentPrompt', () => {
  assert.ok(
    /^\s*agentPrompt:\s*\{/m.test(channelSrc),
    'src/channel.ts 里没有 agentPrompt 声明',
  );
});

await test('messageToolHints 声明 send', () => {
  assert.ok(
    /messageToolHints:\s*\([^)]*\)\s*=>\s*\[\s*'send'\s*\]/.test(channelSrc),
    "messageToolHints 应当声明 ['send']",
  );
});

await test('messageToolCapabilities 声明 delivery-pin', () => {
  assert.ok(
    /messageToolCapabilities:\s*\([^)]*\)\s*=>\s*\[\s*'delivery-pin'\s*\]/.test(channelSrc),
    "messageToolCapabilities 应当声明 ['delivery-pin']",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`Failed: ${failedTests.join(', ')}`);
  process.exit(1);
}
