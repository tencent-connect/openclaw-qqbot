/**
 * 出站 Deliver Pipeline — 处理 AI 回复的富媒体分发
 *
 * 框架通过 ReplyPayload 结构化字段投递回复：
 *   - text:         纯文本
 *   - mediaUrl:     单个媒体 URL
 *   - mediaUrls:    多个媒体 URL
 *   - audioAsVoice: 语音气泡（TTS）
 *
 * Pipeline 按顺序处理：
 *   1. 语音意图 — audioAsVoice (TTS → SILK → 发送)
 *   2. 媒体发送 — mediaUrl / mediaUrls（图片/文件/视频）
 *   3. 纯文本回复 — 走 debounce 合并
 */
import { sendMedia } from './media-send.js';
import type { MediaKind, SendResult } from './outbound-service.js';
import type { DeliverDebouncer } from './debounce.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { formatLogTextPreview } from '../utils/log-text-preview.js';
import { isPathInAllowedRoots } from './local-file-router.js';
import * as path from 'node:path';
import * as os from 'node:os';

// ── 类型 ──

export interface DeliverPayload {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
}

export interface DeliverInfo {
  kind: string;
}

export interface DeliverContext {
  qualifiedTarget: string;
  accountId: string;
  replyToId: string;
  /** 会话类型（用于判断语音是否可用） */
  chatScope?: 'direct' | 'group';
  /** 发送文本 */
  sendText: (to: string, text: string) => Promise<SendResult>;
  /** 发送媒体 */
  sendMedia: (to: string, source: string, opts?: { text?: string; mediaKind?: MediaKind }) => Promise<SendResult>;
  /** TTS 文字转语音（返回本地音频路径，失败返回 null） */
  textToSpeech?: (params: { text: string; cfg?: unknown; channel?: string; accountId?: string }) => Promise<{ audioPath: string | null; error?: string }>;
  /** 音频文件转 SILK Base64（QQ 语音格式） */
  audioFileToSilkBase64?: (audioPath: string) => Promise<string | null>;
  /** 出站文本合并防抖（可选，启用时纯文本走 debounce） */
  debouncer?: DeliverDebouncer;
  /** 运行时配置 */
  cfg?: unknown;
  /** 日志 */
  log?: PluginLogger;
  /** Agent ID（用于解析相对文件路径的工作区） */
  agentId?: string;
}

/**
 * 解析 ReplyPayload 中的媒体 URL 列表（优先 mediaUrls，fallback 单个 mediaUrl）
 */
function resolveMediaUrls(payload: DeliverPayload): string[] {
  if (payload.mediaUrls?.length) {
    return payload.mediaUrls.filter(Boolean);
  }
  if (payload.mediaUrl) {
    return [payload.mediaUrl];
  }
  // attachments[].path → 本地文件路径（findLocalPath() 展开可能相对路径）
  return resolveAttachmentPaths(payload);
}

