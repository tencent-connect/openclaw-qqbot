import assert from 'node:assert/strict';
import { MemoryHistoryStore, MemoryRefIndexStore, mentionGate, quoteRef } from '@tencent-connect/qqbot-nodejs';
import { mediaHistoryBuffer, enrichMediaRef, collectContextImages } from '../src/middleware/media-context.js';
import { attachmentProcessor } from '../src/middleware/attachment.js';
import { assembleBody } from '../src/dispatch/body-assembler.js';
import { buildCtxPayload } from '../src/dispatch/ctx-builder.js';
import { downloadFixture } from './helpers/media-download.js';
import { buildEnvelope } from '../src/dispatch/envelope-builder.js';

const account = { accountId: 'test-account', markdownSupport: true, config: {} } as any;
const store = new MemoryRefIndexStore();
const history = new MemoryHistoryStore();
const log = { debug() {}, info() {}, warn() {}, error() {} };
const runtime = { config: { loadConfig: () => ({}) } };
let dispatches = 0;
const chain = [
  mediaHistoryBuffer(history, ctx => ctx.message.kind === 'group' ? `account:${ctx.message.groupOpenid}` : undefined),
  quoteRef({ store, enrichEntry: enrichMediaRef }),
  mentionGate(),
  attachmentProcessor({ getRuntime: () => runtime, refStore: store }),
];
/** Create one synthetic group event with mention policy and stop tracking. */
function message(id: string, extra: any = {}): any {
  const m = {
    messageId: id, msgIdx: `REFIDX_${id}`, content: '', kind: 'group',
    senderId: 'alice', senderName: 'Alice', groupOpenid: 'group-a', timestamp: new Date().toISOString(),
    rawEventType: 'GROUP_MESSAGE_CREATE', replyTarget: { scope: 'group', targetId: 'group-a' },
    ...extra,
  };
  return { message: m, bot: { appId: 'bot' }, state: { policy: { group: { requireMention: true, historyLimit: 20 } } }, log,
    stop(reason: string) { this.stopped = true; this.reason = reason; } };
}
/** Run the real SDK middleware chain and count only events reaching dispatch. */
async function run(ctx: any) {
  let i = -1;
  /** Advance to the next middleware or the dispatch sentinel. */
  async function next() { i++; if (i < chain.length) await chain[i](ctx, next); else dispatches++; }
  await next();
  return ctx;
}
const picture = { content_type: 'image/png', url: 'https://example.com/first.png', filename: 'first.png' };

