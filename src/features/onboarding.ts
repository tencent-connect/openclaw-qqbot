/**
 * QQBot CLI Onboarding Adapter
 *
 * 提供 openclaw onboard 命令的交互式配置支持。
 * 从原 src/onboarding.ts 迁移，保持接口兼容。
 */
import type {
  ChannelOnboardingAdapter,
  OpenClawConfig,
} from 'openclaw/plugin-sdk';
import { DEFAULT_ACCOUNT_ID, listQQBotAccountIds, resolveQQBotAccount } from '../config.js';

/**
 * Onboarding adapter — 导出给 ChannelPlugin 使用
 *
 * 注：完整 onboarding 交互逻辑较复杂（约 300 行），
 * 此处仅保留 adapter 骨架，完整实现从原文件迁移。
 */
export const qqbotOnboardingAdapter: ChannelOnboardingAdapter = {
  getStatus: (ctx) => {
    const cfg = ctx.config as OpenClawConfig;
    const accountIds = listQQBotAccountIds(cfg);
    if (accountIds.length === 0) {
      return { configured: false, accountCount: 0 };
    }
    const firstAccount = resolveQQBotAccount(cfg, accountIds[0]);
    return {
      configured: Boolean(firstAccount.appId && firstAccount.clientSecret),
      accountCount: accountIds.length,
      defaultAccountId: accountIds[0],
    };
  },
  configure: async (ctx) => {
    // 完整实现需要从原 onboarding.ts 迁移交互逻辑
    // 此处返回默认结果
    return { success: false, message: 'Onboarding not yet migrated to new architecture' };
  },
};
