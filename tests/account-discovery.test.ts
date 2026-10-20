import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const credentialBackup = vi.hoisted(() => ({
  load: vi.fn<(accountId?: string) => { accountId: string; appId: string; clientSecret: string; savedAt: string } | null>(),
}));

vi.mock('../src/features/credential-backup.js', () => ({
  loadCredentialBackup: credentialBackup.load,
}));

import {
  isQQBotAccountConfigured,
  listQQBotAccountIds,
  resolveQQBotAccount,
  resolveDefaultQQBotAccountId,
} from '../src/config.js';
import { qqbotPlugin } from '../src/channel.js';
import { qqbotOnboardingAdapter } from '../src/features/onboarding.js';
import { qqbotSetupWizard } from '../src/setup/surface.js';

const backupFor = (accountId: string) => ({
  accountId,
  appId: 'backup-app',
  clientSecret: 'backup-secret',
  savedAt: '2026-09-11T00:00:00.000Z',
});

describe('QQ Bot account discovery', () => {
  const originalAppId = process.env.QQBOT_APP_ID;

  beforeEach(() => {
    delete process.env.QQBOT_APP_ID;
    credentialBackup.load.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    if (originalAppId === undefined) {
      delete process.env.QQBOT_APP_ID;
    } else {
      process.env.QQBOT_APP_ID = originalAppId;
    }
  });

  it('discovers the default account from environment credentials', () => {
    process.env.QQBOT_APP_ID = 'env-app';

    expect(listQQBotAccountIds({ channels: { qqbot: { enabled: true } } } as never)).toEqual([
      'default',
    ]);
  });

  it('discovers and reports the default account from a recoverable backup', async () => {
    credentialBackup.load.mockImplementation((accountId) =>
      accountId === 'default' ? backupFor('default') : null,
    );
    const cfg = {
      channels: {
        qqbot: {
          enabled: true,
          accounts: {
            named: { appId: 'named-app', clientSecret: 'named-secret' },
          },
        },
      },
    } as never;

    expect(listQQBotAccountIds(cfg)).toEqual(['default', 'named']);
    expect(resolveDefaultQQBotAccountId(cfg)).toBe('default');
    const account = resolveQQBotAccount(cfg, 'default');
    expect(isQQBotAccountConfigured(account)).toBe(true);
    const snapshot = await qqbotPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: {},
    } as never);
    expect(snapshot).toMatchObject({ configured: true });
    const onboardingStatus = await qqbotOnboardingAdapter.getStatus?.({ config: cfg } as never);
    expect(onboardingStatus).toMatchObject({
      configured: true,
      accountCount: 2,
      defaultAccountId: 'default',
    });
    expect(qqbotSetupWizard.status.resolveConfigured({ cfg, accountId: 'default' })).toBe(true);
  });

  it('discovers a configured account whose credentials are recoverable from backup', () => {
    credentialBackup.load.mockImplementation((accountId) =>
      accountId === 'ops' ? backupFor('ops') : null,
    );
    const cfg = {
      channels: {
        qqbot: {
          enabled: true,
          accounts: {
            ops: { enabled: true },
          },
        },
      },
    } as never;

    expect(listQQBotAccountIds(cfg)).toEqual(['ops']);
    expect(resolveDefaultQQBotAccountId(cfg)).toBe('ops');
    expect(isQQBotAccountConfigured(resolveQQBotAccount(cfg, 'ops'))).toBe(true);
  });

  it('does not invent an unknown account from an unrelated backup', () => {
    credentialBackup.load.mockImplementation((accountId) =>
      accountId === 'orphan' ? backupFor('orphan') : null,
    );

    expect(listQQBotAccountIds({ channels: { qqbot: { enabled: true } } } as never)).toEqual([]);
    expect(isQQBotAccountConfigured()).toBe(false);
  });
});
