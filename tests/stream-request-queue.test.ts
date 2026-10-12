/** Run: npm run test:steering */
import assert from 'node:assert/strict';
import { setImmediate as nextTick, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { serializeStreamRequests } from '../src/outbound/stream-request-queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function bot(appId: string, send: QQBot['messageApi']['sendC2CStreamMessage']): QQBot {
  const instance = new QQBot({ appId, appSecret: 'test-secret', logger: { debug() {}, info() {}, warn() {}, error() {} } });
  instance.messageApi.sendC2CStreamMessage = send;
  serializeStreamRequests(instance);
  return instance;
}
function stream(instance: QQBot, targetId: string) {
  return instance.openStream({ target: { scope: 'c2c', targetId, msgId: 'test-message' } });
}

test('real SDK stream sessions serialize requests for the same app and target', async () => {
  const entered = deferred();
  const release = deferred();
  const calls: string[] = [];
  const send: QQBot['messageApi']['sendC2CStreamMessage'] = async (_creds, openid, request) => {
    calls.push(openid + ':' + request.content_raw);
    if (request.content_raw === 'first') { entered.resolve(); await release.promise; }
    return { id: 'stream-id', timestamp: Date.now() };
  };
  const firstBot = bot('shared-app', send);
  const secondBot = bot('shared-app', send);
  serializeStreamRequests(firstBot); // Reinstalling must not wrap the same API twice.
  const first = stream(firstBot, 'same-target');
  const second = stream(secondBot, 'same-target');
  const a = first.update('first');
  await entered.promise;
  const b = second.update('second');
  try {
    await nextTick();
    assert.deepEqual(calls, ['same-target:first']);
  } finally {
    release.resolve();
    await Promise.all([a, b]);
    first.cancel();
    second.cancel();
  }
  assert.deepEqual(calls, ['same-target:first', 'same-target:second']);
});

test('different apps and targets remain independent', async () => {
  const release = deferred();
  const entered = deferred();
  const calls: string[] = [];
  const send: QQBot['messageApi']['sendC2CStreamMessage'] = async (creds, openid) => {
    calls.push(creds.appId + ':' + openid);
    if (creds.appId === 'app-a' && openid === 'one') { entered.resolve(); await release.promise; }
    return { id: 'id', timestamp: Date.now() };
  };
  const a = bot('app-a', send);
  const b = bot('app-b', send);
  const sessions = [stream(a, 'one'), stream(a, 'two'), stream(b, 'one')];
  const pending = sessions[0].update('held');
  await entered.promise;
  try {
    await Promise.all([sessions[1].update('free'), sessions[2].update('free')]);
    assert.equal(calls.length, 3);
  } finally {
    release.resolve();
    await pending;
    sessions.forEach(session => session.cancel());
  }
});

test('a failed request releases the next sender and preserves its error', async () => {
  const release = deferred();
  const entered = deferred();
  const instance = bot('failure-app', async (_creds, _openid, request) => {
    if (request.content_raw === 'fail') {
      entered.resolve(); await release.promise; throw new Error('platform failure');
    }
    return { id: 'recovered', timestamp: Date.now() };
  });
  const first = stream(instance, 'target');
  const second = stream(instance, 'target');
  const rejected = assert.rejects(first.update('fail'), /platform failure/);
  await entered.promise;
  const recovered = second.update('success');
  release.resolve();
  await Promise.all([rejected, recovered]);
  first.cancel(); second.cancel();
});

test('SDK throttle timers and DONE frames use the same target queue', async () => {
  const entered = deferred();
  const release = deferred();
  const calls: string[] = [];
  const instance = bot('timer-app', async (_creds, _openid, request) => {
    calls.push(request.content_raw);
    if (request.content_raw === 'held') { entered.resolve(); await release.promise; }
    return { id: 'id', timestamp: Date.now() };
  });
  const timer = stream(instance, 'target');
  const blocker = stream(instance, 'target');
  await timer.update('initial');
  await timer.update('scheduled'); // Within the SDK's throttle window.
  const held = blocker.update('held');
  await entered.promise;
  try {
    await delay(550);
    assert.deepEqual(calls, ['initial', 'held']);
    const done = timer.complete();
    await nextTick();
    assert.deepEqual(calls, ['initial', 'held']);
    release.resolve();
    await Promise.all([held, done]);
    assert(calls.includes('scheduled'));
  } finally {
    release.resolve();
    await held;
    timer.cancel(); blocker.cancel();
  }
});
