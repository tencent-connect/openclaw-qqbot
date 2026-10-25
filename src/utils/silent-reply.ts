/**
 * 静默回复识别。
 *
 * 核心 openclaw 有等价的判定（openclaw 的 tokens 模块：isSilentReplyText /
 * isSilentReplyPrefixText），但没有从 openclaw / openclaw/plugin-sdk 导出，
 * 通道侧无法直接引用，只能在这里按同样语义实现一份。
 *
 * 语义（对齐核心当前实现）：
 * - 精确匹配：^\s*<token>(?:\s+<token>)*\s*（大小写不敏感）
 * - 前缀匹配：全大写、长度 >= 2、只含 A-Z_，且是某个 token 的前缀
 *
 * token 取自核心的 SILENT_REPLY_TOKEN / HEARTBEAT_TOKEN。
 */
const QQ_SILENT_REPLY_TOKENS = ['NO_REPLY', 'HEARTBEAT_OK'] as const;

/** 精确匹配：^\s*<token>(?:\s+<token>)*\s*（大小写不敏感） */
const QQ_SILENT_REPLY_EXACT_RE = new RegExp(
  `^\\s*(?:${QQ_SILENT_REPLY_TOKENS.join('|')})(?:\\s+(?:${QQ_SILENT_REPLY_TOKENS.join('|')}))*\\s*$`,
  'i',
);

/**
 * 判断一段文本是不是「静默回复」——即不应该真的发到聊天里的内容。
 */
export function isQQBotSilentReply(text: string | undefined | null): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (QQ_SILENT_REPLY_EXACT_RE.test(trimmed)) return true;
  if (trimmed !== trimmed.toUpperCase()) return false;
  if (trimmed.length < 2) return false;
  if (/[^A-Z_]/.test(trimmed)) return false;
  return QQ_SILENT_REPLY_TOKENS.some((token) => token.startsWith(trimmed));
}

/**
 * 核心（openclaw）在「回复生成成功但投递失败」时补发的完整提示语。
 * 逐字对齐核心的 STRANDED_REPLY_DELIVERY_FAILURE_TEXT。
 */
export const QQBOT_DELIVERY_FAILURE_NOTICE =
  'I generated a reply but could not deliver it to this chat. Please try again.';

/**
 * 判断一段文本是不是这条「投递失败提示」本身。
 *
 * 必须整条是完整提示语才算数：只做子串匹配会把「回复里提到这句文案」的正常回复
 * 整条丢弃并当作静默，那属于误伤。
 *
 * 允许前缀差异（不同 core 版本的措辞前缀可能不同），但结尾必须是完整的
 * 「could not deliver it to this chat. Please try again.」这句。
 */
export function isQQBotDeliveryFailureNotice(text: string | undefined | null): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed === QQBOT_DELIVERY_FAILURE_NOTICE) return true;
  return /could not deliver it to this chat\.\s*Please try again\.$/i.test(trimmed);
}

/**
 * 是否应该跳过这次发送（静默 token 或整条「投递失败提示」）。
 *
 * 只有精确的静默标记 / 完整的提示语才算数：
 * 只是「提到」该文案的正常回复必须照常发出。
 */
export function shouldSuppressQQBotSend(text: string | undefined | null): boolean {
  return isQQBotSilentReply(text) || isQQBotDeliveryFailureNotice(text);
}
