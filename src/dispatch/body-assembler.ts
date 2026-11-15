/**
 * Body 组装器（消息入站 body 组装）
 *
 * SDK 中间件链已经完成了所有预处理：
 *   - ctx.message.content              ← contentSanitizer（face 解析 + mention 清洗）
 *   - ctx.state.quote                  ← quoteRef
 *   - ctx.state.history                ← historyBuffer
 *   - ctx.state.mention                ← mentionGate
 *   - ctx.state.processedAttachments   ← attachmentProcessor（语音 STT、图片 URL）
 *
 * 本模块仅负责"按框架协议把上述上下文拼成最终字符串"，是纯函数。
 *
 * 输出字段语义（与框架 buildCtxPayload 语义一致）：
 *   - webBody    → ctxPayload.Body         （Web UI 展示）
 *   - agentBody  → ctxPayload.BodyForAgent （AI 看到的）
 *   - rawBody    → ctxPayload.RawBody / CommandBody（命令解析、审计）
 *   - systemPrompt → ctxPayload.GroupSystemPrompt
 */
import type {
  MiddlewareContext,
  QQBotInboundMessage,
  ResolvedQuote,
  HistoryEntry,
} from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import type { ProcessedAttachments } from '../middleware/attachment.js';
import { getAdapters } from '../adapter/resolve.js';

// ── 协议常量 ─────────────────────────────
const QUOTE_BEGIN = '[Quoted message begins]';
const QUOTE_END = '[Quoted message ends]';
const REF_BEGIN = '[Reference message begins]';
const REF_END = '[Reference message ends]';
const HISTORY_BEGIN = '[Chat history begins]';
const HISTORY_END = '[Chat history ends]';
const MERGE_CTX_BEGIN = '[Merged messages begins]';
const MERGE_CTX_END = '[Merged messages ends]';
const CURRENT_MSG = '[Current message]';

export interface AssembledBody {
  /** Web UI 展示用 body */
  webBody: string;
  /** AI 实际接收的 body（dynamicCtx + userMessage [+ history 前缀]） */
  agentBody: string;
  /** 原始 content（命令解析 / 审计用） */
  rawBody: string;
  /** 群系统提示（account.systemPrompt + 群级提示拼接） */
  systemPrompt?: string;
}

/**
 * 把 SDK 中间件链产出的所有上下文组装为框架规约的 body。
 */
export function assembleBody(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  getRuntime?: () => any,
): AssembledBody {
  const rawBody = msg.content ?? '';
  const isGroup = msg.kind === 'group';

  const mentionState = ctx.state.mention as { wasMentioned?: boolean } | undefined;
  const wasMentioned = mentionState?.wasMentioned ?? false;
  const processed = ctx.state.processedAttachments as ProcessedAttachments | undefined;
  const quote = ctx.state.quote as ResolvedQuote | undefined;
  const history = ctx.state.history as HistoryEntry[] | undefined;
  const mergedMessages = ctx.state.mergedMessages as MiddlewareContext[] | undefined;

  // ── Layer 1: userContent（清洗后的文本 + 语音转录 + 附件描述） ──
  const userContent = buildUserContent(ctx.message.content ?? '', processed);

  // ── Layer 2: quotePart ──
  const quotePart = buildQuotePart(quote);

  // ── Layer 3: userMessage（群带 [sender] 前缀 + (@you)，合并消息特殊处理） ──
  const userMessage = mergedMessages && mergedMessages.length > 0
    ? buildMergedUserMessage({ messages: mergedMessages, quotePart, isGroup, wasMentioned, getRuntime })
    : buildUserMessage({ msg, userContent, quotePart, isGroup, wasMentioned });

  // ── Layer 4: dynamicCtx（媒体元数据块 + msg_elements 上下文） ──
  const dynamicCtx = buildDynamicCtx(processed, msg, quote);

  // ── Layer 5: agentBody（命令直通 / 群被@时前置历史） ──
  const agentBody = buildAgentBody({
    userContent,
    base: dynamicCtx + userMessage,
    isGroup,
    wasMentioned,
    history,
  });

  // ── webBody（合并消息包含全部前置 + 最后一条 + quotePart，对齐 agentBody） ──
  const bodyContent = mergedMessages && mergedMessages.length > 0
    ? userMessage
    : `${quotePart}${userContent}`;

  // ── webBody 外层 envelope 渲染（用 formatInboundEnvelope 包装） ──
  const webBody = getRuntime
    ? renderWebBody(getRuntime, bodyContent, msg, isGroup)
    : bodyContent;

  const systemPrompt = account.systemPrompt?.trim() || undefined;

  return { webBody, agentBody, rawBody, systemPrompt };
}

