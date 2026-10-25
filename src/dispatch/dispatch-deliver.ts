/**
 * 出站投递车道：static-blocks 与 native-stream 同时只跑一条。
 *
 * kind=block 文本在流未占用时立即发；流已占用则跳过。
 * kind=tool 只转发新媒体。
 * kind=final 与已发 block 去重；流占用时收尾后跳过静态文本。
 */
import type { PluginLogger } from '../utils/plugin-logger.js';
import { formatLogTextPreview } from '../utils/log-text-preview.js';
import { normalizeBodyForDedupe } from '../outbound/streaming-controller.js';
import type {
  DeliverContext,
  DeliverInfo,
  DeliverPayload,
} from '../outbound/deliver-pipeline.js';

export type StreamTextOwner = {
  hasStarted: boolean;
  shouldFallbackToStatic: boolean;
  isTerminal: boolean;
  /** 气泡已「成功展示并收尾」的正文；未成功展示时为空串 */
  displayedBodyText: string;
  /** 已真正推送到 QQ 流的最后一段文本 */
  lastStreamedText: string;
  /** 正文是否已由兜底路径发出 */
  bodyDelivered: boolean;
  /** deliver 层在 finalize 前注入回合最终正文 */
  setFinalText(text: string): void;
  /** 正文兜底：流未真正展示完整正文时补发完整正文 */
  sendFinalBodyIfNeeded(reason: string): Promise<void>;
  finalize(): Promise<void>;
};

export type DispatchDeliverState = {
  ctx: DeliverContext;
  streamingController: StreamTextOwner | null;
  deliveredMediaUrls: Set<string>;
  deliveredTexts: Set<string>;
  log?: PluginLogger;
  deliverReply: (
    payload: DeliverPayload,
    info: DeliverInfo | undefined,
    ctx: DeliverContext,
  ) => Promise<void>;
  /** 被流接管、尚未静态发送的中段文本（并入末条正文） */
  pendingMidText: string;
};

export function streamOwnsText(controller: StreamTextOwner | null): boolean {
  return Boolean(controller?.hasStarted && !controller.shouldFallbackToStatic);
}

/**
 * 把被流接管、尚未静态发送的中段文本（pendingMidText）折叠进末条正文。
 *
 * 中段文本早于最终正文到达 ⇒ 折叠时必须放在最终正文之前；
 * 最终正文为空（仅媒体）时也不能拼出前导换行。
 */
function foldHeldMidText(text: string, state: DispatchDeliverState): string {
  if (!state.pendingMidText) return text;
  const heldMid = state.pendingMidText;
  state.pendingMidText = '';
  if (text.includes(heldMid)) return text;
  const merged = text ? `${heldMid}\n${text}` : heldMid;
  state.log?.info(`[qqbot][guard] folded held mid block into final body (chars=${heldMid.length})`);
  return merged;
}

export async function deliverDispatchPayload(
  payload: DeliverPayload,
  info: DeliverInfo | undefined,
  state: DispatchDeliverState,
): Promise<void> {
  const kind = info?.kind;
  let text = payload.text?.trim() ?? '';
  const hasMedia = !!(payload.mediaUrl || payload.mediaUrls?.length);
  const sendReply = state.deliverReply;
  state.log?.debug(
    `deliver kind=${kind ?? 'none'} textLen=${text.length} voice=${!!payload.audioAsVoice} media=${hasMedia}${formatLogTextPreview(text)}`,
  );

  if (kind === 'tool') {
    await forwardMediaUrls(payload, state);
    return;
  }

  // 2026-10-23 v4（漏点修复）：气泡已成功展示该文本且流已收尾 ⇒ 任何静态路径都不再重发。
  // 推流失败 / 流未完成 ⇒ displayedBodyText 为空串 ⇒ 不命中，静态兜底照旧送达。
  if (
    text && !hasMedia && !payload.audioAsVoice && state.streamingController
    && normalizeBodyForDedupe(text) === normalizeBodyForDedupe(state.streamingController.displayedBodyText)
  ) {
    state.deliveredTexts.add(text);
    state.log?.info(`[qqbot][guard] text already shown in stream bubble - static re-send skipped (chars=${text.length} kind=${kind ?? 'none'})`);
    return;
  }

  if (kind === 'block') {
    if (payload.audioAsVoice) {
      await sendReply(payload, info, state.ctx);
      if (text) state.deliveredTexts.add(text);
      return;
    }
    await forwardMediaUrls(payload, state);
    if (!text || state.deliveredTexts.has(text)) {
      return;
    }
    if (streamOwnsText(state.streamingController)) {
      const mid = state.pendingMidText ? `${state.pendingMidText}\n${text}` : text;
      // 2026-10-23 v5（STAGE E）：流已接管正文 ⇒ 中段 block 结构上不再静态发送（气泡就是交付通道）。
      // 文本保留在 pendingMidText：投递层随后并入末条正文（H3 推入气泡；气泡不可用时由兜底静态发送兜住）。
      state.pendingMidText = mid;
      state.log?.info(`[qqbot][guard][E] mid block not sent statically - stream owns text (chars=${mid.length} alreadyShown=${Boolean(state.streamingController && normalizeBodyForDedupe(mid) === normalizeBodyForDedupe(state.streamingController.lastStreamedText))})`);
      return;
    }
    await sendReply({ text }, info, state.ctx);
    state.deliveredTexts.add(text);
    return;
  }

  if (text && state.deliveredTexts.has(text) && !hasMedia && !payload.audioAsVoice) {
    if (streamOwnsText(state.streamingController) && state.streamingController && !state.streamingController.isTerminal) {
      state.streamingController.setFinalText(text);
      await state.streamingController.finalize();
    }
    return;
  }

  if (state.streamingController?.bodyDelivered) {
    if (text) state.deliveredTexts.add(text);
    return;
  }

  if (streamOwnsText(state.streamingController)) {
    text = foldHeldMidText(text, state);
    if (state.streamingController) {
      state.streamingController.setFinalText(text);
    }
    if (state.streamingController && !state.streamingController.isTerminal) {
      await state.streamingController.finalize();
    } else if (state.streamingController) {
      await state.streamingController.sendFinalBodyIfNeeded('already_terminal');
    }
    if (!state.streamingController?.shouldFallbackToStatic) {
      return;
    }
    state.log?.warn(`streaming fallback to static`);
  }

  // 流在首块被接受前失败（shouldFallbackToStatic）时，上面的折叠分支不会执行，
  // 中段文本仍挂在 pendingMidText 上 ⇒ 静态兜底前必须再折叠一次，否则中段内容丢失。
  text = foldHeldMidText(text, state);

  if (text && state.deliveredTexts.has(text) && !hasMedia && !payload.audioAsVoice) {
    return;
  }

  // 静态兜底必须带上折叠后的正文：流在首块被接受前失败时（shouldFallbackToStatic），
  // 控制器不会走自己的兜底发送，这里是唯一出口；用原始 payload 会丢掉 pendingMidText。
  const fallbackPayload = text && text !== (payload.text?.trim() ?? '')
    ? { ...payload, text }
    : payload;
  const filteredPayload = filterDeliveredMedia(fallbackPayload, state.deliveredMediaUrls);
  const payloadToSend = text && state.deliveredTexts.has(text)
    ? { ...filteredPayload, text: undefined }
    : filteredPayload;
  await sendReply(payloadToSend, info, state.ctx);
  if (text) state.deliveredTexts.add(text);
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
