/**
 * 出站消息服务
 *
 * 负责将 AI 回复通过 QQBotGateway 发送到 QQ。
 * 超时保护由 QQBotGateway 内部统一处理，本层做 target 解析 + 被动回复限额管控。
 */
import * as path from 'node:path';
import { MediaFileType } from '@tencent-connect/qqbot-nodejs';
import { QQBotGateway } from '../gateway/index.js';
import type { ResolvedQQBotAccount } from '../types.js';
import { parseTarget } from './target.js';
import { ReplyLimiter } from './reply-limiter.js';
import { isInvalidMsgIdError } from './msgid-error.js';

// ── Gateway + Limiter 注册表（生命周期由 channel.ts 管理）──

const gateways = new Map<string, QQBotGateway>();
const limiters = new Map<string, ReplyLimiter>();

function getLimiter(accountId: string): ReplyLimiter {
  let l = limiters.get(accountId);
  if (!l) {
    l = new ReplyLimiter();
    limiters.set(accountId, l);
  }
  return l;
}

/**
 * 解析 replyToId：超出被动回复限额时自动降级为主动消息（不传 msgId）。
 * @returns 实际使用的 msgId（超限时为 undefined）
 */
function resolveMsgId(replyToId: string | undefined, accountId: string): string | undefined {
  if (!replyToId) return undefined;
  const limiter = getLimiter(accountId);
  const result = limiter.checkLimit(replyToId);
  if (!result.allowed) return undefined;
  limiter.record(replyToId);
  return replyToId;
}

function expireMsgId(replyToId: string | undefined, accountId: string): void {
  if (!replyToId) return;
  getLimiter(accountId).expire(replyToId);
}

/**
 * 发送并处理被动回复 msg_id 失效。
 *
 * QQ 的 msg_id 只在 5 分钟内有效，超时或额度用尽后平台会直接拒绝。
 * 第一次发送因此失败时消息肯定没发出去，去掉 msgId 重发一次（主动消息），
 * 既能把回复送到，也避免核心把投递记为 send_attempt_started / unknown，
 * 进而给用户发 "couldn't confirm whether my previous reply reached this chat"。
 */
async function sendWithMsgIdFallback<T>(
  replyToId: string | undefined,
  accountId: string,
  send: (msgId: string | undefined) => Promise<T>,
): Promise<T> {
  const msgId = resolveMsgId(replyToId, accountId);
  try {
    return await send(msgId);
  } catch (err) {
    if (!msgId || !isInvalidMsgIdError(err)) throw err;
    expireMsgId(replyToId, accountId);
    return await send(undefined);
  }
}

export function registerGateway(accountId: string, gw: QQBotGateway): void {
  gateways.set(accountId, gw);
}

export function unregisterGateway(accountId: string): void {
  gateways.delete(accountId);
  limiters.delete(accountId);
}

export function getGateway(accountId: string): QQBotGateway | undefined {
  return gateways.get(accountId);
}

/** gateway 未运行时，惰性构造 send-only 实例并注册进 Map 缓存复用 */
function getOrCreateGateway(account: ResolvedQQBotAccount): QQBotGateway {
  let gw = gateways.get(account.accountId);
  if (!gw) {
    gw = new QQBotGateway(account);
    gateways.set(account.accountId, gw);
  }
  return gw;
}

// ── 媒体类型映射 ──

export type MediaKind = 'image' | 'voice' | 'video' | 'file';

const MEDIA_KIND_TO_FILE_TYPE: Record<MediaKind, MediaFileType> = {
  image: MediaFileType.IMAGE,
  voice: MediaFileType.VOICE,
  video: MediaFileType.VIDEO,
  file: MediaFileType.FILE,
};

export { isInvalidMsgIdError } from './msgid-error.js';

export interface SendResult {
  messageId?: string;
  error?: string;
  errorCode?: string;
  qqBizCode?: number;
}

// ── 公开 API（channel.ts / deliver-pipeline.ts 调用）──

export async function sendText(params: {
  to: string;
  text: string;
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
}): Promise<SendResult> {
  const accountId = params.account.accountId;
  const gw = getOrCreateGateway(params.account);
  try {
    const target = parseTarget(params.to);
    const result = await sendWithMsgIdFallback(params.replyToId, accountId, (msgId) =>
      gw.sendText(target, params.text, { msgId }));
    return { messageId: result.id };
  } catch (err: unknown) { return formatError(err); }
}