function resolveAttachmentPaths(payload: DeliverPayload): string[] {
  const attachments = (payload as any).attachments as Array<{ path?: string; url?: string }> | undefined;
  if (!attachments?.length) return [];
  return attachments
    .map((a) => a.url ?? a.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * 出站 Deliver Pipeline
 *
 * 按顺序处理：
 * 1. 语音意图 → TTS
 * 2. 媒体发送 → mediaUrl / mediaUrls
 * 3. 纯文本回复 → debounce 合并
 */
export async function deliverReply(
  payload: DeliverPayload,
  _info: DeliverInfo | undefined,
  ctx: DeliverContext,
): Promise<void> {
  const text = payload.text?.trim() ?? '';
  const mediaUrls = resolveMediaUrls(payload);
  const hasMedia = mediaUrls.length > 0;

  ctx.log?.debug(
    `[text] textLen=${text.length} mediaCount=${mediaUrls.length}${formatLogTextPreview(text)}`,
  );

  // ── Layer 1: 语音意图 ──
  if (payload.audioAsVoice) {
    if (ctx.textToSpeech && text) {
      const handled = await handleVoiceIntent(text, ctx);
      if (handled) {
        return; // 语音已发送，不再重复发送媒体或文本
      }
    }
    // TTS 不可用或合成失败 → 降级为纯文本 + 媒体
  }

  // ── Layer 2: 媒体发送 ──
  if (hasMedia) {
    await sendMediaUrls(ctx, mediaUrls);
    // 附带文本一并发送
    if (text) {
      const result = await ctx.sendText(ctx.qualifiedTarget, text);
      if (result.error) {
        ctx.log?.error(`[media] sendText failed: ${result.error}`);
      }
    }
    return;
  }

  // ── Layer 3: 纯文本回复 ──
  if (!text) return;

  if (ctx.debouncer) {
    await ctx.debouncer.enqueue(ctx.qualifiedTarget, text);
  } else {
    const result = await ctx.sendText(ctx.qualifiedTarget, text);
    if (result.error) {
      ctx.log?.error(`[text] sendText failed: ${result.error}`);
    }
  }
}

// ── 媒体批量发送 ──

async function sendMediaUrls(ctx: DeliverContext, urls: string[]): Promise<void> {
  const failedUrls: string[] = [];
  for (const url of urls) {
    const result = await sendMedia({
      to: ctx.qualifiedTarget,
      source: url,
      replyToId: ctx.replyToId,
      accountId: ctx.accountId,
      log: ctx.log,
      agentId: ctx.agentId,
    });
    if (result.error) {
      ctx.log?.error(`[media] ${result.error}`);
      failedUrls.push(url);
    }
  }

  // 媒体发送失败时通知用户
  if (failedUrls.length > 0) {
    const count = failedUrls.length;
    const total = urls.length;
    const failMsg = count === total
      ? `⚠️ 媒体发送失败（${count} 个），请重试`
      : `⚠️ ${count}/${total} 个媒体发送失败`;
    const textResult = await ctx.sendText(ctx.qualifiedTarget, failMsg);
    if (textResult.error) {
      ctx.log?.error(`[media] failed to send failure notification: ${textResult.error}`);
    }
  }
}

// ── 语音意图处理 ──

async function handleVoiceIntent(text: string, ctx: DeliverContext): Promise<boolean> {
  if (!text || !ctx.textToSpeech) return false;

  // 仅 c2c/group 支持语音消息；其他场景 fallback 发文本
  if (ctx.chatScope && ctx.chatScope !== 'direct' && ctx.chatScope !== 'group') {
    return false;
  }

  try {
    const ttsResult = await ctx.textToSpeech({
      text,
      cfg: ctx.cfg,
      channel: 'qqbot',
      accountId: ctx.accountId,
    });

    if (!ttsResult.audioPath) {
      ctx.log?.error(`[tts] TTS failed: ${ttsResult.error ?? 'no audio path returned'}`);
      return false;
    }

    // TTS 路径安全校验：确保音频文件在允许的临时目录内
    if (!isTtsPathSafe(ttsResult.audioPath)) {
      ctx.log?.error(`[tts] TTS audio path blocked: ${ttsResult.audioPath}`);
      return false;
    }

    // 优先走 SILK base64
    if (ctx.audioFileToSilkBase64) {
      const silkBase64 = await ctx.audioFileToSilkBase64(ttsResult.audioPath);
      if (silkBase64) {
        const result = await ctx.sendMedia(ctx.qualifiedTarget, silkBase64, { mediaKind: 'voice' });
        if (result.error) ctx.log?.error(`[tts] sendVoice(base64) failed: ${result.error}`);
        return !result.error;
      }
      ctx.log?.error(`[tts] SILK conversion failed, trying localPath fallback`);
    }

    // Fallback: 直接发本地路径（SDK 内部处理格式转换）
    const result = await ctx.sendMedia(ctx.qualifiedTarget, ttsResult.audioPath, { mediaKind: 'voice' });
    if (result.error) {
      ctx.log?.error(`[tts] sendVoice(localPath) failed: ${result.error}`);
      return false;
    }
    return true;
  } catch (err) {
    ctx.log?.error(`[tts] TTS/voice send failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ── TTS 路径安全 ──

const TTS_ALLOWED_ROOTS = [
  path.join(os.homedir(), '.openclaw'),
  os.tmpdir(),
  '/tmp',
];

function isTtsPathSafe(audioPath: string): boolean {
  if (!path.isAbsolute(audioPath)) return false;
  return isPathInAllowedRoots(audioPath, TTS_ALLOWED_ROOTS);
}
