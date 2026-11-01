/**
 * 出站投递车道：static-blocks 与 native-stream 同时只跑一条。
 *
 * kind=block 文本在流未占用时立即发；流已占用则跳过。
 * kind=tool 只转发新媒体。
 * kind=final 与已发 block 去重；流占用时收尾后跳过静态文本。
 */
import type { PluginLogger } from '../utils/plugin-logger.js';
import { confirmOutboundSend, releaseOutboundSend, reserveOutboundSend } from './send-ledger.js';
import { formatLogTextPreview } from '../utils/log-text-preview.js';
import type {
  DeliverContext,
  DeliverInfo,
  DeliverPayload,
} from '../outbound/deliver-pipeline.js';

export type StreamTextOwner = {
  hasStarted: boolean;
  shouldFallbackToStatic: boolean;
  isTerminal: boolean;
  finalize(): Promise<void>;
};

export type DispatchDeliverState = {
  ctx: DeliverContext;
  streamingController: StreamTextOwner | null;
  deliveredMediaUrls: Set<string>;
  deliveredTexts: Set<string>;
  log?: PluginLogger;
  /** 入站消息 id，用于跨派发的发送账本（防同一段文本被重复投递） */
  inboundMessageId?: string;
  deliverReply: (
    payload: DeliverPayload,
    info: DeliverInfo | undefined,
    ctx: DeliverContext,
  ) => Promise<void>;
};

export function streamOwnsText(controller: StreamTextOwner | null): boolean {
  return Boolean(controller?.hasStarted && !controller.shouldFallbackToStatic);
}

/**
 * 跨派发去重：同一入站消息的同一段文本只发一次。
 * @returns token 表示这段文本归你发；null 表示已经发过，调用方应直接 return。
 */
function claimText(state: DispatchDeliverState, text: string): string | null {
  if (!text) return null;
  const token = reserveOutboundSend(state.ctx.accountId, state.inboundMessageId ?? state.ctx.replyToId, text);
  if (!token) {
    state.log?.warn(
      `send-ledger dropping duplicate delivery inbound=${state.inboundMessageId ?? state.ctx.replyToId ?? '-'} textLen=${text.length}`,
    );
  }
  return token;
}

/** 发送成功才保留这段文本的去重占位；失败立刻撤销，让重试还能再发一次。 */
function confirmText(state: DispatchDeliverState, text: string, token: string): void {
  if (!text) return;
  confirmOutboundSend(state.ctx.accountId, state.inboundMessageId ?? state.ctx.replyToId, text, token);
}

function releaseText(state: DispatchDeliverState, text: string, token: string): void {
  if (!text) return;
  releaseOutboundSend(state.ctx.accountId, state.inboundMessageId ?? state.ctx.replyToId, text, token);
}

export async function deliverDispatchPayload(
  payload: DeliverPayload,
  info: DeliverInfo | undefined,
  state: DispatchDeliverState,
): Promise<void> {
  const kind = info?.kind;
  const text = payload.text?.trim() ?? '';
  const hasMedia = !!(payload.mediaUrl || payload.mediaUrls?.length);
  const sendReply = state.deliverReply;
  state.log?.debug(
    `deliver kind=${kind ?? 'none'} textLen=${text.length} voice=${!!payload.audioAsVoice} media=${hasMedia}${formatLogTextPreview(text)}`,
  );

  if (kind === 'tool') {
    await forwardMediaUrls(payload, state);
    return;
  }

  if (kind === 'block') {
    if (payload.audioAsVoice) {
      await sendReply(payload, info, state.ctx);
      if (text) state.deliveredTexts.add(text);
      return;
    }
    await forwardMediaUrls(payload, state);
    if (streamOwnsText(state.streamingController) || !text || state.deliveredTexts.has(text)) {
      return;
    }
    const claim = claimText(state, text);
    if (!claim) return;
    try {
      await sendReply({ text }, info, state.ctx);
    } catch (err) {
      releaseText(state, text, claim);
      throw err;
    }
    confirmText(state, text, claim);
    state.deliveredTexts.add(text);
    return;
  }

  if (streamOwnsText(state.streamingController)) {
    if (state.streamingController && !state.streamingController.isTerminal) {
      await state.streamingController.finalize();
    }
    if (!state.streamingController?.shouldFallbackToStatic) {
      return;
    }
    state.log?.warn(`streaming fallback to static`);
  }

  // 带媒体的 final 也要参与文本去重：只跳过重复字幕，媒体仍要发。
  let textToSend = text;
  let claim: string | null = null;
  if (text && !payload.audioAsVoice) {
    if (state.deliveredTexts.has(text)) {
      textToSend = '';
    } else {
      claim = claimText(state, text);
      if (!claim) textToSend = '';
    }
  }

  const filteredPayload = filterDeliveredMedia(payload, state.deliveredMediaUrls);
  const payloadToSend = textToSend
    ? filteredPayload
    : { ...filteredPayload, text: undefined };

  // attachments 不在 mediaUrl/mediaUrls 里，不能因为 hasMedia=false 就丢掉纯附件回复。
  const attachments = (payload as { attachments?: unknown }).attachments;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  if (!textToSend && !hasMedia && !hasAttachments && !payload.audioAsVoice) {
    return;
  }

  try {
    await sendReply(payloadToSend, info, state.ctx);
  } catch (err) {
    if (claim) releaseText(state, text, claim);
    throw err;
  }
  if (claim) confirmText(state, text, claim);
  if (textToSend) state.deliveredTexts.add(textToSend);
  for (const u of payloadToSend.mediaUrls ?? []) state.deliveredMediaUrls.add(u);
  if (payloadToSend.mediaUrl) state.deliveredMediaUrls.add(payloadToSend.mediaUrl);
}

export async function deliverDispatchPayloadSafe(
  payload: DeliverPayload,
  info: DeliverInfo | undefined,
  state: DispatchDeliverState,
): Promise<void> {
  try {
    await deliverDispatchPayload(payload, info, state);
  } catch (err) {
    state.log?.error(`deliver error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function forwardMediaUrls(
  payload: DeliverPayload,
  state: DispatchDeliverState,
): Promise<void> {
  const urls: string[] = [];
  if (payload.mediaUrls?.length) urls.push(...payload.mediaUrls);
  if (payload.mediaUrl && !urls.includes(payload.mediaUrl)) urls.push(payload.mediaUrl);
  const newUrls = urls.filter((u) => !state.deliveredMediaUrls.has(u));
  for (const url of newUrls) {
    try {
      await state.ctx.sendMedia(state.ctx.qualifiedTarget, url, { text: '' });
      state.deliveredMediaUrls.add(url);
    } catch (err) {
      state.log?.error(`media forward failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function filterDeliveredMedia(
  payload: DeliverPayload,
  delivered: Set<string>,
): DeliverPayload {
  if (delivered.size === 0) return payload;
  return {
    ...payload,
    mediaUrl: payload.mediaUrl && !delivered.has(payload.mediaUrl) ? payload.mediaUrl : undefined,
    mediaUrls: payload.mediaUrls?.filter((u) => !delivered.has(u)),
  };
}
