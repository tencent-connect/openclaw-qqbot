/**
 * openclaw setup 引导 — QQ Bot 扫码/手动绑定
 */
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { DEFAULT_ACCOUNT_ID, formatDocsLink } from '../adapter/setup.js';
import { qrConnect } from '@tencent-connect/qqbot-connector';
import { applyQQBotAccountConfig, resolveQQBotAccount } from '../config.js';
import { resolveAccountKey } from './account-key.js';

type Prompter = {
  select: (opts: { message: string; options: Array<{ value: string; label: string; hint?: string }> }) => Promise<string>;
  text: (opts: { message: string; validate?: (v: string) => string | undefined }) => Promise<string>;
  note: (msg: string, title?: string) => Promise<void>;
};

type Runtime = {
  log: (msg: string) => void;
  error: (msg: string) => void;
};

function isConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  const account = resolveQQBotAccount(cfg, accountId);
  return Boolean(account.appId && account.clientSecret);
}

async function linkViaQrCode(cfg: OpenClawConfig, _accountId: string, prompter: Prompter, rt: Runtime): Promise<OpenClawConfig> {
  try {
    const accounts: Array<{ appId: string; appSecret: string; userOpenid?: string }> = await qrConnect({ source: 'openclaw' });

    if (accounts.length === 0) {
      await prompter.note('未获取到任何 QQ Bot 账号信息。', 'QQ Bot');
      return cfg;
    }

    let next = cfg;
    for (const { appId, appSecret, userOpenid } of accounts) {
      // 同 appId 刷新；零账户 default；已有账户新增 appId
      const key = resolveAccountKey(cfg, appId);
      next = applyQQBotAccountConfig(next, key, { appId, clientSecret: appSecret });
      next = applyAccountDefaults(next, key, userOpenid);
      rt.log(`绑定成功！账户: ${key} (AppID: ${appId})`);
    }

    return next;
  } catch (err) {
    rt.error(`QQ Bot 绑定失败: ${String(err)}`);
    await prompter.note(`绑定失败，您可以稍后手动配置。\n文档: ${formatDocsLink('/channels/qqbot', 'qqbot')}`, 'QQ Bot');
    return cfg;
  }
}

async function linkViaManual(cfg: OpenClawConfig, _accountId: string, prompter: Prompter): Promise<OpenClawConfig> {
  const appIdInput = await prompter.text({ message: '请输入 QQ Bot AppID', validate: (v) => v.trim() ? undefined : 'AppID 不能为空' });
  const secret = await prompter.text({ message: '请输入 QQ Bot AppSecret', validate: (v) => v.trim() ? undefined : 'AppSecret 不能为空' });
  const appId = appIdInput.trim();
  const key = resolveAccountKey(cfg, appId);
  let next = applyQQBotAccountConfig(cfg, key, { appId, clientSecret: secret.trim() });
  next = applyAccountDefaults(next, key);
  await prompter.note('✔ QQ Bot 配置完成！', 'QQ Bot');
  return next;
}

export async function finalizeQQBotSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  prompter: Prompter;
  runtime: Runtime;
}): Promise<{ cfg: OpenClawConfig }> {
  const accountId = params.accountId.trim() || DEFAULT_ACCOUNT_ID;
  const configured = isConfigured(params.cfg, accountId);

  const mode = await params.prompter.select({
    message: configured ? 'QQ 已绑定，选择操作' : '选择 QQ 绑定方式',
    options: [
      { value: 'qr', label: '扫码绑定（推荐）', hint: '使用 QQ 扫描二维码自动完成绑定' },
      { value: 'manual', label: '手动输入 QQ Bot AppID 和 AppSecret', hint: '需到 QQ 开放平台 q.qq.com 查看' },
      { value: 'skip', label: configured ? '保持当前配置' : '稍后配置' },
    ],
  });

  let next = params.cfg;
  if (mode === 'qr') {
    next = await linkViaQrCode(next, accountId, params.prompter, params.runtime);
  } else if (mode === 'manual') {
    next = await linkViaManual(next, accountId, params.prompter);
  } else if (!configured) {
    await params.prompter.note('您可以稍后运行以下命令重新配置：\n  openclaw channels add', 'QQ Bot');
  }

  return { cfg: next };
}

export function applyAccountDefaults(cfg: OpenClawConfig, accountId: string, userOpenid?: string): OpenClawConfig {
  const next = { ...cfg, channels: { ...cfg.channels } };
  const qqbot = { ...(next.channels?.qqbot as Record<string, unknown> ?? {}) } as Record<string, unknown>;

  const defaults: Record<string, unknown> = { streaming: { mode: 'partial' }, dmPolicy: 'allowlist', mediaMaxMb: 200 };
  if (userOpenid) defaults.allowFrom = [userOpenid];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    Object.assign(qqbot, defaults);
  } else {
    const accounts = { ...(qqbot.accounts as Record<string, unknown> ?? {}) };
    accounts[accountId] = { ...(accounts[accountId] as Record<string, unknown> ?? {}), ...defaults };
    qqbot.accounts = accounts;
  }

  next.channels = { ...next.channels, qqbot };
  return next;
}
