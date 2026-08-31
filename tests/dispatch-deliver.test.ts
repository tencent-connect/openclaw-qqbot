/**
 * 出站车道：kind=block / tool / final 与 native-stream 互斥。
 *
 * 运行方式: npx tsx tests/dispatch-deliver.test.ts
 */
import assert from 'node:assert/strict';
import type { DeliverContext, DeliverPayload } from '../src/outbound/deliver-pipeline.js';
import type { PluginLogger } from '../src/utils/plugin-logger.js';
import { formatLogTextPreview } from '../src/utils/log-text-preview.js';
import {
  deliverDispatchPayload,
  deliverDispatchPayloadSafe,
  filterDeliveredMedia,
  streamOwnsText,
  type DispatchDeliverState,
  type StreamTextOwner,
} from '../src/dispatch/dispatch-deliver.js';

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
    debug(msg) { lines.push(`debug ${msg}`); },
    info(msg) { lines.push(`info ${msg}`); },
    warn(msg) { lines.push(`warn ${msg}`); },
    error(msg) { lines.push(`error ${msg}`); },
    child() { return sink; },
  };
  return { log: sink, lines };
}

function createStreamOwner(overrides: Partial<StreamTextOwner> = {}): StreamTextOwner & { finalized: number } {
  const owner = {
    hasStarted: false,
    shouldFallbackToStatic: false,
    isTerminal: false,
    finalized: 0,
    async finalize() {
      owner.finalized += 1;
      owner.isTerminal = true;
    },
    ...overrides,
  };
  return owner;
}

function createState(overrides: Partial<DispatchDeliverState> = {}): {
  state: DispatchDeliverState;
  replies: Array<{ payload: DeliverPayload; kind?: string }>;
  media: string[];
  logLines: string[];
} {
  const replies: Array<{ payload: DeliverPayload; kind?: string }> = [];
  const media: string[] = [];
  const { log, lines } = createLogSpy();
  const ctx = {
    qualifiedTarget: 'c2c:user-1',
    accountId: 'acc',
    replyToId: 'msg-1',
    sendText: async () => ({}),
    sendMedia: async (_to: string, source: string) => {
      media.push(source);
      return {};
    },
  } as DeliverContext;
  const state: DispatchDeliverState = {
    ctx,
    streamingController: null,
    deliveredMediaUrls: new Set(),
    deliveredTexts: new Set(),
    log,
    deliverReply: async (payload, info) => {
      replies.push({ payload, kind: info?.kind });
    },
    ...overrides,
  };
  if (!state.ctx) state.ctx = ctx;
  if (!state.ctx.sendMedia) {
    state.ctx.sendMedia = async (_to, source) => {
      media.push(source);
      return {};
    };
  }
  return { state, replies, media, logLines: lines };
}

console.log('\n=== streamOwnsText ===');

await test('stream owns text only after it has started and has not fallen back', () => {
  assert.equal(streamOwnsText(null), false);
  assert.equal(streamOwnsText(createStreamOwner({ hasStarted: false })), false);
  assert.equal(streamOwnsText(createStreamOwner({ hasStarted: true, shouldFallbackToStatic: true })), false);
  assert.equal(streamOwnsText(createStreamOwner({ hasStarted: true, shouldFallbackToStatic: false })), true);
});

console.log('\n=== static-blocks ===');

await test('kind=block first-round commentary is sent immediately', async () => {
  const { state, replies, media, logLines } = createState();
  await deliverDispatchPayload(
    { text: 'Let me check that for you.' },
    { kind: 'block' },
    state,
  );
  assert.deepEqual(replies.map((r) => r.payload), [{ text: 'Let me check that for you.' }]);
  assert.deepEqual(media, []);
  assert.ok(state.deliveredTexts.has('Let me check that for you.'));
  assert.ok(logLines.some((line) =>
    line.includes('deliver kind=block') && line.includes('Let me check that for you.'),
  ));
});

await test('kind=block duplicate text is skipped', async () => {
  const { state, replies } = createState();
  await deliverDispatchPayload({ text: 'hi' }, { kind: 'block' }, state);
  await deliverDispatchPayload({ text: 'hi' }, { kind: 'block' }, state);
  assert.equal(replies.length, 1);
});

await test('kind=block forwards new media then sends leftover text', async () => {
  const { state, replies, media } = createState();
  await deliverDispatchPayload(
    { text: 'see image', mediaUrl: 'https://cdn/a.png' },
    { kind: 'block' },
    state,
  );
  assert.deepEqual(media, ['https://cdn/a.png']);
  assert.deepEqual(replies.map((r) => r.payload), [{ text: 'see image' }]);
});

await test('kind=tool forwards media only and never sends tool text', async () => {
  const { state, replies, media } = createState();
  await deliverDispatchPayload(
    { text: 'exec running', mediaUrl: 'https://cdn/tool.png' },
    { kind: 'tool' },
    state,
  );
  assert.deepEqual(media, ['https://cdn/tool.png']);
  assert.deepEqual(replies, []);
});

