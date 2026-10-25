/**
 * streaming-body-fallback — 回归测试
 *
 * 覆盖六阶段改动（STAGE_A..STAGE_F）的最终语义：
 *   1. 长回复   → 恰好 1 条消息，气泡文本 == 完整正文
 *   2. 短回复   → 恰好 1 条消息
 *   3. 中段内容不丢（mid block 并入末条正文）
 *   4. 平台已定稿的流 → 不刷 ERROR，只 warn 一次
 *
 * 运行：npx tsx tests/streaming-body-fallback.test.ts
 */
import assert from 'node:assert/strict';

import { StreamingController } from '../src/outbound/streaming-controller.js';
import {
  deliverDispatchPayload,
  type DispatchDeliverState,
} from '../src/dispatch/dispatch-deliver.js';

// ── 测试脚手架 ──

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

type LogLine = { level: 'info' | 'warn' | 'error' | 'debug'; msg: string };

function makeLog() {
  const lines: LogLine[] = [];
  const log = {
    lines,
    info: (msg: string) => { lines.push({ level: 'info', msg }); },
    warn: (msg: string) => { lines.push({ level: 'warn', msg }); },
    error: (msg: string) => { lines.push({ level: 'error', msg }); },
    debug: (msg: string) => { lines.push({ level: 'debug', msg }); },
    child: () => log,
  };
  return log;
}

/** 平台已把流消息定稿时的错误（QQ 开放平台 biz 文案 + stream_messages 路径） */
function alreadySubmittedError(): Error {
  const err = new Error('API Error [/v2/users/u1/stream_messages]: 404 已经提交的消息内容不可修改') as Error & {
    bizMessage?: string;
    path?: string;
  };
  err.bizMessage = '已经提交的消息内容不可修改';
  err.path = '/v2/users/u1/stream_messages';
  return err;
}

function makeController(opts: {
  failUpdate?: Error;
  failComplete?: Error;
} = {}) {
  const updates: string[] = [];
  const completes: string[] = [];
  const staticSends: string[] = [];
  const log = makeLog();

  const session = {
    async update(text: string) {
      if (opts.failUpdate) throw opts.failUpdate;
      updates.push(text);
    },
    async complete() {
      if (opts.failComplete) throw opts.failComplete;
      completes.push('done');
    },
  };

  const controller = new StreamingController({
    gateway: { openStream: () => session } as never,
    target: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } as never,
    accountId: 'acc1',
    replyToId: 'm1',
    log: log as never,
    sendFallback: async (body: string) => {
      staticSends.push(body);
      return undefined;
    },
  });

  return { controller, updates, completes, staticSends, log };
}

function makeState(
  controller: StreamingController,
  log: ReturnType<typeof makeLog>,
  staticSends: string[],
): DispatchDeliverState {
  return {
    ctx: {
      qualifiedTarget: 'u1',
      accountId: 'acc1',
      replyToId: 'm1',
      sendText: async () => ({}),
      sendMedia: async () => ({}),
    } as never,
    streamingController: controller as never,
    deliveredMediaUrls: new Set<string>(),
    deliveredTexts: new Set<string>(),
    log: log as never,
    deliverReply: async (payload) => {
      staticSends.push(payload.text ?? '');
    },
    pendingMidText: '',
  };
}

// ── 1. 长回复 → 恰好 1 条消息，气泡文本 == 完整正文 ──

await test('长回复 → 恰好 1 条消息（气泡文本 == 完整正文，静态兜底不再重复发送）', async () => {
  const { controller, updates, completes, staticSends } = makeController();
  const body = 'A'.repeat(500) + '\n' + 'B'.repeat(500);

  await controller.onPartialReply(body);
  await controller.finalize();

  assert.equal(staticSends.length, 0, '气泡已含完整正文 ⇒ 静态兜底不应再发一条');
  assert.equal(completes.length, 1, '流必须收尾一次');
  assert.equal(updates.at(-1), body, '气泡最终文本必须 == 完整正文');
  assert.equal(controller.displayedBodyText, body, 'displayedBodyText 应等于完整正文');
});

// ── 2. 短回复 → 恰好 1 条 ──

await test('短回复 → 恰好 1 条消息（不额外兜底）', async () => {
  const { controller, updates, completes, staticSends } = makeController();
  const body = '好的，已处理。';

  await controller.onPartialReply(body);
  await controller.finalize();

  assert.equal(staticSends.length, 0);
  assert.equal(completes.length, 1);
  assert.equal(updates.at(-1), body);
});

// ── 3. 中段内容不丢（mid block 并入末条正文） ──

await test('中段 block 不丢：流接管后并入末条正文', async () => {
  const { controller, updates, staticSends, log } = makeController();
  const state = makeState(controller, log, staticSends);

  // 先让流启动（hasStarted = true），模拟模型已在流式输出
  await controller.onPartialReply('开头部分');

  // 中段 block：流已接管 ⇒ 不静态发送，但必须被记住
  await deliverDispatchPayload({ text: '中段内容' }, { kind: 'block' }, state);
  assert.equal(staticSends.length, 0, '流接管时中段 block 不应静态发送');
  assert.equal(state.pendingMidText, '中段内容', '中段内容必须被保留');

  // 末条正文：中段内容并入正文一起推进气泡
  await deliverDispatchPayload({ text: '末条正文' }, { kind: 'final' }, state);

  const last = updates.at(-1) ?? '';
  assert.ok(last.includes('中段内容'), `末条气泡必须含中段内容，实际=${JSON.stringify(last)}`);
  assert.ok(last.includes('末条正文'), `末条气泡必须含末条正文，实际=${JSON.stringify(last)}`);
  assert.ok(
    last.indexOf('中段内容') < last.indexOf('末条正文'),
    `中段内容必须排在末条正文之前（按到达顺序），实际=${JSON.stringify(last)}`,
  );
});

