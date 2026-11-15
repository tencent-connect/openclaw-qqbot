/**
 * 信封构建器
 *
 * 将 SDK MiddlewareContext 中由各中间件填充的 state 数据
 * 转换为 OpenClaw 框架标准的 InboundMessage 结构。
 */
import type { MiddlewareContext, QQBotInboundMessage, HistoryEntry, ResolvedQuote } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';

/**
 * OpenClaw 入站消息结构（传递给 runtime.channel.dispatch）
 */
export interface OpenClawInboundMessage {
  channelId: string;
  accountId: string;
  targetId: string;
  chatScope: 'direct' | 'group';
  senderId: string;
  senderName?: string;
  messageId: string;
  content: string;
  history?: Array<{ role: string; content: string; senderId?: string; senderName?: string }>;
  quote?: { content: string; senderId: string; attachments?: unknown[] };
  attachments?: unknown[];
  /** 入站图片 URL 列表（从附件中提取） */
  imageUrls?: string[];
  groupId?: string;
  systemPrompt?: string;
}

/**
 * 将 HistoryEntry 转换为 OpenClaw 历史格式
 */
function mapHistory(
  entries: HistoryEntry[] | undefined,
): OpenClawInboundMessage['history'] {
  if (!entries || entries.length === 0) return undefined;
  return entries.map((e) => ({
    role: 'user',
    content: e.content,
    senderId: e.senderId,
    senderName: e.senderName,
  }));
}

/**
 * 将 ResolvedQuote 转换为 OpenClaw quote 格式
 */
function mapQuote(
  quote: ResolvedQuote | undefined,
): OpenClawInboundMessage['quote'] {
  if (!quote) return undefined;
  return {
    content: quote.text,
    senderId: quote.entry?.senderId ?? '',
    attachments: quote.attachments as unknown[],
  };
}

/**
 * 从 SDK 中间件上下文构建 OpenClaw InboundMessage
 */
export function buildEnvelope(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
): OpenClawInboundMessage {
  const scope = msg.replyTarget.scope;
  const targetId = scope === 'group'
    ? `qqbot:group:${msg.replyTarget.targetId}`
    : `qqbot:c2c:${msg.replyTarget.targetId}`;

  // envelope 是 string 类型，直接作为 content 使用；回退到原始消息内容
  const envelope = ctx.state.envelope as string | undefined;
  let content = envelope ?? msg.content;

  // 将语音转录文本和附件信息注入到 content 中
  const processed = ctx.state.processedAttachments as
    | { voiceText?: string; imageUrls?: string[]; otherInfo?: string }
    | undefined;

  if (processed) {
    const parts: string[] = [];
    if (processed.voiceText) {
      parts.push(processed.voiceText);
    }
    if (content) {
      parts.push(content);
    }
    if (processed.otherInfo) {
      parts.push(processed.otherInfo);
    }
    content = parts.join('\n');
  }

  return {
    channelId: 'qqbot',
    accountId: account.accountId,
    targetId,
    chatScope: scope === 'group' ? 'group' : 'direct',
    senderId: msg.senderId,
    senderName: msg.senderName,
    messageId: msg.messageId,
    content,
    history: mapHistory(ctx.state.history as HistoryEntry[] | undefined),
    quote: mapQuote(ctx.state.quote as ResolvedQuote | undefined),
    attachments: msg.attachments,
    imageUrls: processed?.imageUrls,
    groupId: scope === 'group' ? msg.replyTarget.targetId : undefined,
    systemPrompt: account.systemPrompt,
  };
}
