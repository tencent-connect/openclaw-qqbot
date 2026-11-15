/**
 * 消息 ID 缓存 — 记录最近处理的 msgId，供被动回复使用。
 *
 * 场景：外部调用发送消息时没有上下文，
 * 从缓存获取最近一条未过期的 msgId 作为被动回复目标。
 */

interface CachedMsgId {
  msgId: string;
  timestamp: number;
}

const MAX_PER_TARGET = 10;
const TTL_GROUP = 5 * 60 * 1000;   // 5 分钟
const TTL_C2C = 30 * 60 * 1000;   // 30 分钟
const MAX_TARGETS = 200;

const cache = new Map<string, CachedMsgId[]>();

export function cacheMsgId(scope: string, targetId: string, msgId: string): void {
  if (!scope || !targetId || !msgId) return;
  const key = `${scope}:${targetId}`;
  const existing = cache.get(key);
  if (existing) {
    // LRU: 删除再重新插入
    cache.delete(key);
    existing.push({ msgId, timestamp: Date.now() });
    if (existing.length > MAX_PER_TARGET) existing.shift();
    cache.set(key, existing);
  } else {
    cache.set(key, [{ msgId, timestamp: Date.now() }]);
    if (cache.size > MAX_TARGETS) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }
}

export function getCachedMsgId(scope: string, targetId: string): string | undefined {
  const key = `${scope}:${targetId}`;
  const list = cache.get(key);
  if (!list || list.length === 0) return undefined;
  const now = Date.now();
  const ttl = scope === 'group' ? TTL_GROUP : TTL_C2C;
  for (let i = list.length - 1; i >= 0; i--) {
    if (now - list[i].timestamp < ttl) {
      return list[i].msgId;
    }
  }
  return undefined;
}

export function clearMsgIdCache(scope: string, targetId: string): void {
  cache.delete(`${scope}:${targetId}`);
}
