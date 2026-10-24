import assert from 'node:assert/strict';
import { ApiError } from '@tencent-connect/qqbot-nodejs/protocol';
import { cacheMsgId } from '../src/features/msgid-cache.js';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { rememberReplyReferences, quotedTextOptions } from '../src/features/reply-reference.js';
import { QQBotGateway } from '../src/gateway/qqbot-gateway.js';

const account = { accountId: 'test-account', markdownSupport: true, config: {} } as any;
/** Verify exact references, cached-ID separation and narrowly scoped error fallback. */
async function main() {
  await rememberReplyReferences(account.accountId)({ message: {
    kind: 'group', messageId: 'question', msgIdx: 'REFIDX_question',
    replyTarget: { scope: 'group', targetId: 'group-a' },
  } } as any, async () => {});
  const target = { scope: 'group', targetId: 'group-a', msgId: 'question' } as const;
  const options = quotedTextOptions(account.accountId, target, 'Answer')!;
  assert.equal(options.messageReference?.message_id, 'REFIDX_question', 'reply must quote the triggering message');
  assert.equal(options.msgType, 0, 'native quotes must use the SDK-compatible plain-text lane');
  assert.equal(options.content, 'Answer');
  assert.equal(options.markdown, undefined, 'never combine a native reference with a Markdown body');
  assert.equal(quotedTextOptions('another-account', target, 'Answer'), undefined);
  assert.equal(quotedTextOptions(account.accountId, { ...target, targetId: 'group-b' }, 'Answer'), undefined);
  assert.equal(quotedTextOptions(account.accountId, { ...target, scope: 'c2c' }, 'Answer'), undefined);
  assert.equal(quotedTextOptions(account.accountId, { ...target, msgId: 'unknown' }, 'Answer'), undefined);
  assert.equal(quotedTextOptions(account.accountId, target, 'Answer')?.content, 'Answer');

  let wire: any;
  await QQBot.prototype.send.call({ messageApi: { sendRaw: async (_scope: any, _peer: any, _creds: any, body: any) => {
    wire = body; return { id: 'response' };
  } } } as any, options);
  assert.deepEqual(wire.message_reference, { message_id: 'REFIDX_question' });
  assert.equal(wire.msg_id, 'question');
  assert.equal(wire.msg_type, 0);
  assert.equal(wire.content, 'Answer');
  assert.equal(wire.markdown, undefined);

  let ordinaryMode: any;
  await QQBot.prototype.sendText.call({ messageApi: {
    sendMessage: async (_scope: any, _peer: any, content: string, _creds: any, opts: any) => {
      ordinaryMode = { content, opts }; return { id: 'ordinary-sdk' };
    },
  } } as any, target, 'Ordinary answer');
  assert.equal(ordinaryMode.content, 'Ordinary answer');
  assert.equal(ordinaryMode.opts.msgId, 'question');
  assert.equal(ordinaryMode.opts.messageReference, undefined);

  const gateway = Object.create(QQBotGateway.prototype) as any;
  gateway.account = account; gateway.textTimeout = 0;
  gateway.bot = { send: async (o: any) => { wire = o; return { id: 'sent' }; },
    sendText: async () => { throw new Error('native quote path was bypassed'); } };
  assert.equal((await gateway.sendText({ scope: 'group', targetId: 'group-a' }, 'Answer', { msgId: 'question' })).id, 'sent');
  assert.equal(wire.messageReference.message_id, 'REFIDX_question');
  // An API call without an explicit reply ID must retain ordinary text behavior,
  // even when passive-reply authorization can be restored from the peer cache.
  cacheMsgId('group', 'group-a', 'question');
  let ordinarySends = 0;
  gateway.log = { warn() {} };
  gateway.bot = {
    send: async () => { throw new Error('A cached peer ID must not select a quote'); },
    sendText: async (t: any, text: string) => {
      ordinarySends++; assert.equal(t.msgId, 'question'); assert.equal(text, 'Answer'); return { id: 'ordinary' };
    },
  };
  assert.equal((await gateway.sendText({ scope: 'group', targetId: 'group-a' }, 'Answer')).id, 'ordinary');
  assert.equal(ordinarySends, 1);
  assert.equal((await gateway.sendText({ scope: 'group', targetId: 'group-a' }, 'Answer', { msgId: undefined })).id, 'ordinary');

  // A newer cached message must never replace the explicit reply association on downgrade.
  cacheMsgId('group', 'group-a', 'newer-question');
  for (const markdownSupport of [true, false]) {
    gateway.account = { ...account, markdownSupport };
    gateway.bot.send = async (o: any) => {
      assert.equal(o.msgType, 0, 'quoted messages use plain text regardless of the account Markdown setting');
      assert.equal(o.content, 'Answer');
      assert.equal(o.markdown, undefined);
      assert.equal(o.target.msgId, 'question');
      throw new ApiError('message_reference is not supported', 400, '/v2/groups/group-a/messages');
    };
    for (const opts of [undefined, { msgId: 'question' }]) {
      const before = ordinarySends;
      assert.equal((await gateway.sendText(target, 'Answer', opts)).id, 'ordinary');
      assert.equal(ordinarySends, before + 1, 'unsupported reference must retry the original message exactly once');
    }
  }
  for (const error of [
    new ApiError('Network error', 0, '/v2/groups/group-a/messages'),
    new ApiError('message_reference not supported', 503, '/v2/groups/group-a/messages'),
    new ApiError('Rate limited', 429, '/v2/groups/group-a/messages'),
    new ApiError('Unsupported content type', 400, '/v2/groups/group-a/messages'),
    new ApiError('Invalid message_reference', 400, '/v2/groups/group-a/messages'),
    new Error('message_reference not supported'),
  ]) {
    const before = ordinarySends;
    gateway.bot.send = async () => { throw error; };
    await assert.rejects(() => gateway.sendText(target, 'Answer', { msgId: 'question' }), e => e === error);
    assert.equal(ordinarySends, before, 'ambiguous or unrelated failures must never cause a duplicate fallback send');
  }

  console.log('QQ native reply checks passed: exact triggering message, Markdown/plain text, group/account isolation, fallback and SDK wire body.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
