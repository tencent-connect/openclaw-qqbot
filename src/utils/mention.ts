/**
 * Mention 工具函数
 *
 * @mention 检测与清理，供 channel.ts 和 gateway 层使用。
 */

export interface MentionEntry {
  member_openid?: string;
  id?: string;
  user_openid?: string;
  is_you?: boolean;
  nickname?: string;
  username?: string;
}

/** 清理 @mention：替换 <@openid> 为 @用户名，去除 @机器人自身 */
export function stripMentionText(text: string, mentions?: MentionEntry[]): string {
  if (!text || !mentions?.length) return text;
  let cleaned = text;
  for (const m of mentions) {
    const openid = m.member_openid ?? m.id ?? m.user_openid;
    if (!openid) continue;
    if (m.is_you) {
      cleaned = cleaned.replace(new RegExp(`<@!?${openid}>`, 'g'), '').trim();
    } else {
      const displayName = m.nickname ?? m.username;
      if (displayName) {
        cleaned = cleaned.replace(new RegExp(`<@!?${openid}>`, 'g'), `@${displayName}`);
      }
    }
  }
  return cleaned;
}

/** 检测消息是否 @了机器人 */
export function detectWasMentioned({ eventType, mentions, content, mentionPatterns }: {
  eventType?: string;
  mentions?: Array<{ is_you?: boolean }>;
  content?: string;
  mentionPatterns?: string[];
}): boolean {
  if (mentions?.some((m) => m.is_you)) return true;
  if (eventType === 'GROUP_AT_MESSAGE_CREATE') return true;
  if (mentionPatterns?.length && content) {
    for (const pattern of mentionPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(content)) return true;
      } catch { /* 无效正则，跳过 */ }
    }
  }
  return false;
}
