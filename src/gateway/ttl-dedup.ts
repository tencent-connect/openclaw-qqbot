/**
 * 按时间窗去重的中间件。
 *
 * 为什么不用 SDK 的 `messageFilter({ dedup })`：
 * 它的 `windowMs` 并不是 TTL 闸门——实现里只有 `seen.has(id)` 判断，
 * `windowMs` 仅在 Map 超过 `maxSize` 时参与淘汰。实测把窗口从 5s 改成 10min
 * 并不改变去重语义（61 秒后的同 id 重放在两种配置下都会被丢掉），
 * 真正的时间语义必须自己判断。
 *
 * 用途：QQ 在断线重连（RESUMED）或事件重放时会再次推送同一 messageId，
 * 间隔可能是几十秒到几分钟，需要在窗口内真正丢弃。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

export interface TtlDedupOptions {
  /** 同一 messageId 视为重复的时间窗，默认 10 分钟 */
  windowMs?: number;
  /** Map 容量上限，超出后按最旧优先淘汰，默认 5000 */
  maxSize?: number;
  /** 注入时钟，便于测试 */
  now?: () => number;
}

export function ttlDedup(options: TtlDedupOptions = {}) {
  const windowMs = options.windowMs ?? 10 * 60_000;
  const maxSize = options.maxSize ?? 5000;
  const nowFn = options.now ?? Date.now;
  const seen = new Map<string, number>();

  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const id = ctx.message?.messageId;
    if (id) {
      const now = nowFn();
      const prev = seen.get(id);
      if (prev !== undefined && now - prev < windowMs) {
        ctx.log?.debug?.(`[ttl-dedup] dropping duplicate messageId=${id} age=${now - prev}ms`);
        ctx.stop('deduplication');
        return;
      }
      // Map 对已存在的 key 再 set 不会改变迭代顺序；续期的旧条目若留在原位，
      // 淘汰循环会先撞上它（时间戳新、size 未超）而 break，真正的过期条目反而留着。
      // 先删再插，让它回到队尾，淘汰顺序才与时间戳一致。
      if (prev !== undefined) seen.delete(id);
      seen.set(id, now);
      if (seen.size > maxSize) {
        for (const [key, ts] of seen) {
          if (seen.size > maxSize || now - ts >= windowMs) {
            seen.delete(key);
          } else {
            break;
          }
        }
      }
    }
    await next();
  };
}
