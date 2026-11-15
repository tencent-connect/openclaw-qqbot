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
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { QQBotGateway } from '../gateway/qqbot-gateway.js';

// ── 类型 ──

export type StreamingPhase = 'idle' | 'streaming' | 'done' | 'failed';

export interface StreamingControllerDeps {
  gateway: QQBotGateway;
  target: ReplyTarget;
  accountId: string;
  replyToId: string;
  log?: PluginLogger;
}

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
        this.deps.log?.error(`abort complete failed: ${e instanceof Error ? e.message : String(e)}`);
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
      await this.completeSession();
      this.transition('done', 'finalize');
      this.deps.log?.info(`stream done chunks=${this.sentChunkCount} chars=${this.lastAcceptedFull.length}`);
      return;
    }

    // 无会话 — 视有无下发决定终态
    if (this.sentChunkCount > 0) {
      this.transition('done', 'finalize:no_session');
    } else {
      this.transition('failed', 'finalize:fallback');
    }
  }

  // ── QQ 交互 ──

  private async sendUpdate(text: string): Promise<void> {
    if (!this.session) {
      this.session = this.deps.gateway.openStream(this.deps.target, this.deps.replyToId);
      this.transition('streaming', 'first_chunk');
      this.deps.log?.info(`stream opened (firstChunk=${text.length})`);
    }
    try {
      await this.session.update(text);
      this.lastAcceptedFull = text;
      this.sentChunkCount++;
    } catch (err) {
      this.deps.log?.error(`update failed (len=${text.length}): ${err instanceof Error ? err.message : String(err)}`);
      this.session = null;
      this.transition('failed', 'update_error');
    }
  }

  private async completeSession(reason?: string): Promise<void> {
    if (!this.session) return;
    this.deps.log?.info(`completing stream (sent=${this.sentChunkCount} chars=${this.lastAcceptedFull.length} reason=${reason ?? 'done'})`);
    try {
      await this.session.complete();
    } catch (err) {
      this.deps.log?.error(`complete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.session = null;
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