// ── 3b. 静态兜底必须带上折叠后的正文（pendingMidText 不丢） ──

/** 首块失败且可手动放行的控制器（用于构造“流在首块被接受前失败”的时序） */
function makeGatedFailingController() {
  const updates: string[] = [];
  const staticSends: string[] = [];
  const log = makeLog();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const session = {
    async update(text: string) {
      await gate;
      updates.push(text);
      throw new Error('stream update failed');
    },
    async complete() {},
  };

  const controller = new StreamingController({
    gateway: { openStream: () => session } as never,
    target: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } as never,
    accountId: 'acc1',
    replyToId: 'm1',
    log: log as never,
    sendFallback: async (body: string) => {
      staticSends.push(body);
      return undefined;
    },
  });

  return { controller, updates, staticSends, log, releaseUpdate: release };
}

await test('流在首块被接受前失败：静态兜底正文含中段内容', async () => {
  const { controller, staticSends, log, releaseUpdate } = makeGatedFailingController();
  const state = makeState(controller, log, staticSends);

  // 首块尚未被接受（hasStarted 已置位），中段 block ⇒ 挂到 pendingMidText
  const partial = controller.onPartialReply('开头部分');
  await deliverDispatchPayload({ text: '中段内容' }, { kind: 'block' }, state);
  assert.equal(state.pendingMidText, '中段内容', '中段内容必须被保留');

  // 首块失败 ⇒ 控制器降级为静态兜底
  releaseUpdate();
  await partial;
  assert.equal(controller.shouldFallbackToStatic, true, '首块失败后应降级为静态兜底');

  await deliverDispatchPayload({ text: '末条正文' }, { kind: 'final' }, state);

  assert.equal(staticSends.length, 1, '静态兜底必须发出恰好 1 条');
  const sent = staticSends[0] ?? '';
  assert.ok(sent.includes('中段内容'), `静态兜底正文必须含中段内容，实际=${JSON.stringify(sent)}`);
  assert.ok(sent.includes('末条正文'), `静态兜底正文必须含末条正文，实际=${JSON.stringify(sent)}`);
  assert.ok(
    sent.indexOf('中段内容') < sent.indexOf('末条正文'),
    `中段内容必须排在末条正文之前，实际=${JSON.stringify(sent)}`,
  );
});

await test('流在首块被接受前失败：仅媒体的末条也要带上中段内容', async () => {
  const { controller, staticSends, log, releaseUpdate } = makeGatedFailingController();
  const state = makeState(controller, log, staticSends);

  const partial = controller.onPartialReply('开头部分');
  await deliverDispatchPayload({ text: '中段内容' }, { kind: 'block' }, state);
  releaseUpdate();
  await partial;

  // 仅媒体的末条（无正文）⇒ 中段内容不能丢
  await deliverDispatchPayload({ mediaUrl: 'https://cdn/a.png' }, { kind: 'final' }, state);

  assert.equal(staticSends.length, 1, '静态兜底必须发出恰好 1 条');
  const sent = staticSends[0] ?? '';
  assert.ok(sent.includes('中段内容'), `静态兜底正文必须含中段内容，实际=${JSON.stringify(sent)}`);
});

// ── 4. 平台已定稿的流 → 不刷 ERROR，只 warn 一次 ──

await test('平台已定稿：update 被拒 → 不刷 ERROR，只 warn 一次', async () => {
  const { controller, log } = makeController({ failUpdate: alreadySubmittedError() });

  await controller.onPartialReply('第一段');
  await controller.finalize();

  const errors = log.lines.filter((l) => l.level === 'error');
  const guardWarns = log.lines.filter((l) => l.level === 'warn' && l.msg.includes('[qqbot][guard][F]'));

  assert.equal(errors.length, 0, `不应有 ERROR 日志，实际=${JSON.stringify(errors)}`);
  assert.equal(guardWarns.length, 1, `应恰好 1 条 guard warn，实际=${JSON.stringify(guardWarns)}`);
});

await test('平台已定稿：complete 被拒 → 不刷 ERROR，只 warn 一次', async () => {
  const { controller, log } = makeController({ failComplete: alreadySubmittedError() });

  await controller.onPartialReply('第一段');
  await controller.finalize();

  const errors = log.lines.filter((l) => l.level === 'error');
  const guardWarns = log.lines.filter((l) => l.level === 'warn' && l.msg.includes('[qqbot][guard][F]'));

  assert.equal(errors.length, 0, `不应有 ERROR 日志，实际=${JSON.stringify(errors)}`);
  assert.equal(guardWarns.length, 1, `应恰好 1 条 guard warn，实际=${JSON.stringify(guardWarns)}`);
});

// ── 汇总 ──

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
