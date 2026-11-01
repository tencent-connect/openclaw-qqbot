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
 * 语义（两阶段 + ownership）：
 *   key = accountId : 入站 messageId : sha1(文本)
 *   - reserve：占位并返回 token；在途条目不设过期时间，直到 confirm/release；
 *   - confirm：只有持有同一个 token 的调用者才能把占位延长到 30 分钟；
 *   - release：发送失败时用同一个 token 撤销占位，让重试还能再发一次。
 *   同一入站消息重发同一段文本 → 丢弃并打印日志；
 *   用户再问一次是新的 messageId → 照常发送，不会被误伤。
 */
import { createHash, randomUUID } from 'node:crypto';

/** 账本保留窗口。一分钟内重试、几分钟后的事件重放都要能拦住。 */
export const OUTBOUND_LEDGER_TTL_MS = 30 * 60 * 1000;
/** 上限保护：超限时只淘汰最旧的 confirmed 条目，绝不淘汰在途占位。 */
export const OUTBOUND_LEDGER_MAX_ENTRIES = 4000;

interface LedgerEntry {
  /** inflight 为 Infinity：占位必须活到调用方 confirm/release */
  expiresAt: number;
  state: 'inflight' | 'confirmed';
  /** 所有权 token：防止上一次派发误确认/误释放下一次派发的占位 */
  token: string;
}

const entries = new Map<string, LedgerEntry>();

function evictIfNeeded(now: number): void {
  // 1) 先清掉已经过期的 confirmed 条目
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

export type OutboundKind = 'text' | 'voice';

export function buildOutboundLedgerKey(
  accountId: string,
  inboundMessageId: string | undefined,
  text: string,
  kind: OutboundKind = 'text',
): string {
  const digest = createHash('sha1').update(text).digest('hex');
  // 语音与文本分开记账：文本块已经发过同样的文字，不代表语音气泡也发过
  // （TTS 仍然需要这段文字），反之亦然。
  return `${accountId}:${inboundMessageId ?? '-'}:${kind}:${digest}`;
}

function isLive(entry: LedgerEntry | undefined, now: number): boolean {
  return entry !== undefined && entry.expiresAt > now;
}

/**
 * 申请发送权（第一阶段：占位）。
 * @returns token 表示这段文本暂时归你发；null 表示已有人在发或已经发过，应当丢弃。
 */
export function reserveOutboundSend(
  accountId: string,
  inboundMessageId: string | undefined,
  text: string,
  now: number = Date.now(),
  kind: OutboundKind = 'text',
): string | null {
  if (!text) return null;
  evictIfNeeded(now);
  const key = buildOutboundLedgerKey(accountId, inboundMessageId, text, kind);
  if (isLive(entries.get(key), now)) return null;
  const token = randomUUID();
  // 在途占位不设过期：媒体发送可能超过 2 分钟，必须活到 confirm/release。
  entries.set(key, { expiresAt: Number.POSITIVE_INFINITY, state: 'inflight', token });
  return token;
}

/**
 * 确认发送成功（第二阶段）：把在途占位延长为正式保留窗口。
 * token 不匹配说明占位已经被 release 并由后来者重新持有，本次调用直接忽略。
 */
export function confirmOutboundSend(
  accountId: string,
  inboundMessageId: string | undefined,
  text: string,
  token: string,
  now: number = Date.now(),
  kind: OutboundKind = 'text',
): void {
  if (!text || !token) return;
  const key = buildOutboundLedgerKey(accountId, inboundMessageId, text, kind);
  const entry = entries.get(key);
  if (!entry || entry.token !== token) return;
  entries.set(key, { expiresAt: now + OUTBOUND_LEDGER_TTL_MS, state: 'confirmed', token });
}

/**
 * 撤销占位（发送失败时调用）：让重试还能再发一次。
 * token 不匹配时不能删除后来者的占位。
 */
export function releaseOutboundSend(
  accountId: string,
  inboundMessageId: string | undefined,
  text: string,
  token: string,
  kind: OutboundKind = 'text',
): void {
  if (!text || !token) return;
  const key = buildOutboundLedgerKey(accountId, inboundMessageId, text, kind);
  const entry = entries.get(key);
  if (!entry || entry.token !== token) return;
  entries.delete(key);
}

/**
 * 跨派发查询：这段文本（默认文本通道）是否已经确认发出去了。
 * 用于语音 TTS 失败时判断是否还要回退发文本——另一个派发可能已经发过。
 */
export function hasConfirmedOutboundSend(
  accountId: string,
  inboundMessageId: string | undefined,
  text: string,
  now: number = Date.now(),
  kind: OutboundKind = 'text',
): boolean {
  if (!text) return false;
  const entry = entries.get(buildOutboundLedgerKey(accountId, inboundMessageId, text, kind));
  return entry?.state === 'confirmed' && entry.expiresAt > now;
}

/** 测试用：清空账本。 */
export function resetOutboundLedger(): void {
  entries.clear();
}

/** 测试用：当前账本条目数。 */
export function outboundLedgerSize(): number {
  return entries.size;
}