// ── 局部组装函数 ─────────────────────────────────────────────

/** Layer 1：sanitized + 语音转录 + 附件描述 */
function buildUserContent(sanitizedRaw: string, processed: ProcessedAttachments | undefined): string {
  const sanitized = sanitizedRaw.trim();
  const voiceText = processed?.voiceText ?? '';
  const attachmentInfo = processed?.otherInfo ? `\n${processed.otherInfo}` : '';

  if (voiceText) {
    return (sanitized ? `${sanitized}\n${voiceText}` : voiceText) + attachmentInfo;
  }
  return sanitized + attachmentInfo;
}

/** Layer 2：[Quoted message begins]…[Quoted message ends] */
function buildQuotePart(quote: ResolvedQuote | undefined): string {
  if (!quote) return '';
  const text = quote.text || 'Original content unavailable';
  return `${QUOTE_BEGIN}\n${text}\n${QUOTE_END}\n${CURRENT_MSG}\n`;
}

/** Layer 3：quote + [Sender] {content}{(@you)?} */
function buildUserMessage(input: {
  msg: QQBotInboundMessage;
  userContent: string;
  quotePart: string;
  isGroup: boolean;
  wasMentioned: boolean;
}): string {
  const { msg, userContent, quotePart, isGroup, wasMentioned } = input;
  const atYouTag = isGroup && wasMentioned ? ' (@you)' : '';

  if (isGroup) {
    const senderLabel = formatSenderLabel(msg.senderName, msg.senderId);
    return `${quotePart}[${senderLabel}] ${userContent}${atYouTag}`;
  }
  return `${quotePart}${userContent}`;
}

/** Layer 3（合并版）：concurrencyGuard merge 透传的多条消息 */
function buildMergedUserMessage(input: {
  messages: MiddlewareContext[];
  quotePart: string;
  isGroup: boolean;
  wasMentioned: boolean;
  getRuntime?: () => any;
}): string {
  const { messages, quotePart, isGroup, wasMentioned, getRuntime } = input;
  if (messages.length <= 1) {
    const single = messages[0]!;
    return buildUserMessage({
      msg: single.message,
      userContent: single.message.content ?? '',
      quotePart,
      isGroup,
      wasMentioned,
    });
  }

  const formatEnvelope = getRuntime
    ? getAdapters(getRuntime()).formatEnvelope
    : null;

  const lines = messages.map((ctx, i) => {
    const isLast = i === messages.length - 1;
    const line = formatMergedLine(ctx, { isGroup, isLast, wasMentioned, formatEnvelope });
    return line && isLast ? `${quotePart}${line}` : line;
  }).filter(Boolean);

  if (!isGroup || allSameSender(messages)) {
    return lines.join('\n');
  }

  const last = lines.pop()!;
  return [MERGE_CTX_BEGIN, ...lines, MERGE_CTX_END, CURRENT_MSG, last].join('\n');
}

function formatMergedLine(
  ctx: MiddlewareContext,
  opts: { isGroup: boolean; isLast: boolean; wasMentioned: boolean; formatEnvelope: ((p: Record<string, unknown>) => string) | null },
): string {
  const m = ctx.message;
  const content = (m.content ?? '').trim();

  if (opts.formatEnvelope && opts.isGroup) {
    const atYouTag = opts.isLast && opts.wasMentioned ? ' (@you)' : '';
    return opts.formatEnvelope({
      channel: 'qqbot',
      from: formatSenderLabel(m.senderName, m.senderId),
      timestamp: normalizeTimestamp(m.timestamp),
      body: content + atYouTag,
      chatType: 'group',
    });
  }
  return opts.isGroup
    ? `${formatSenderLabel(m.senderName, m.senderId)}: ${content}`
    : content;
}

function allSameSender(messages: MiddlewareContext[]): boolean {
  const first = messages[0]?.message.senderId;
  return messages.every((c) => c.message.senderId === first);
}

