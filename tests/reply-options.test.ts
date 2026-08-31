/**
 * replyOptions：监控全部 agent 事件；只有 native-stream 的 onPartialReply 对 QQ 可见。
 *
 * 运行方式: npx tsx tests/reply-options.test.ts
 */
import assert from 'node:assert/strict';
import {
  QQBOT_MONITORED_AGENT_EVENTS,
  createQqbotReplyOptions,
} from '../src/dispatch/reply-options.js';
import type { PluginLogger } from '../src/utils/plugin-logger.js';

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

function createLogSpy(): { log: PluginLogger; lines: string[] } {
  const lines: string[] = [];
  const sink: PluginLogger = {
    debug(msg) { lines.push(msg); },
    info(msg) { lines.push(msg); },
    warn(msg) { lines.push(msg); },
    error(msg) { lines.push(msg); },
    child() { return sink; },
  };
  return { log: sink, lines };
}

console.log('\n=== createQqbotReplyOptions ===');

await test('subscribes every monitored agent event in static mode', async () => {
  const { log, lines } = createLogSpy();
  const options = createQqbotReplyOptions({
    abortSignal: new AbortController().signal,
    runId: 'run-1',
    streamingController: null,
    log,
  });
  assert.equal(options.disableBlockStreaming, false);
  assert.equal(options.commentaryPayloadsEnabled, true);
  assert.equal(options.allowToolLifecycleWhenProgressHidden, true);
  assert.equal(options.suppressDefaultToolProgressMessages, true);
  assert.equal(options.forceToolResultProgress, true);
  assert.equal(options.onNarrationUpdate, undefined);
  assert.equal(options.onBlockReply, undefined);
  for (const name of QQBOT_MONITORED_AGENT_EVENTS) {
    assert.equal(typeof options[name], 'function', `${name} should be subscribed`);
    const result = await (options[name] as (payload?: unknown) => Promise<boolean> | boolean)({
      name: 'exec',
      phase: 'start',
      provider: 'huoshan',
      model: 'demo',
    });
    assert.equal(result, false, `${name} must not claim QQ-visible progress`);
    assert.ok(
      lines.some((line) => line.includes(name)),
      `${name} should be logged`,
    );
  }
  assert.equal(typeof options.onPartialReply, 'function');
  const partialVisible = await (options.onPartialReply as (p: { text: string }) => Promise<boolean> | boolean)({
    text: 'static 监控',
  });
  assert.equal(partialVisible, false);
  assert.ok(lines.some((line) => line.includes('onPartialReply')));
});

await test('native-stream mode routes partials to the controller and reports them as visible', async () => {
  const streamed: string[] = [];
  const { log, lines } = createLogSpy();
  const options = createQqbotReplyOptions({
    streamingController: {
      onPartialReply: async (text: string) => {
        streamed.push(text);
      },
    } as any,
    log,
  });
  assert.equal(typeof options.onPartialReply, 'function');
  const visible = await (options.onPartialReply as (p: { text: string }) => Promise<boolean>)({
    text: '流式第一轮',
  });
  assert.equal(visible, true);
  assert.deepEqual(streamed, ['流式第一轮']);
  assert.ok(lines.some((line) => line.includes('onPartialReply') && line.includes('textLen=5')));
  assert.equal(options.commentaryPayloadsEnabled, true);
  assert.equal(options.disableBlockStreaming, false);
  assert.equal(options.allowToolLifecycleWhenProgressHidden, true);
  assert.equal(options.suppressDefaultToolProgressMessages, true);
  assert.equal(options.forceToolResultProgress, true);
  for (const name of QQBOT_MONITORED_AGENT_EVENTS) {
    assert.equal(typeof options[name], 'function', `${name} should be subscribed`);
  }
});

await test('native-stream empty partial is not visible', async () => {
  const options = createQqbotReplyOptions({
    streamingController: {
      onPartialReply: async () => {
        throw new Error('empty partial should not reach the controller');
      },
    } as any,
  });
  const visible = await (options.onPartialReply as (p: { text: string }) => Promise<boolean>)({
    text: '',
  });
  assert.equal(visible, false);
});

await test('passes runId and abortSignal through', () => {
  const signal = new AbortController().signal;
  const options = createQqbotReplyOptions({
    abortSignal: signal,
    runId: 'run-42',
    streamingController: null,
  });
  assert.equal(options.runId, 'run-42');
  assert.equal(options.abortSignal, signal);
});

await test('monitor logs compact event fields and never dumps tool args', async () => {
  const { log, lines } = createLogSpy();
  const options = createQqbotReplyOptions({
    streamingController: null,
    log,
  });
  const visible = await (options.onToolStart as (payload: unknown) => boolean | Promise<boolean>)({
    name: 'exec',
    phase: 'start',
    toolCallId: 'tool-1',
    args: { apiKey: 'SECRET-TOKEN' },
  });
  assert.equal(visible, false);
  const line = lines.find((entry) => entry.includes('onToolStart'));
  assert.ok(line);
  assert.ok(line.includes('name=exec'));
  assert.ok(line.includes('phase=start'));
  assert.ok(line.includes('toolCallId=tool-1'));
  assert.equal(line.includes('SECRET-TOKEN'), false);
  assert.equal(line.includes('args'), false);
});
if (failed > 0) {
  console.error(`Failed: ${failedTests.join(', ')}`);
  process.exit(1);
}
