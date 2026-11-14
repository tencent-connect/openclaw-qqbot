/**
 * 出站消息合并防抖
 *
 * 当短时间内收到多次 deliver 时，将文本合并为一条消息发送，避免消息轰炸。
 *
 * 注：框架 ReplyDispatcher 通过 sendChain 保证 deliver 严格串行——
 * enqueue 返回的 Promise 在文本实际发出前不会 resolve，因此上游
 * 不会并发调用 deliver，无需 flushBeforeMedia。
 */
import type { DeliverDebounceConfig } from '../types.js';

const DEFAULT_WINDOW_MS = 1500;
const DEFAULT_MAX_WAIT_MS = 8000;
const DEFAULT_SEPARATOR = '\n\n---\n\n';

interface PendingDeliver {
  texts: string[];
  firstAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 每条入队文本对应一个等待者，flush 成功/失败时一起结算 */
  waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }>;
}

export class DeliverDebouncer {
  private pending = new Map<string, PendingDeliver>();
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly separator: string;
  private readonly flush: (targetId: string, mergedText: string) => Promise<void>;

  constructor(
    config: DeliverDebounceConfig | undefined,
    flush: (targetId: string, mergedText: string) => Promise<void>,
  ) {
    this.windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxWaitMs = config?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.separator = config?.separator ?? DEFAULT_SEPARATOR;
    this.flush = flush;
  }

  get enabled(): boolean {
    return this.windowMs > 0;
  }

  /**
   * 入队一条纯文本待发送消息
   * @returns Promise，在文本实际发送时 resolve
   */
  async enqueue(targetId: string, text: string): Promise<void> {
    if (!this.enabled) {
      await this.flush(targetId, text);
      return;
    }

    const existing = this.pending.get(targetId);
    if (existing) {
      // 同一批里每段文本都要等真正的发送结果，不能入队即算成功。
      const waiter = new Promise<void>((resolve, reject) => {
        existing.waiters.push({ resolve, reject });
      });
      existing.texts.push(text);
      if (existing.timer) clearTimeout(existing.timer);
      if (Date.now() - existing.firstAt >= this.maxWaitMs) {
        await this.doFlush(targetId).catch(() => {});
      } else {
        existing.timer = setTimeout(() => {
          void this.doFlush(targetId).catch(() => {});
        }, this.windowMs);
      }
      return waiter;
    }

    // 新建 pending
    return new Promise<void>((resolve, reject) => {
      const pending: PendingDeliver = {
        texts: [text],
        firstAt: Date.now(),
        timer: setTimeout(() => {
          void this.doFlush(targetId).catch(() => {});
        }, this.windowMs),
        waiters: [{ resolve, reject }],
      };
      this.pending.set(targetId, pending);
    });
  }

  private async doFlush(targetId: string): Promise<void> {
    const pending = this.pending.get(targetId);
    if (!pending) return;
    this.pending.delete(targetId);

    if (pending.timer) clearTimeout(pending.timer);
    const merged = pending.texts.join(this.separator);

    try {
      await this.flush(targetId, merged);
      for (const waiter of pending.waiters) waiter.resolve();
    } catch (err) {
      // 发送失败要传给调用方，让 outbound ledger 释放占位并可重试。
      for (const waiter of pending.waiters) waiter.reject(err);
      throw err;
    }
  }

  /**
   * 强制刷新所有 pending
   */
  async flushAll(): Promise<void> {
    const keys = [...this.pending.keys()];
    // 错误已经通过各自的 enqueue Promise 抛给调用方；这里只负责把队列排空。
    await Promise.all(keys.map((k) => this.doFlush(k).catch(() => {})));
  }
}
