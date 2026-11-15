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
  resolve: () => void;
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
      existing.texts.push(text);
      // 重置窗口定时器
      if (existing.timer) clearTimeout(existing.timer);
      // 检查是否超过最大等待
      if (Date.now() - existing.firstAt >= this.maxWaitMs) {
        await this.doFlush(targetId);
      } else {
        existing.timer = setTimeout(() => this.doFlush(targetId), this.windowMs);
      }
      return;
    }

    // 新建 pending
    return new Promise<void>((resolve) => {
      const pending: PendingDeliver = {
        texts: [text],
        firstAt: Date.now(),
        timer: setTimeout(() => this.doFlush(targetId), this.windowMs),
        resolve,
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
    } finally {
      pending.resolve();
    }
  }

  /**
   * 强制刷新所有 pending
   */
  async flushAll(): Promise<void> {
    const keys = [...this.pending.keys()];
    await Promise.all(keys.map((k) => this.doFlush(k)));
  }
}
