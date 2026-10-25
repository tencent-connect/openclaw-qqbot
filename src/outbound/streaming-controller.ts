/**
 * QQ Bot 流式消息控制器
 *
 * 核心约束：QQ 流式 API 替换模式下，已下发文本的**前缀不可变更**。
 *
 * 状态机：
 *   IDLE → (first chunk) → STREAMING → (complete) → DONE
 *                                      → (prefix changed) → DONE
 *                                      → (new reply) → IDLE → …
 *
 * onPartialReply(text) 输入：模型全量文本，持续增长。
 * finalize()           标记：框架通知回复结束，用 lastAccepted 收尾。
 */

import type { ReplyTarget, StreamSession } from '@tencent-connect/qqbot-nodejs';
import { isStreamAlreadySubmittedError } from '@tencent-connect/qqbot-nodejs/protocol';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { QQBotGateway } from '../gateway/qqbot-gateway.js';

// ── 类型 ──

export type StreamingPhase = 'idle' | 'streaming' | 'done' | 'failed';

/**
 * 依赖包 `StreamSession` 的内部状态视图。
 *
 * `isCompleted` 在依赖包内是 private 成员，插件侧不做直接写入（见 NOTES.md
 * 「跨仓库耦合」一节）：插件只读该状态，写入统一走 `noteFinalizedSession()`
 * 内的结构化判定。这里用结构化类型做只读访问，避免 `any`。
 */
type StreamSessionCompletionState = { readonly isCompleted: boolean };

export interface StreamingControllerDeps {
  gateway: QQBotGateway;
  target: ReplyTarget;
  accountId: string;
  replyToId: string;
  log?: PluginLogger;
  /**
   * 正文兜底发送（非流式单条）：流未真正展示完整正文时，把完整正文补发出去。
   * 由 dispatch 层注入（deliverCtx.sendText）。
   */
  sendFallback?: (body: string) => Promise<{ error?: string } | undefined>;
}

// ── 2026-10-20 body-fallback guard（本地补丁）：单回合草稿上限 ──
// 2026-10-23 v3（H4）：上限 2 → 8。理据：流帧走 sendC2CStreamMessage
// （StreamSession.update/complete），不经过 resolveMsgId/ReplyLimiter，因此草稿不挤占正文额度；
// 保留上限仅为防刷屏 / 防过量流 API 调用（6~10 区间取中值 8）。
/**
 * 单个流会话允许的最大草稿（draft）片数。
 *
 * 超出后不再推送新草稿，剩余正文由最终正文一次性送出，避免刷屏。
 */
const QQBOT_STREAM_MAX_DRAFTS = 8;

// ── 控制器 ──

export class StreamingController {
  private phase: StreamingPhase = 'idle';
  private session: StreamSession | null = null;

  /** QQ 已接受的最新文本 — 单源真理 */
  private lastAcceptedFull = '';

  /** 已成功发送的分片数（降级：=0 则走静态消息兜底） */
  private sentChunkCount = 0;

  /** 同步标志：收到第一个 onPartialReply 即置 true（不等 async 完成） */
  private _hasStarted = false;

  /** 串行队列 */
  private chain: Promise<unknown> = Promise.resolve();

  /** 已真正推送到 QQ 流的最后一段文本（草稿达上限后不再推送） */
  lastStreamedText = '';

  /** 回合最终正文：由 deliver 层在 finalize 前注入 */
  private finalBody = '';

  /** 正文是否已由兜底路径发出（防止与静态兜底重复发送） */
  bodyDelivered = false;

  /** 2026-10-23 v5（STAGE E）：完整正文已成功推入气泡并收尾（气泡即全文 ⇒ 静态末条不再发） */
  private bodyShownInStream = false;

  /** 2026-10-23 v5（STAGE E）：上次成功推入并收尾的正文文本（用于确认气泡确实含完整正文） */
  private streamedBodyText = '';

  /** 2026-10-24 v6（STAGE F）：已就「平台已定稿该流消息」告警过一次（每回合只记一次 warn） */
  private streamFinalizedNotified = false;

  constructor(private readonly deps: StreamingControllerDeps) {}

  // ── 公共访问器 ──

  get currentPhase(): StreamingPhase { return this.phase; }

