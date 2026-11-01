/**
 * 出站发送账本：同一条入站消息的同一段文本只允许真正发出去一次。
 *
 * 为什么需要这个（而不是只靠 DispatchDeliverState.deliveredTexts）：
 *   `deliveredTexts` 是「按派发批次」去重的，同一条入站消息可能被派发多次——
 *   核心遇到 DispatchSessionRefreshRequiredError 会整体重试一次，插件的
 *   withDispatchRetry 也会重试，steer / queue policy 还可能让同一条消息先被
 *   活跃 run 采纳、再被新 run 处理。每次派发都会新建一份 deliveredTexts，
 *   跨派发放就拦不住，表现就是同一段回复在 QQ 里出现两遍。
 *
 * 语义（两阶段，抢占 → 确认/释放）：
 *   key = accountId : 入站 messageId : sha1(文本)
 *   - reserve：先占位（在途窗口 OUTBOUND_LEDGER_INFLIGHT_TTL_MS），并发派发互相拦截；
 *   - confirm：真正发出去之后才把占位延长到 OUTBOUND_LEDGER_TTL_MS；
 *   - release：发送失败立刻撤销占位，让重试还能再发一次。
 *   同一入站消息重发同一段文本 → 丢弃并打印日志；
 *   用户再问一次是新的 messageId → 照常发送，不会被误伤。
 */
import { createHash } from 'node:crypto';

/** 账本保留窗口。一分钟内重试、几分钟后的事件重放都要能拦住。 */
export const OUTBOUND_LEDGER_TTL_MS = 30 * 60 * 1000;
/**
 * 在途占位窗口。只管「已经 reserve、还没确认/释放」的这段时间：
 * 足够覆盖一次发送 + 紧随其后的并发重试，又不至于在异常路径上把回复锁死 30 分钟。
 */
export const OUTBOUND_LEDGER_INFLIGHT_TTL_MS = 2 * 60 * 1000;
/** 上限保护：超限时只淘汰最旧的 confirmed 条目，绝不淘汰在途占位。 */
export const OUTBOUND_LEDGER_MAX_ENTRIES = 4000;

interface LedgerEntry {
  expiresAt: number;
  /** inflight = 已占位、还没确认发送结果；confirmed = 已真正发出 */
  state: 'inflight' | 'confirmed';
}

const entries = new Map<string, LedgerEntry>();

function evictIfNeeded(now: number): void {
  // 1) 先清掉已经过期的条目
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
  if (entries.size <= OUTBOUND_LEDGER_MAX_ENTRIES) return;

  // 2) 只淘汰 confirmed 条目，按到期时间从旧到新。
  //    绝不能淘汰 inflight：它代表一次正在进行的发送，删掉后同一段文本
  //    会被并发派发再次 reserve，导致重复发送。
  const confirmed = [...entries.entries()]
    .filter(([, entry]) => entry.state === 'confirmed')
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  let overflow = entries.size - OUTBOUND_LEDGER_MAX_ENTRIES;
  for (const [key] of confirmed) {
    if (overflow <= 0) break;
    entries.delete(key);
    overflow -= 1;
  }
  // 3) 如果仍然超限，说明 inflight 本身就超过上限（并发极高）。
  //    保留它们，宁可暂时超出容量，也不冒重复发送的风险。
}

export function buildOutboundLedgerKey(
  accountId: string,
  inboundMessageId: string | undefined,
  text: string,
): string {
  const digest = createHash('sha1').update(text).digest('hex');
  return `${accountId}:${inboundMessageId ?? '-'}:${digest}`;
}

function isLive(entry: LedgerEntry | undefined, now: number): boolean {
  return entry !== undefined && entry.expiresAt > now;
}

/**
 * 申请发送权（第一阶段：占位）。
 * @returns true 表示这段文本暂时归你发；false 表示已有人在发或已经发过，应当丢弃。
 */
export function reserveOutboundSend(
  accountId: string,
  inboundMessageId: string | undefined,
  text: string,
  now: number = Date.now(),
): boolean {
  if (!text) return true;
  evictIfNeeded(now);
  const key = buildOutboundLedgerKey(accountId, inboundMessageId, text);
  if (isLive(entries.get(key), now)) return false;
  entries.set(key, { expiresAt: now + OUTBOUND_LEDGER_INFLIGHT_TTL_MS, state: 'inflight' });
  return true;
}

/**
 * 确认发送成功（第二阶段）：把在途占位延长为正式保留窗口。
 */
export function confirmOutboundSend(
  accountId: string,
  inboundMessageId: string | undefined,
  text: string,
  now: number = Date.now(),
): void {
  if (!text) return;
  entries.set(buildOutboundLedgerKey(accountId, inboundMessageId, text), {
    expiresAt: now + OUTBOUND_LEDGER_TTL_MS,
    state: 'confirmed',
  });
}

/**
 * 撤销占位（发送失败时调用）：让重试还能再发一次。
 */
export function releaseOutboundSend(
  accountId: string,
  inboundMessageId: string | undefined,
  text: string,
): void {
  if (!text) return;
  entries.delete(buildOutboundLedgerKey(accountId, inboundMessageId, text));
}

/** 测试用：清空账本。 */
export function resetOutboundLedger(): void {
  entries.clear();
}

/** 测试用：当前账本条目数。 */
export function outboundLedgerSize(): number {
  return entries.size;
}
