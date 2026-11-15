/**
 * OpenClaw setup 向导 — QQ Bot 配置界面
 */
import type { ChannelSetupWizard } from '../adapter/setup.js';
import { createStandardChannelSetupStatus, setSetupChannelEnabled } from '../adapter/setup.js';
import { listQQBotAccountIds, resolveQQBotAccount, resolveDefaultQQBotAccountId } from '../config.js';
import { finalizeQQBotSetup } from './finalize.js';

const CHANNEL = 'qqbot' as const;

export const qqbotSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL,
  status: createStandardChannelSetupStatus({
    channelLabel: 'QQ Bot',
    configuredLabel: 'configured',
    unconfiguredLabel: 'needs AppID + AppSecret',
    configuredHint: 'configured',
    unconfiguredHint: 'needs AppID + AppSecret',
    configuredScore: 1,
    unconfiguredScore: 6,
    resolveConfigured: ({ cfg, accountId }) =>
      (accountId ? [accountId] : listQQBotAccountIds(cfg as any)).some((id) => {
        const account = resolveQQBotAccount(cfg as any, id);
        return Boolean(account.appId && account.clientSecret);
      }),
  }),
  // 未配置时默认使用 default 账号，有账户时框架会提示选择
  resolveAccountIdForConfigure: async ({ cfg, shouldPromptAccountIds, accountOverride, defaultAccountId }) => {
    if (accountOverride) return accountOverride;
    const ids = listQQBotAccountIds(cfg as any);
    if (ids.length === 0) return 'default';
    if (!shouldPromptAccountIds) return ids[0];
    return defaultAccountId || resolveDefaultQQBotAccountId(cfg as any);
  },
  credentials: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  finalize: (async ({ cfg, accountId, prompter, runtime }: any) =>
    finalizeQQBotSetup({ cfg, accountId, prompter: prompter as any, runtime: runtime as any })) as any,
  disable: (cfg) => { setSetupChannelEnabled(cfg, CHANNEL, false); return cfg; },
};
