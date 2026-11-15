import type { ResolvedQQBotAccount } from '../types.js';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import { getAdapters } from '../adapter/resolve.js';

/**
 * 命令授权检查（用于 SlashCommand.authorized 回调）。
 *
 * 规则：
 * - mode=open → 允许
 * - allowFrom 为空或含 "*" → 允许
 * - senderId 在 allowFrom 中 → 允许
 * - 否则 → 返回错误消息
 */
export function checkCommandAuth(ctx: SlashCommandHandlerContext): boolean | string {
  const p = (ctx.state as any).policy;
  const mode = p?.c2cMode ?? 'allowlist';
  const allowFrom: string[] = p?.allowFrom ?? [];
  if (mode === 'open' || !allowFrom.length || allowFrom.includes('*')) return true;
  return allowFrom.includes(ctx.message.senderId) || '⚠️ 无权限执行此命令';
}

interface PersistResult {
  persist: (updater: (cfg: any) => void) => Promise<void>;
}

/**
 * 底层：获取 persistConfig，统一处理 runtime/adapters 判空。
 * @returns [error, result] — error 非空时不可用；result.persist 直接调 persistConfig。
 */
async function resolvePersistFn(getRuntime: () => PluginRuntime): Promise<[string | null, PersistResult | null]> {
  const runtime = getRuntime();
  if (!runtime) return ['⚠️ runtime 不可用，无法修改配置。', null];

  const adapters = getAdapters(runtime);
  if (!adapters.persistConfig) {
    return ['⚠️ 当前框架版本不支持在线修改配置，请手动编辑配置文件。', null];
  }

  return [
    null,
    { persist: (updater: (cfg: any) => void) => adapters.persistConfig!(updater) },
  ];
}

/**
 * 持久化更新**账户**配置。自动处理命名账户 / 默认账户路径差异。
 */
export async function updateAccountConfig(
  account: ResolvedQQBotAccount,
  getRuntime: () => PluginRuntime,
  updater: (accountConfig: Record<string, unknown>) => void,
): Promise<string | null> {
  const [err, result] = await resolvePersistFn(getRuntime);
  if (err || !result) return err;

  try {
    await result.persist((cfg: any) => {
      cfg.channels ??= {};
      cfg.channels.qqbot ??= {};

      const qqbot = cfg.channels.qqbot;
      const accountId = account.accountId;
      const isNamedAccount = accountId !== 'default' && qqbot.accounts?.[accountId];

      if (isNamedAccount) {
        qqbot.accounts[accountId] ??= {};
        updater(qqbot.accounts[accountId]);
      } else {
        updater(qqbot);
      }
    });
    return null;
  } catch (e) {
    return `⚠️ 配置修改失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 持久化更新**框架通用**配置（不从 channels.qqbot.accounts 走）。
 * 适用于 tools.exec 等非账户级字段。
 */
export async function updateGlobalConfig(
  getRuntime: () => PluginRuntime,
  updater: (cfg: any) => void,
): Promise<string | null> {
  const [err, result] = await resolvePersistFn(getRuntime);
  if (err || !result) return err;

  try {
    await result.persist(updater);
    return null;
  } catch (e) {
    return `⚠️ 配置修改失败：${e instanceof Error ? e.message : String(e)}`;
  }
}
