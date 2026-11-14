/**
 * 被动回复限额管理
 *
 * QQ Bot 被动回复有限额（同一条消息最多回复 N 次，超时后不能再被动回复）。
 * 当限额耗尽或消息过期时，标记应降级为主动消息（proactive）。
 */

export interface ReplyLimiterConfig {
  /** 每条消息最大被动回复次数（默认 4） */
  limit?: number;
  /** 消息 ID 过期时间 ms（默认 5 分钟，与 QQ 被动回复有效期一致） */
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
  /**
   * 被平台明确拒绝过（msg_id 无效/越权/过期）的消息 id。
   * 这些 id 不再用于被动回复，后续发送直接降级为主动消息。
   */
  private readonly expired = new Set<string>();

  constructor(config?: ReplyLimiterConfig) {
    this.limit = config?.limit ?? 4;
    this.ttlMs = config?.ttlMs ?? 5 * 60_000; // QQ 被动回复有效期 5 分钟
    this.maxTracked = config?.maxTrackedMessages ?? 10_000;
  }

  /**
   * 检查是否允许对指定消息继续被动回复
   */
  checkLimit(messageId: string): ReplyLimitResult {
    const now = Date.now();

    if (this.expired.has(messageId)) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: 'expired',
      };
    }

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
    this.expired.delete(messageId);
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
    this.expired.clear();
  }

  /**
   * 标记某个 msg_id 已失效（平台返回无效/越权/过期）。
   * 后续对该消息的回复会直接走主动消息，不再浪费一次失败请求。
   */
  expire(messageId: string): void {
    if (!messageId) return;
    if (this.expired.size >= this.maxTracked) {
      const first = this.expired.values().next().value;
      if (first) this.expired.delete(first);
    }
    this.expired.add(messageId);
    this.messages.delete(messageId);
  }
}
