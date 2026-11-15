/**
 * 语音转录文本格式化工具
 *
 * 将 STT / ASR 转录结果格式化为用户可读文本，注入到 AI 的入站消息中。
 */

/** 转录来源 */
export type TranscriptSource = 'stt' | 'asr' | 'fallback';

/**
 * 单条语音转录结果
 *
 * 设计原则：行存自洽 — 单条语音的转录文本、来源、媒体引用全部聚合在
 * 一个对象中，避免与 `ProcessedAttachments` 上的多个平行数组按下标对齐。
 * 渲染层（如 `buildDynamicCtx`）通过 `transcripts.map(...)` 投影出
 * `paths` / `urls` / `asrTexts` 列表。
 */
export interface VoiceTranscript {
  /** 转录文本（STT/ASR/fallback 三选一的最终结果） */
  text: string;
  /** 转录来源 */
  source: TranscriptSource;
  /** 音频时长（秒） */
  duration?: number;
  /** 本地音频路径（下载/转码后的 wav 等） */
  localPath?: string;
  /** 远端音频 URL（未本地化时的兜底引用） */
  remoteUrl?: string;
  /** 平台原始 ASR 文本（不一定等于 `text`，例如 STT 成功时 text=STT 结果） */
  asrReferText?: string;
}

/**
 * 格式化单条或多条语音转录为文本
 */
export function formatVoiceText(transcripts: VoiceTranscript[]): string {
  if (transcripts.length === 0) {
    return '';
  }
  if (transcripts.length === 1) {
    const t = transcripts[0];
    const durationStr = t.duration ? ` (${formatDuration(t.duration)})` : '';
    return `[Voice message${durationStr}] ${t.text}`;
  }
  return transcripts.map((t, i) => {
    const durationStr = t.duration ? ` (${formatDuration(t.duration)})` : '';
    return `[Voice ${i + 1}${durationStr}] ${t.text}`;
  }).join('\n');
}

/**
 * 格式化时长（秒 → "Xs" 或 "M:SS"）
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