/** Check quoted-media recovery, mention gating, isolation and concurrent download ordering. */
async function main() {
  const unmentioned = await run(message('picture', { attachments: [picture] }));
  assert.equal(dispatches, 0, 'unmentioned picture must not invoke the AI');
  assert.equal(unmentioned.reason, 'mention-gate:no_mention');
  assert.equal((store.get('REFIDX_picture') as any).attachments[0].url, picture.url);

  const quoted = await run(message('question', {
    content: 'What is in this picture?', rawEventType: 'GROUP_AT_MESSAGE_CREATE', refMsgIdx: 'REFIDX_picture',
    msgElements: [{ attachments: [{ content_type: 'image/png', filename: 'first.png', url: '' }] }],
  }));
  assert.equal(dispatches, 1);
  assert.deepEqual(quoted.state.processedAttachments.localMediaTypes, ['image/png']);
  assert.equal(quoted.state.processedAttachments.imageUrls.length, 1, 'quote/history duplicate must be removed');
  assert.match(quoted.state.processedAttachments.localMediaPaths[0], /first\.png$/);
  assert.match(quoted.state.processedAttachments.contextImageInfo, /Quoted image/);
  const body = assembleBody(quoted, quoted.message, account);
  assert.match(body.agentBody, /Quoted image:.*first\.png/);
  const payload = buildCtxPayload({ assembled: body, envelope: buildEnvelope(quoted, quoted.message, account),
    route: { accountId: account.accountId, agentId: 'anya', sessionKey: 'test' }, msg: quoted.message, ctx: quoted,
    adapters: { buildInboundContext: (p: any) => p } as any });
  assert.deepEqual(payload.extra.MediaPaths, quoted.state.processedAttachments.localMediaPaths);
  assert.deepEqual(payload.extra.MediaTypes, ['image/png']);

  const uncachedQuote = await run(message('uncached-quote', {
    content: 'Describe the quoted picture', rawEventType: 'GROUP_AT_MESSAGE_CREATE', refMsgIdx: 'REFIDX_uncached',
    msgElements: [{ attachments: [{ content_type: 'image/png', filename: 'uncached.png', url: 'https://example.com/uncached.png' }] }],
  }));
  assert.ok(uncachedQuote.state.processedAttachments.localMediaPaths.some((p: string) => p.endsWith('uncached.png')),
    'msg_elements image URL must work without any cached original');

  await run(message('split-picture', { attachments: [{ ...picture, url: 'https://example.com/split.png', filename: 'split.png' }] }));
  const split = await run(message('split-at', { content: 'Look at that', rawEventType: 'GROUP_AT_MESSAGE_CREATE' }));
  assert.ok(split.state.processedAttachments.localMediaPaths.some((p: string) => p.endsWith('split.png')),
    'separate picture + mention events must retain image data');

  // A missing quoted original must not turn another message's image.png into the quote.
  const sameName = message('missing-original');
  sameName.state.quote = { refKey: 'REFIDX_missing', text: '[image: image.png]',
    attachments: [{ contentType: 'image/png', filename: 'image.png', url: '' }] };
  sameName.state.history = [{ senderId: 'bob', senderName: 'Bob', messageId: 'unrelated',
    msgIdx: 'REFIDX_unrelated', content: '', timestamp: 0,
    attachments: [{ ...picture, filename: 'image.png', url: 'https://example.com/unrelated.png' }] }];
  const matchingNames = await collectContextImages(sameName, store);
  assert.equal(matchingNames.filter(x => x.label === 'Quoted image').length, 0,
    'same filename in an unrelated message must never recover a quoted image');
  assert.ok(matchingNames.every(x => x.label.startsWith('History image')),
    'unrelated images may retain their own history label, never the quoted-image label');
  sameName.state.history[0].msgIdx = 'REFIDX_missing';
  assert.equal((await collectContextImages(sameName, store))[0]?.label, 'Quoted image',
    'an exact original reference may still recover a filename-only quote');

  const concurrent = message('concurrent');
  concurrent.state.quote = { refKey: 'REFIDX_parallel', text: '[images]', attachments: ['one', 'two', 'three'].map(name => ({
    contentType: 'image/png', filename: `${name}.png`, url: `https://example.com/${name}.png`,
  })) };
  const pending = new Map<string, () => void>();
  let allStarted!: () => void;
  const started = new Promise<void>(resolve => { allStarted = resolve; });
  downloadFixture.handler = async opts => {
    await new Promise<void>(resolve => {
      pending.set(opts.originalFilename!, resolve);
      if (pending.size === 3) allStarted();
    });
    if (opts.originalFilename === 'two.png') throw new Error('Synthetic image download failure');
    return { path: `/tmp/qqbot-regression/${opts.originalFilename}` };
  };
  const processing = attachmentProcessor({ getRuntime: () => runtime, refStore: store })(concurrent, async () => {});
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([started, new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error('Context downloads did not start concurrently')), 1000);
    })]);
    // Complete in reverse order, including one failed download.
    for (const name of ['three.png', 'two.png', 'one.png']) pending.get(name)!();
    await processing;
    assert.deepEqual(concurrent.state.processedAttachments.imageUrls, [
      '/tmp/qqbot-regression/one.png', 'https://example.com/two.png', '/tmp/qqbot-regression/three.png',
    ], 'media and their labels must retain input order despite out-of-order completion or failure');
    assert.deepEqual(concurrent.state.processedAttachments.contextImageInfo.split('\n'), [
      'Quoted image: /tmp/qqbot-regression/one.png', 'Quoted image: https://example.com/two.png',
      'Quoted image: /tmp/qqbot-regression/three.png',
    ]);
  } finally {
    clearTimeout(guard);
    downloadFixture.handler = undefined;
    for (const release of pending.values()) release();
    await processing;
  }

  const foreign = message('foreign', { groupOpenid: 'group-b', replyTarget: { scope: 'group', targetId: 'group-b' },
    refMsgIdx: 'REFIDX_picture' });
  foreign.state.quote = { refKey: 'REFIDX_picture', text: '[image]' };
  assert.deepEqual(await collectContextImages(foreign, store), [], 'must not recover another group\'s images');
  const disabled = message('disabled');
  disabled.state.policy.group.historyLimit = 0;
  await run(disabled);
  assert.deepEqual(history.list('account:group-a', 20), [], 'historyLimit=0 disables history');

  console.log('QQ image checks passed: mention gate, quoted image, split events, media payload, group isolation and history=0.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
