/**
 * 出站目标地址解析
 *
 * 将 OpenClaw 规范的目标地址字符串（如 qqbot:c2c:xxx / qqbot:group:xxx）
 * 转换为 SDK 的 ReplyTarget 结构。
 *
 * 也导出共享的正则常量供 channel.ts messaging 段复用。
 */
import type { ReplyTarget } from '@tencent-connect/qqbot-nodejs';

// ── 共享正则常量 ──

/** 32 位十六进制 OpenID（不带连字符） */
export const OPENID_HEX_RE = /^[0-9a-fA-F]{32}$/;

/** UUID 格式的 OpenID（带连字符） */
export const OPENID_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 带 qqbot: 前缀的目标格式 */
export const QQBOT_PREFIX_RE = /^qqbot:(c2c|group|channel):/i;

/** 不带前缀但有 scope 标识 */
export const SCOPE_PREFIX_RE = /^(c2c|group|channel):/i;

/**
 * 判断 ID 是否看起来像 QQ Bot 目标格式
 */
export function isQQBotTarget(id: string): boolean {
  if (QQBOT_PREFIX_RE.test(id)) return true;
  if (SCOPE_PREFIX_RE.test(id)) return true;
  if (OPENID_HEX_RE.test(id)) return true;
  return OPENID_UUID_RE.test(id);
}

/**
 * 规范化目标地址字符串
 */
export function normalizeTarget(target: string): string | undefined {
  const id = target.replace(/^qqbot:/i, '');
  if (id.startsWith('c2c:') || id.startsWith('group:') || id.startsWith('channel:')) {
    return `qqbot:${id}`;
  }
  if (OPENID_HEX_RE.test(id)) return `qqbot:c2c:${id}`;
  if (OPENID_UUID_RE.test(id)) return `qqbot:c2c:${id}`;
  return undefined;
}

/**
 * 解析目标地址字符串为 SDK ReplyTarget
 */
export function parseTarget(to: string): ReplyTarget {
  const id = to.replace(/^qqbot:/i, '');

  if (id.startsWith('c2c:')) {
    return { scope: 'c2c', targetId: id.slice(4) };
  }
  if (id.startsWith('group:')) {
    return { scope: 'group', targetId: id.slice(6) };
  }

  // 默认当作 c2c（32 位十六进制 / UUID 格式的 openid）
  return { scope: 'c2c', targetId: id };
}
