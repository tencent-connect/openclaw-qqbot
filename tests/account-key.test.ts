/**
 * resolveAccountKey 测试
 */
import { describe, expect, it } from 'vitest';
import { resolveAccountKey } from '../src/setup/account-key.js';

// ── fixture 构造 ──

function makeCfg(accounts?: Array<{ id: string; appId: string }>): any {
  if (!accounts || accounts.length === 0) {
    return { channels: { qqbot: { enabled: true } } };
  }
  const accountsMap: Record<string, any> = {};
  for (const a of accounts) {
    accountsMap[a.id] = { appId: a.appId, clientSecret: 'secret', enabled: true };
  }
  return { channels: { qqbot: { enabled: true, accounts: accountsMap } } };
}

function makeTopLevelCfg(appId: string): any {
  return { channels: { qqbot: { enabled: true, appId, clientSecret: 'secret' } } };
}

// ── 测试 ──

describe('resolveAccountKey', () => {
  // ── resolvedId 指定 ──

  it('resolvedId takes priority over everything', () => {
    const cfg = makeCfg([{ id: 'existing', appId: '100001' }]);
    expect(resolveAccountKey(cfg, '100002', 'my-account')).toBe('my-account');
  });

  it('resolvedId works even with zero accounts', () => {
    const cfg = makeCfg([]);
    expect(resolveAccountKey(cfg, '100001', 'custom')).toBe('custom');
  });

  // ── 同 appId 刷新 ──

  it('same appId in named account → refresh that account', () => {
    const cfg = makeCfg([{ id: 'bot1', appId: '100001' }]);
    expect(resolveAccountKey(cfg, '100001')).toBe('bot1');
  });

  it('same appId in default (top-level) account → refresh default', () => {
    const cfg = makeTopLevelCfg('100001');
    expect(resolveAccountKey(cfg, '100001')).toBe('default');
  });

  it('same appId among multiple accounts → refreshes matching one', () => {
    const cfg = makeCfg([
      { id: 'bot1', appId: '100001' },
      { id: 'bot2', appId: '100002' },
      { id: 'bot3', appId: '100003' },
    ]);
    expect(resolveAccountKey(cfg, '100002')).toBe('bot2');
  });

  // ── 零账户 → default ──

  it('zero accounts → default', () => {
    const cfg = makeCfg([]);
    expect(resolveAccountKey(cfg, '100001')).toBe('default');
  });

  it('zero accounts, different appId → still default', () => {
    const cfg = makeCfg([]);
    expect(resolveAccountKey(cfg, '999999')).toBe('default');
  });

  // ── 已有其他账户，新 appId → 新增 ──

  it('existing accounts, new appId → uses appId as key', () => {
    const cfg = makeCfg([{ id: 'bot1', appId: '100001' }]);
    expect(resolveAccountKey(cfg, '200002')).toBe('200002');
  });

  it('multiple accounts, new appId → uses appId as key', () => {
    const cfg = makeCfg([
      { id: 'bot1', appId: '100001' },
      { id: 'bot2', appId: '100002' },
    ]);
    expect(resolveAccountKey(cfg, '200003')).toBe('200003');
  });

  // ── 边界情况 ──

  it('resolvedId=null/undefined → falls through', () => {
    const cfg = makeCfg([]);
    expect(resolveAccountKey(cfg, '100001', null)).toBe('default');
    expect(resolveAccountKey(cfg, '100001', undefined)).toBe('default');
  });

  it('resolvedId=empty string → falls through', () => {
    const cfg = makeCfg([]);
    expect(resolveAccountKey(cfg, '100001', '')).toBe('default');
  });

  it('appId is a numeric string', () => {
    const cfg = makeCfg([]);
    expect(resolveAccountKey(cfg, '1904094249')).toBe('default');
  });

  it('account IDs are numeric strings → match works', () => {
    const cfg = makeCfg([{ id: '102901613', appId: '1904094249' }]);
    expect(resolveAccountKey(cfg, '1904094249')).toBe('102901613');
  });

  it('account IDs are numeric, new appId creates numeric key', () => {
    const cfg = makeCfg([{ id: '102901613', appId: '1904094249' }]);
    expect(resolveAccountKey(cfg, '102942412')).toBe('102942412');
  });

  it('disabled account still matches by appId', () => {
    const cfg = {
      channels: {
        qqbot: {
          enabled: true,
          accounts: {
            bot1: { appId: '100001', clientSecret: 's', enabled: false },
          },
        },
      },
    };
    expect(resolveAccountKey(cfg, '100001')).toBe('bot1');
  });

  it('multiple accounts with same appId → returns first match', () => {
    const cfg = makeCfg([
      { id: 'bot1', appId: '100001' },
      { id: 'bot2', appId: '100001' },
    ]);
    expect(resolveAccountKey(cfg, '100001')).toBe('bot1');
  });
});
