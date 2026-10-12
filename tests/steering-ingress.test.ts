/** Run: npm run test:steering */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as nextTick, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Middleware, MiddlewareContext, QQBot } from '@tencent-connect/qqbot-nodejs';
import { setupMiddlewares } from '../src/gateway/middleware-setup.js';
import { resolveRuntimeAdapters } from '../src/adapter/resolve.js';
import { processingTimeout } from '../src/middleware/processing-timeout.js';
import { getPersistedRefIndexStore } from '../src/features/ref-index-store.js';
import type { ResolvedQQBotAccount } from '../src/types.js';

const log = { info() {}, debug() {}, warn() {}, error() {} };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function context(bot: QQBot, id: string, content: string, senderId = 'trusted'): MiddlewareContext {
  const controller = new AbortController();
  let stopped = false;
  let stopReason: string | undefined;
  const replyTarget = { scope: 'c2c' as const, targetId: 'target', msgId: id };
  return {
    bot, log, replyTarget, state: {}, signal: controller.signal, receivedAt: Date.now(),
    message: { rawEventType: 'C2C_MESSAGE_CREATE', kind: 'c2c', senderId,
      messageId: id, content, timestamp: new Date().toISOString(), replyTarget },
    get stopped() { return stopped; },
    get stopReason() { return stopReason; },
    get aborted() { return controller.signal.aborted; },
    stop(reason) { stopped = true; stopReason = reason; },
    abort(reason) { controller.abort(reason); this.stop(reason); },
  };
}
async function run(chain: Middleware[], ctx: MiddlewareContext, index = 0): Promise<void> {
  if (!ctx.stopped && chain[index]) {
    await chain[index](ctx, () => run(chain, ctx, index + 1));
  }
}

test('full inbound chain admits new input while the first Agent turn is active', async t => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-steering-'));
  t.mock.method(os, 'homedir', () => temporaryHome);
  syncBuiltinESMExports();
  try {
    // Keep this integration test off the user's ref-index file and the network.
    t.mock.method(getPersistedRefIndexStore('steering-test'), 'set', () => {});
    for (const content of ['ordinary guidance', '/steer summarize now', '/stop']) {
      await t.test(content, async () => {
        const chain: Middleware[] = [];
        const bot = {
          appId: 'test-app', accountId: 'steering-test',
          use(middleware: Middleware) { chain.push(middleware); },
          async sendTyping() {},
          async sendText() { throw new Error('Unexpected send'); },
        } as unknown as QQBot;
        setupMiddlewares(bot, {
          accountId: 'steering-test', appId: 'test-app', clientSecret: 'test-secret',
          enabled: true, markdownSupport: true, userAgentSuffix: '', processingTimeoutMs: 0,
          config: { dmPolicy: 'allowlist', allowFrom: ['trusted'], streaming: { mode: 'partial' } },
        } as ResolvedQQBotAccount, { getRuntime: () => ({ config: { current: () => ({}) } }) });
        const entered = deferred();
        const release = deferred();
        const trace: string[] = [];
        chain.push(async ctx => {
          trace.push(ctx.message.messageId);
          if (ctx.message.messageId === 'A') { entered.resolve(); await release.promise; }
        });
        const first = run(chain, context(bot, 'A', 'long task'));
        await entered.promise;
        const second = run(chain, context(bot, 'B', content));
        await nextTick();
        try {
          assert.deepEqual(trace, ['A', 'B']);
        } finally {
          release.resolve();
          await Promise.all([first, second]);
        }
        const denied = context(bot, 'denied', 'must stay blocked', 'stranger');
        await run(chain, denied);
        assert.equal(denied.stopReason, 'access:not_allowlisted');
        await run(chain, context(bot, 'B', content));
        assert.deepEqual(trace, ['A', 'B'], 'authentication and deduplication remain active');
      });
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test('buffered replies invoke the bound public queue-aware dispatcher', async () => {
  const options = { ctx: { body: 'steer' }, cfg: {}, dispatcherOptions: {}, replyOptions: {} };
  const owner = {
    marker: 'reply-owner',
    async dispatchReplyFromConfig(params: unknown) {
      assert.equal(this.marker, 'reply-owner');
      return params;
    },
    async dispatchReplyWithBufferedBlockDispatcher(params: any) {
      assert.equal(this.marker, 'reply-owner');
      assert.equal(params.ctx, options.ctx);
      assert.equal(params.dispatcherOptions, options.dispatcherOptions);
      assert.equal(params.replyOptions, options.replyOptions);
      return params.dispatchReplyFromConfig(params.ctx);
    },
  };
  const adapters = resolveRuntimeAdapters({ channel: { reply: owner } } as any);
  assert.equal(await adapters.dispatchReply!(options), options.ctx);
});

test('older runtimes keep buffered dispatch without an unavailable callback', async () => {
  const options = { ctx: { body: 'legacy' } };
  const adapters = resolveRuntimeAdapters({ channel: { reply: {
    async dispatchReplyWithBufferedBlockDispatcher(params: any) {
      assert(!Object.hasOwn(params, 'dispatchReplyFromConfig'));
      return params.ctx;
    },
  } } } as any);
  assert.equal(await adapters.dispatchReply!(options), options.ctx);
  assert.equal(resolveRuntimeAdapters({} as any).dispatchReply, null);
});

test('processing timeout cancels only its own active request', async () => {
  const first = context({} as QQBot, 'timed', 'task');
  const second = context({} as QQBot, 'untimed', 'guidance');
  const release = deferred();
  const waiting = processingTimeout(0)(second, () => release.promise);
  try {
    await processingTimeout(5)(first, () => delay(20));
    assert.equal(first.signal.reason, 'concurrency:processing-timeout');
    assert.equal(second.signal.aborted, false);
  } finally {
    release.resolve();
    await waiting;
  }
});

test('completed and failed handlers clear their processing timeout', async () => {
  for (const fail of [false, true]) {
    const ctx = context({} as QQBot, 'finished', 'task');
    const result = processingTimeout(5)(ctx, async () => { if (fail) throw new Error('downstream'); });
    if (fail) await assert.rejects(() => Promise.resolve(result), /downstream/);
    else await result;
    await delay(20);
    assert.equal(ctx.signal.aborted, false);
  }
});
