/**
 * ctxPayload 构建器
 *
 * 与内置版 outbound-dispatch.ts:buildCtxPayload 对齐，
 * 将 SDK 消息数据转换为 OpenClaw 框架标准的入站上下文。
 */
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import type { AssembledBody } from './body-assembler.js';
import type { OpenClawInboundMessage } from './envelope-builder.js';
import type { RuntimeAdapters } from '../adapter/resolve.js';

export interface CtxPayloadParams {
  assembled: AssembledBody;
  envelope: OpenClawInboundMessage;
  route: { sessionKey: string; accountId: string; agentId?: string };
  msg: QQBotInboundMessage;
  ctx: MiddlewareContext;
  adapters: RuntimeAdapters;
}

export function buildCtxPayload(params: CtxPayloadParams): any {
  const { assembled, envelope, route, msg, ctx, adapters } = params;

  const isSlashCommand = /^\//.test(assembled.rawBody ?? '');
  const convKind = envelope.chatScope === 'group' ? 'group' : 'direct';
  const peerId = convKind === 'group'
    ? (envelope.groupId ?? envelope.senderId)
    : envelope.senderId;
  const groupId = convKind === 'group' ? envelope.groupId : undefined;

  const processed = ctx.state.processedAttachments as any;
  const voicePaths = processed?.localMediaPaths?.filter((_: string, i: number) =>
    processed.localMediaTypes?.[i]?.startsWith('audio/')) ?? [];
  const voiceUrls = processed?.remoteMediaUrls?.filter((_: string, i: number) =>
    processed.remoteMediaUrls?.[i]?.startsWith?.('audio/')) ?? [];

  const msgTimestamp = (msg as any).timestamp ?? (msg as any).Timestamp;

  return adapters.buildInboundContext?.({
    channel: 'qqbot',
    accountId: route.accountId,
    provider: 'qqbot',
    surface: 'qqbot',
    messageId: envelope.messageId,
    timestamp: msgTimestamp ? new Date(msgTimestamp).getTime() : Date.now(),
    from: envelope.targetId,
    sender: { id: envelope.senderId, name: envelope.senderName },
    conversation: {
      kind: convKind,
      id: peerId,
      label: assembled.systemPrompt,
    },
    message: {
      body: assembled.webBody,
      bodyForAgent: assembled.agentBody,
      rawBody: assembled.rawBody,
      commandBody: assembled.rawBody,
    },
    route: {
      agentId: route.agentId ?? 'default',
      routeSessionKey: route.sessionKey,
      accountId: route.accountId,
    },
    reply: {
      to: envelope.targetId,
      replyToId: envelope.messageId,
      originatingTo: envelope.targetId,
    },
    access: {
      commands: { authorized: isSlashCommand },
    },
    command: isSlashCommand
      ? { kind: 'text-slash' as const, body: assembled.rawBody!, authorized: true }
      : undefined,
    media: voicePaths.length > 0
      ? voicePaths.map((p: string, i: number) => ({
          contentType: processed?.localMediaTypes?.[i] ?? 'audio/silk',
          localPath: p,
          url: voiceUrls[i],
        }))
      : voiceUrls.length > 0
        ? voiceUrls.map((u: string) => ({ contentType: 'audio/wav', url: u }))
        : undefined,
    supplemental: {
      quote: envelope.quote
        ? { id: envelope.messageId, body: envelope.quote.content, sender: envelope.quote.senderId }
        : undefined,
      groupSystemPrompt: envelope.systemPrompt,
    },
    extra: {
      ...(isSlashCommand ? { CommandSource: 'text' } : {}),
      ...(groupId ? { QQGroupOpenid: groupId } : {}),
      ...(processed?.localMediaPaths?.length
        ? {
            MediaPaths: processed.localMediaPaths,
            MediaPath: processed.localMediaPaths[0],
            MediaTypes: processed.localMediaTypes,
            MediaType: processed.localMediaTypes?.[0],
          }
        : {}),
      ...(processed?.remoteMediaUrls?.length
        ? {
            MediaUrls: processed.remoteMediaUrls,
            MediaUrl: processed.remoteMediaUrls[0],
          }
        : {}),
    },
  });
}