  /** 是否已成功发送至少一个流式分片 */
  get hasSentChunks(): boolean { return this.sentChunkCount > 0; }

  /** 同步标志：流式已启动（不等异步完成），用于 final 去重 */
  get hasStarted(): boolean { return this._hasStarted; }

  get isTerminal(): boolean {
    return this.phase === 'done' || this.phase === 'failed';
  }

  get shouldFallbackToStatic(): boolean {
    return this.isTerminal && this.sentChunkCount === 0;
  }

  /** 2026-10-23 v4：气泡已「成功展示并收尾」的正文；未成功展示时为空串。
   *  投递层据此判重：气泡已含该文本时，任何静态重发都应跳过（正文不丢）。 */
  get displayedBodyText(): string {
    return this.phase === 'done' ? this.lastStreamedText || '' : '';
  }

  // ── 入口 ──

  onPartialReply(text: string): Promise<void> {
    this._hasStarted = true; // 同步置位：不等异步发送，final 就能感知流式已启动
    this.chain = this.chain.then(() => this.handleChunk(text)).catch((err) => {
      this.deps.log?.error(`onPartialReply error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'chunk_error');
    });
    return this.chain as Promise<void>;
  }

  finalize(): Promise<void> {
    this.chain = this.chain.then(() => this.handleFinalize()).catch((err) => {
      this.deps.log?.error(`finalize error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'finalize_error');
    });
    return this.chain as Promise<void>;
  }

