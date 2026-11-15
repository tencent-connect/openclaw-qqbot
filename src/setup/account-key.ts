/**
 * 账户键解析 — setup / login 共用
 *
 * 统一确定扫码/绑定凭据应写入哪个账户键。
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { listQQBotAccountIds, resolveQQBotAccount } from '../config.js';

/**
 * 解析凭据写入的目标账户键。
 *
 * @param cfg    当前配置
 * @param appId  扫码或输入的 AppID
 * @param resolvedId  用户显式指定的账户名（如 --account / setup wizard），可选
 * @returns 账户键
 *
 * 优先级：
 *   1. resolvedId 指定 → 直接使用
 *   2. 已有同 appId 的账户 → 刷新凭据（复用该账户键）
 *   3. 零账户 → 'default'（首次配置）
 *   4. 已有其他账户 → appId（新增独立账户）
 */
export function resolveAccountKey(
  cfg: OpenClawConfig,
  appId: string,
  resolvedId?: string | null,
): string {
  if (resolvedId) return resolvedId;

  // 同 appId → 刷新
  for (const id of listQQBotAccountIds(cfg)) {
    if (resolveQQBotAccount(cfg, id).appId === appId) return id;
  }

  // 零账户 → default
  if (listQQBotAccountIds(cfg).length === 0) return 'default';

  // 新增账户
  return appId;
}
