/**
 * 出站投递车道：static-blocks 与 native-stream 同时只跑一条。
 *
 * kind=block 文本在流未占用时立即发；流已占用则跳过。
 * kind=tool 只转发新媒体。
 * kind=final 与已发 block 去重；流占用时收尾后跳过静态文本。
 */
import type { PluginLogger } from '../utils/plugin-logger.js';
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
  /** 气泡里当前已确认显示的文本；缺省表示实现方不提供该信息 */
  acceptedText?: string;
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
};

export function streamOwnsText(controller: StreamTextOwner | null): boolean {
  return Boolean(controller?.hasStarted && !controller.shouldFallbackToStatic);
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
    await sendReply({ text }, info, state.ctx);
    state.deliveredTexts.add(text);
    return;
  }

  if (streamOwnsText(state.streamingController)) {
    const controller = state.streamingController;
    if (controller && !controller.isTerminal) {
      await controller.finalize();
    }
    if (!controller?.shouldFallbackToStatic) {
      // 流式气泡已经收尾。此前这里直接 return，默认「气泡里就是全文」；
      // 一旦最后一次 update 失败、或终稿比气泡里已显示的内容更长，尾巴就会被静默丢掉。
      // 只在终稿以已显示文本为前缀时补发差额，避免重复发送。
      const accepted = controller?.acceptedText ?? '';
      if (accepted && text && text !== accepted && text.startsWith(accepted)) {
        const tail = text.slice(accepted.length);
        if (tail.trim()) {
          state.log?.warn(
            `stream accepted partial text; sending remaining tail (accepted=${accepted.length} total=${text.length} tail=${tail.length})`,
          );
          await sendReply({ text: tail }, info, state.ctx);
          state.deliveredTexts.add(text);
        }
      }
      return;
    }
    state.log?.warn(`streaming fallback to static`);
  }

  if (text && state.deliveredTexts.has(text) && !hasMedia && !payload.audioAsVoice) {
    return;
  }

  const filteredPayload = filterDeliveredMedia(payload, state.deliveredMediaUrls);
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