await test('kind=final is skipped when the same block text was already sent', async () => {
  const { state, replies } = createState();
  await deliverDispatchPayload({ text: 'answer' }, { kind: 'block' }, state);
  await deliverDispatchPayload({ text: 'answer' }, { kind: 'final' }, state);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.kind, 'block');
});

await test('kind=final still sends a later different answer', async () => {
  const { state, replies } = createState();
  await deliverDispatchPayload({ text: 'first round' }, { kind: 'block' }, state);
  await deliverDispatchPayload({ text: 'second round' }, { kind: 'final' }, state);
  assert.deepEqual(replies.map((r) => r.payload.text), ['first round', 'second round']);
});

await test('kind=block voice payload goes through deliverReply intact', async () => {
  const { state, replies, media } = createState();
  await deliverDispatchPayload(
    { text: 'hello', audioAsVoice: true },
    { kind: 'block' },
    state,
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.payload.audioAsVoice, true);
  assert.deepEqual(media, []);
});

console.log('\n=== native-stream ===');

await test('kind=block text is skipped once the stream owns the lane', async () => {
  const stream = createStreamOwner({ hasStarted: true });
  const { state, replies } = createState({ streamingController: stream });
  await deliverDispatchPayload({ text: 'streamed already' }, { kind: 'block' }, state);
  assert.deepEqual(replies, []);
  assert.equal(stream.finalized, 0);
});

await test('kind=final finalizes the stream and skips static text', async () => {
  const stream = createStreamOwner({ hasStarted: true });
  const { state, replies } = createState({ streamingController: stream });
  await deliverDispatchPayload({ text: 'done' }, { kind: 'final' }, state);
  assert.equal(stream.finalized, 1);
  assert.deepEqual(replies, []);
});

await test('stream fallback to static sends the final payload', async () => {
  const stream = createStreamOwner({ hasStarted: true });
  stream.finalize = async () => {
    stream.finalized += 1;
    stream.isTerminal = true;
    stream.shouldFallbackToStatic = true;
  };
  const { state, replies, logLines } = createState({ streamingController: stream });
  await deliverDispatchPayload({ text: 'fallback text' }, { kind: 'final' }, state);
  assert.equal(stream.finalized, 1);
  assert.deepEqual(replies.map((r) => r.payload.text), ['fallback text']);
  assert.ok(logLines.some((line) => line.includes('streaming fallback to static')));
});

await test('kind=final after a block still forwards only new media', async () => {
  const { state, replies, media } = createState();
  await deliverDispatchPayload(
    { text: 'caption', mediaUrl: 'https://cdn/a.png' },
    { kind: 'block' },
    state,
  );
  await deliverDispatchPayload(
    { text: 'caption', mediaUrl: 'https://cdn/a.png', mediaUrls: ['https://cdn/b.png'] },
    { kind: 'final' },
    state,
  );
  assert.deepEqual(media, ['https://cdn/a.png']);
  assert.equal(replies.length, 2);
  assert.equal(replies[1]?.payload.text, undefined);
  assert.deepEqual(replies[1]?.payload.mediaUrls, ['https://cdn/b.png']);
});

console.log('\n=== helpers ===');

await test('formatLogTextPreview shows delivered text and clips long payloads', () => {
  assert.equal(formatLogTextPreview(''), '');
  assert.equal(formatLogTextPreview('  好的，开始调用  '), ' text="好的，开始调用"');
  assert.equal(formatLogTextPreview('a\nb'), ' text="a b"');
  const long = 'x'.repeat(201);
  const preview = formatLogTextPreview(long);
  assert.equal(preview.includes('x'.repeat(200) + '...'), true);
  assert.equal(preview.includes('x'.repeat(201)), false);
});

await test('filterDeliveredMedia drops already forwarded urls', () => {
  const filtered = filterDeliveredMedia(
    { mediaUrl: 'https://cdn/a.png', mediaUrls: ['https://cdn/a.png', 'https://cdn/b.png'] },
    new Set(['https://cdn/a.png']),
  );
  assert.equal(filtered.mediaUrl, undefined);
  assert.deepEqual(filtered.mediaUrls, ['https://cdn/b.png']);
});

await test('deliverDispatchPayloadSafe swallows deliver errors', async () => {
  const { state, logLines } = createState({
    deliverReply: async () => {
      throw new Error('qq timeout');
    },
  });
  await deliverDispatchPayloadSafe({ text: 'boom' }, { kind: 'final' }, state);
  assert.ok(logLines.some((line) => line.includes('deliver error: qq timeout')));
});

await test('media forward failure is logged and does not throw', async () => {
  const { state, logLines } = createState();
  state.ctx.sendMedia = async () => {
    throw new Error('upload failed');
  };
  await deliverDispatchPayload(
    { mediaUrl: 'https://cdn/a.png' },
    { kind: 'tool' },
    state,
  );
  assert.ok(logLines.some((line) => line.includes('media forward failed: upload failed')));
  assert.equal(state.deliveredMediaUrls.has('https://cdn/a.png'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`Failed: ${failedTests.join(', ')}`);
  process.exit(1);
}