  async abort(reason?: string): Promise<void> {
    if (this.isTerminal) return;
    this.deps.log?.warn(`aborting stream reason=${reason ?? 'manual'} sent=${this.sentChunkCount}`);
    if (this.session) {
      try { await this.session.complete(); } catch (e) {
        if (isStreamAlreadySubmittedError(e)) {
          this.deps.log?.warn(`[qqbot][guard][F] abort complete skipped - platform already finalized the stream message`);
        } else {
          this.deps.log?.error(`abort complete failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.session = null;
    }
    this.transition('failed', `abort:${reason ?? 'manual'}`);
  }

  // ── 核心逻辑 ──

  private async handleChunk(text: string): Promise<void> {
    if (this.isTerminal || !text) return;

    // 正常续写：新文本前缀匹配（含空白归一化）
    if (prefixMatches(this.lastAcceptedFull, text)) {
      if (text.length !== this.lastAcceptedFull.length) {
        await this.sendUpdate(text);
      }
      return;
    }

    // 无已下发内容 → 首发
    if (!this.lastAcceptedFull) {
      await this.sendUpdate(text);
      return;
    }

    // 前缀不匹配 — 长度回退 → 新回复（工具调用后）
    if (text.length < this.lastAcceptedFull.length) {
      this.deps.log?.info(`new reply: lastAccepted=${this.lastAcceptedFull.length}→chunk=${text.length}`);
      await this.completeSession('new_reply');
      // 2026-10-24 v6（STAGE F/F4）：拆分后不再对旧会话做任何 update/complete。
      // completeSession("new_reply") 内部已把旧会话收尾并置空；此处显式重申该不变量
      // （源码确认没有其它持有旧会话引用的路径），随后 sendUpdate 才会开新会话。
      this.session = null;
      this.lastAcceptedFull = '';
      await this.sendUpdate(text);
      return;
    }

    // 前缀不匹配但长度增长 → 模型重写尾部，同一条流追加
    const commonLen = longestCommonPrefix(this.lastAcceptedFull, text);
    const extra = text.slice(Math.max(commonLen, 0));
    const merged = this.lastAcceptedFull + extra;
    this.deps.log?.warn(
      `prefix retry: lastAccepted=${this.lastAcceptedFull.length}→chunk=${text.length} common=${commonLen} extra=${extra.length}, appending`,
    );
    await this.sendUpdate(merged);
  }

  private async handleFinalize(): Promise<void> {
    if (this.isTerminal) return;

    // 用已下发文本收尾 — 不用框架 deliver 的文本（框架可能追加 ⚠️ 标记）
    if (this.session) {
      await this.completeSession(undefined, { final: true });
      this.transition('done', 'finalize');
      this.deps.log?.info(`stream done chunks=${this.sentChunkCount} chars=${this.lastAcceptedFull.length}`);
      return;
    }

    // 无会话 — 视有无下发决定终态
    if (this.sentChunkCount > 0) {
      this.transition('done', 'finalize:no_session');
      await this.sendFinalBodyIfNeeded('finalize:no_session');
    } else {
      this.transition('failed', 'finalize:fallback');
    }
  }

  // ── QQ 交互 ──

  private async sendUpdate(text: string): Promise<void> {
    if (this.sentChunkCount >= QQBOT_STREAM_MAX_DRAFTS) {
      this.lastAcceptedFull = text;
      this.deps.log?.info(`[qqbot][guard] draft cap reached (max=${QQBOT_STREAM_MAX_DRAFTS}) - holding text for final send (chars=${text.length})`);
      return;
    }
    if (!this.session) {
      this.session = this.deps.gateway.openStream(this.deps.target, this.deps.replyToId);
      this.transition('streaming', 'first_chunk');
      this.deps.log?.info(`stream opened (firstChunk=${text.length})`);
    }
    try {
      await this.session.update(text);
      this.lastAcceptedFull = text;
      this.lastStreamedText = text;
      this.sentChunkCount++;
    } catch (err) {
      if (isStreamAlreadySubmittedError(err)) {
        this.deps.log?.warn(`[qqbot][guard][F] stream update rejected - platform already finalized the stream message (len=${text.length})`);
      } else {
        this.deps.log?.error(`update failed (len=${text.length}): ${err instanceof Error ? err.message : String(err)}`);
      }
      this.session = null;
      this.transition('failed', 'update_error');
    }
  }

  private async completeSession(
    reason?: string,
    opts?: { final?: boolean },
  ): Promise<void> {
    const tag = reason ?? 'done';
    const isFinal = Boolean(opts?.final);
    if (this.session) {
      let streamShowsFullBody = false;
      // 2026-10-24 v6（STAGE F/F1）：平台已定稿该会话（isCompleted，或本次 update 被拒）=> 不再 update/complete
      let sessionFinalized = (this.session as unknown as StreamSessionCompletionState).isCompleted === true;
      if (sessionFinalized) {
        this.noteFinalizedSession(`reason=${tag} source=session_state`);
      }
      if (isFinal && !sessionFinalized) {
        const held = this.lastAcceptedFull || '';
        const injected = this.finalBody || '';
        const full = held.length > injected.length ? held : injected;
        if (full) {
          try {
            await this.session.update(full);
            this.lastAcceptedFull = full;
            streamShowsFullBody = true;
            this.deps.log?.info(`[qqbot][guard] final body pushed to stream (chars=${full.length})`);
          } catch (err) {
            if (isStreamAlreadySubmittedError(err)) {
              sessionFinalized = true;
              this.noteFinalizedSession(`reason=${tag} chars=${full.length}`);
            } else {
              this.deps.log?.error(`[qqbot][guard] final body stream push failed (static fallback will send): ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
      if (!sessionFinalized) {
        this.deps.log?.info(`completing stream (sent=${this.sentChunkCount} chars=${this.lastAcceptedFull.length} reason=${tag})`);
        try {
          await this.session.complete();
          if (streamShowsFullBody) {
            this.lastStreamedText = this.lastAcceptedFull;
            this.streamedBodyText = this.lastAcceptedFull;
            this.bodyShownInStream = true;
          }
        } catch (err) {
          if (isStreamAlreadySubmittedError(err)) {
            this.noteFinalizedSession(`reason=${tag} stage=complete`);
          } else {
            this.deps.log?.error(`complete failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      this.session = null;
    } else if (isFinal) {
      this.deps.log?.info(`completing stream (sent=${this.sentChunkCount} chars=${this.lastAcceptedFull.length} reason=${tag}) [no live session - body fallback path]`);
    }
    if (isFinal) {
      if (this.lastAcceptedFull.length > this.finalBody.length) {
        this.setFinalText(this.lastAcceptedFull);
      }
      await this.sendFinalBodyIfNeeded(tag);
    }
  }

  /** 2026-10-24 v6（STAGE F）：记为「平台已定稿该流消息」——把会话标记为已收尾 + 每回合只记一次 warn */
  private noteFinalizedSession(detail: string): void {
    if (this.session) {
      (this.session as unknown as { isCompleted: boolean }).isCompleted = true;
    }
    if (this.streamFinalizedNotified) return;
    this.streamFinalizedNotified = true;
    this.deps.log?.warn(`[qqbot][guard][F] stream message already submitted on platform - session finalized, static fallback path expected (${detail})`);
  }

  /** deliver 层在 finalize 前注入回合最终正文 */
  setFinalText(text: string): void {
    this.finalBody = typeof text === 'string' ? text : '';
  }

  /** 正文兜底：流未真正展示完整正文时，用非流式单条发送把完整正文补发出去 */
  async sendFinalBodyIfNeeded(reason: string): Promise<void> {
    const injected = this.finalBody || '';
    const held = this.lastAcceptedFull || '';
    const body = held.length > injected.length ? held : injected;
    if (!body) {
      this.deps.log?.warn(`[qqbot][guard] final body fallback skipped: no text held (reason=${reason})`);
      return;
    }
    // 2026-10-24 v6（STAGE F/F3）：结构判据优先（bodyShownInStream = 完整正文成功 update + complete 成功）；
    // 会话被平台定稿 / 推流被拒时退回「最后一次真正推入气泡的文本」(lastStreamedText)。
    // 两路都用 includes 收窄：气泡只持更短旧正文时不抑制 => 静态兜底照旧把正文送达（底线不变）。
    const bubbleText = this.bodyShownInStream ? this.streamedBodyText : this.lastStreamedText || '';
    const normalizedBubble = normalizeBodyForDedupe(bubbleText);
    if (normalizedBubble && normalizedBubble.includes(normalizeBodyForDedupe(body))) {
      this.deps.log?.info(`[qqbot][guard][F] static final body suppressed - stream bubble already holds the full body (chars=${body.length} reason=${reason} source=${this.bodyShownInStream ? 'finalize' : 'lastStreamed'})`);
      return;
    }
    if (this.bodyDelivered) return;
    if (normalizeBodyForDedupe(body) === normalizeBodyForDedupe(this.lastStreamedText)) return;
    const send = this.deps.sendFallback;
    if (!send) {
      this.deps.log?.warn(`[qqbot][guard] final body fallback unavailable (no sendFallback) chars=${body.length} reason=${reason}`);
      return;
    }
    this.deps.log?.info(`[qqbot][guard] final body fallback send (chars=${body.length} reason=${reason}) streamedChars=${this.lastStreamedText.length}`);
    try {
      const result = await send(body);
      if (result && result.error) {
        this.deps.log?.error(`[qqbot][guard] final body fallback send failed: ${result.error}`);
      } else {
        this.bodyDelivered = true;
      }
    } catch (err) {
      this.deps.log?.error(`[qqbot][guard] final body fallback send threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 状态机 ──

  private transition(next: StreamingPhase, reason: string): void {
    if (this.phase === next) return;
    this.deps.log?.info(`phase: ${this.phase} → ${next} (${reason})`);
    this.phase = next;
  }
}

/** 归一化空白符：连续换行/空格合并为单个空格 */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ');
}
// 2026-10-23 v3（H1）：判重前的空白归一 —— trim + 折叠连续空白/空行，避免「仅差空白」重复发送
/**
 * 归一化正文用于判重比较。
 *
 * 只做空白归一（去首尾空白、折叠连续空白），不做大小写或标点处理，
 * 避免把「视觉上相同但语义不同」的正文误判为重复。
 */
export function normalizeBodyForDedupe(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** 忽略空白前缀比较 */
function prefixMatches(accepted: string, incoming: string): boolean {
  if (incoming.startsWith(accepted)) return true;
  return normalizeWs(incoming).startsWith(normalizeWs(accepted));
}

function longestCommonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ── 入口判断 ──

import type { ResolvedQQBotAccount } from '../types.js';

export function shouldUseStreaming(
  account: ResolvedQQBotAccount,
  targetScope: 'c2c' | 'group' | 'channel',
): boolean {
  if (targetScope !== 'c2c') return false;
  const streaming = account.config?.streaming;
  if (typeof streaming === 'boolean') return streaming;
  if (streaming && typeof streaming === 'object') {
    return (streaming as any).mode !== 'off';
  }
  return false;
}
