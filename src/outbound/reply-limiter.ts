/**
 * 被动回复限额管理
 *
 * QQ Bot 被动回复有限额（同一条消息最多回复 N 次，超时后不能再被动回复）。
 * 当限额耗尽或消息过期时，标记应降级为主动消息（proactive）。
 */

export interface ReplyLimiterConfig {
  /** 每条消息最大被动回复次数（默认 4） */
  limit?: number;
  /** 消息 ID 过期时间 ms（默认 1 小时） */
  ttlMs?: number;
  /** 最大跟踪消息数（LRU 驱逐，默认 10000） */
  maxTrackedMessages?: number;
}

export interface ReplyLimitResult {
  allowed: boolean;
  remaining: number;
  shouldFallbackToProactive: boolean;
  fallbackReason?: 'expired' | 'limit_exceeded';
}

interface TrackedMessage {
  count: number;
  firstSeenAt: number;
}

/**
 * 被动回复限额管理器
 *
 * @example
 * ```ts
 * const limiter = new ReplyLimiter({ limit: 4, ttlMs: 3600_000 });
 * const result = limiter.checkLimit(messageId);
 * if (!result.allowed) {
 *   // 降级为主动消息
 * } else {
 *   limiter.record(messageId);
 *   // 正常被动回复
 * }
 * ```
 */
export class ReplyLimiter {
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly maxTracked: number;
  private readonly messages = new Map<string, TrackedMessage>();

  constructor(config?: ReplyLimiterConfig) {
    this.limit = config?.limit ?? 4;
    this.ttlMs = config?.ttlMs ?? 3600_000; // 1 小时
    this.maxTracked = config?.maxTrackedMessages ?? 10_000;
  }

  /**
   * 检查是否允许对指定消息继续被动回复
   */
  checkLimit(messageId: string): ReplyLimitResult {
    const now = Date.now();
    const tracked = this.messages.get(messageId);

    if (!tracked) {
      return { allowed: true, remaining: this.limit, shouldFallbackToProactive: false };
    }

    // TTL 过期
    if (now - tracked.firstSeenAt > this.ttlMs) {
      this.messages.delete(messageId);
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: 'expired',
      };
    }

    // 限额检查
    const remaining = Math.max(0, this.limit - tracked.count);
    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: 'limit_exceeded',
      };
    }

    return { allowed: true, remaining, shouldFallbackToProactive: false };
  }

  /**
   * 记录一次被动回复
   */
  record(messageId: string): void {
    const now = Date.now();
    const tracked = this.messages.get(messageId);

    if (tracked) {
      tracked.count++;
    } else {
      // LRU 驱逐
      if (this.messages.size >= this.maxTracked) {
        const firstKey = this.messages.keys().next().value;
        if (firstKey) this.messages.delete(firstKey);
      }
      this.messages.set(messageId, { count: 1, firstSeenAt: now });
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): { trackedMessages: number; totalReplies: number } {
    let totalReplies = 0;
    for (const [, v] of this.messages) {
      totalReplies += v.count;
    }
    return { trackedMessages: this.messages.size, totalReplies };
  }

  /**
   * 清除所有跟踪数据
   */
  clear(): void {
    this.messages.clear();
  }
}