/** Layer 4：- Images / - Voice / - ASR 元数据块 + msg_elements 引用上下文 */
function buildDynamicCtx(
  processed: ProcessedAttachments | undefined,
  msg: QQBotInboundMessage,
  quote: ResolvedQuote | undefined,
): string {
  const lines: string[] = [];

  // Images
  if (processed?.imageUrls.length) {
    lines.push(`- Images: ${processed.imageUrls.join(', ')}`);
  }

  // Voice：从 transcripts 行存投影出 paths + urls，去重后拼接
  const transcripts = processed?.transcripts ?? [];
  const voiceRefs = unique([
    ...transcripts.map((t) => t.localPath).filter(isNonEmpty),
    ...transcripts.map((t) => t.remoteUrl).filter(isNonEmpty),
  ]);
  if (voiceRefs.length > 0) {
    lines.push(`- Voice: ${voiceRefs.join(', ')}`);
  }

  // ASR：source==='asr' 的 text，或任意 transcript 上的 asrReferText
  const asrTexts = unique(
    transcripts
      .map((t) => (t.source === 'asr' ? t.text : t.asrReferText))
      .filter(isNonEmpty),
  );
  if (asrTexts.length > 0) {
    lines.push(`- ASR: ${asrTexts.join(' | ')}`);
  }

  // msg_elements 上下文（仅当非引用消息时解析，避免与 quotePart 重复）
  if (!quote) {
    const elementsCtx = buildMsgElementsContext(msg);
    if (elementsCtx.length > 0) {
      lines.push(REF_BEGIN, ...elementsCtx, REF_END);
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

/** 从 msg_elements 提取上下文（非引用消息也解析，如被回复的 bot 消息等） */
function buildMsgElementsContext(msg: QQBotInboundMessage): string[] {
  const elements = msg.msgElements;
  if (!elements || elements.length === 0) return [];

  const lines: string[] = [];
  let index = 0;
  for (const el of elements) {
    const content = el.content?.trim();
    if (!content) continue;
    index += 1;

    const author = (el as Record<string, unknown>).author as
      | { username?: string }
      | undefined;
    const sender = author?.username ?? '未知';

    lines.push(
      `=== 消息 ${index} ===`,
      `[消息内容] ${content}`,
      `[发送者] ${sender}`,
    );
  }

  return lines;
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function isNonEmpty(x: string | undefined): x is string {
  return typeof x === 'string' && x.length > 0;
}

/** Layer 5：base = dynamicCtx+userMessage；命令直通；群被@叠历史前缀 */
function buildAgentBody(input: {
  userContent: string;
  base: string;
  isGroup: boolean;
  wasMentioned: boolean;
  history: HistoryEntry[] | undefined;
}): string {
  const { userContent, base, isGroup, wasMentioned, history } = input;

  // 斜杠命令直通：去除一切装饰及首尾空白
  if (userContent.trim().startsWith('/')) {
    return userContent;
  }

  // 群被@ + 有历史 → 叠历史前缀
  if (isGroup && wasMentioned && history && history.length > 0) {
    const historyText = history
      .map((h) => {
        const label = formatSenderLabel(h.senderName, h.senderId);
        return `[${label}] ${h.content}`;
      })
      .join('\n');
    return [HISTORY_BEGIN, historyText, '', HISTORY_END, CURRENT_MSG, base].join('\n');
  }

  return base;
}

/** "Nick (openid)" 标签；当 name 已含 id 时避免双重包裹 */
function formatSenderLabel(name: string | undefined, id: string): string {
  if (!name) return id;
  return name.includes(id) ? name : `${name} (${id})`;
}

/** webBody 外层 envelope 渲染 */
function renderWebBody(
  getRuntime: () => any,
  bodyContent: string,
  msg: QQBotInboundMessage,
  isGroup: boolean,
): string {
  try {
    const { formatEnvelope } = getAdapters(getRuntime());
    if (!formatEnvelope) return bodyContent;
    return formatEnvelope({
      channel: 'qqbot',
      from: msg.senderName ?? msg.senderId,
      timestamp: normalizeTimestamp(msg.timestamp),
      body: bodyContent,
      chatType: isGroup ? 'group' : 'direct',
    });
  } catch {
    return bodyContent;
  }
}

/** timestamp 归一化到 epoch ms */
function normalizeTimestamp(ts: string | number | undefined): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const d = new Date(ts).getTime();
    if (!Number.isNaN(d)) return d;
  }
  return Date.now();
}