export async function sendMedia(params: {
  to: string;
  text?: string;
  mediaUrl: string;
  mediaKind?: MediaKind;
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
}): Promise<SendResult> {
  const accountId = params.account.accountId;
  const gw = getOrCreateGateway(params.account);
  try {
    const target = parseTarget(params.to);
    const kind = params.mediaKind ?? 'image';
    const result = await sendWithMsgIdFallback(params.replyToId, accountId, (msgId) => {
      if (kind === 'voice') {
        const source = resolveVoiceSource(params.mediaUrl);
        return gw.sendVoice(target, source, { text: params.text, msgId });
      }
      if (kind === 'video') {
        return gw.sendVideo(target, params.mediaUrl, { text: params.text, msgId });
      }
      if (kind === 'file') {
        return gw.sendFile(target, params.mediaUrl, { text: params.text, msgId });
      }
      const fileType = MEDIA_KIND_TO_FILE_TYPE[kind];
      return gw.sendMedia(target, params.mediaUrl, { text: params.text, msgId, fileType });
    });
    return { messageId: result.id };
  } catch (err: unknown) { return formatError(err); }
}

export async function sendVoice(params: {
  to: string;
  source: { url?: string; base64?: string };
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
}): Promise<SendResult> {
  const accountId = params.account.accountId;
  const gw = getOrCreateGateway(params.account);
  try {
    const target = parseTarget(params.to);
    const result = await sendWithMsgIdFallback(params.replyToId, accountId, (msgId) =>
      gw.sendVoice(target, params.source, { msgId }));
    return { messageId: result.id };
  } catch (err: unknown) { return formatError(err); }
}

export async function sendVideo(params: {
  to: string;
  videoUrl: string;
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
}): Promise<SendResult> {
  const accountId = params.account.accountId;
  const gw = getOrCreateGateway(params.account);
  try {
    const target = parseTarget(params.to);
    const result = await sendWithMsgIdFallback(params.replyToId, accountId, (msgId) =>
      gw.sendVideo(target, params.videoUrl, { msgId }));
    return { messageId: result.id };
  } catch (err: unknown) { return formatError(err); }
}

// ── OutboundService（deliver-pipeline 专用）──

export class OutboundService {
  constructor(private readonly gw: QQBotGateway, private readonly accountId: string) {}

  async sendText(to: string, text: string, msgId?: string): Promise<SendResult> {
    try {
      const target = parseTarget(to);
      const result = await sendWithMsgIdFallback(msgId, this.accountId, (resolvedMsgId) =>
        this.gw.sendText(target, text, { msgId: resolvedMsgId }));
      return { messageId: result.id };
    } catch (err: unknown) { return formatError(err); }
  }

  async sendMedia(to: string, source: string, opts?: { text?: string; msgId?: string; mediaKind?: MediaKind }): Promise<SendResult> {
    try {
      const target = parseTarget(to);
      const kind = opts?.mediaKind ?? 'image';
      const result = await sendWithMsgIdFallback(opts?.msgId, this.accountId, (resolvedMsgId) => {
        if (kind === 'voice') {
          const voiceSource = resolveVoiceSource(source);
          return this.gw.sendVoice(target, voiceSource, { text: opts?.text, msgId: resolvedMsgId });
        }
        if (kind === 'video') {
          return this.gw.sendVideo(target, source, { text: opts?.text, msgId: resolvedMsgId });
        }
        if (kind === 'file') {
          return this.gw.sendFile(target, source, { text: opts?.text, msgId: resolvedMsgId, fileName: path.basename(source) });
        }
        const fileType = MEDIA_KIND_TO_FILE_TYPE[kind];
        return this.gw.sendMedia(target, source, { text: opts?.text, msgId: resolvedMsgId, fileType });
      });
      return { messageId: result.id };
    } catch (err: unknown) { return formatError(err); }
  }
}

// ── 辅助 ──

function resolveVoiceSource(source: string): { url?: string; base64?: string; localPath?: string } {
  if (source.startsWith('http://') || source.startsWith('https://')) return { url: source };
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) return { localPath: source };
  if (source.startsWith('data:')) {
    const i = source.indexOf(',');
    return { base64: i > 0 ? source.slice(i + 1) : source };
  }
  return { base64: source };
}

function formatError(err: unknown): SendResult {
  if (err instanceof Error) {
    const result: SendResult = { error: err.message };
    if ('code' in err) result.errorCode = String((err as any).code);
    if ('qqBizCode' in err) result.qqBizCode = (err as any).qqBizCode;
    return result;
  }
  return { error: String(err) };
}
