/**
 * Gateway 生命周期管理
 *
 * 封装 startAccount / logoutAccount 的业务逻辑：
 * - 凭证恢复
 * - QQBotGateway 实例创建与注册
 * - Features 初始化（update-checker、approval-handler）
 * - 登出时凭证清除
 */
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import type { ResolvedQQBotAccount } from '../types.js';
import { DEFAULT_ACCOUNT_ID, resolveQQBotAccount, applyQQBotAccountConfig } from '../config.js';
import { getQQBotRuntime } from '../runtime.js';
import { getAdapters } from '../adapter/resolve.js';
import { QQBotGateway } from './qqbot-gateway.js';
import { createPluginLogger } from '../utils/plugin-logger.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { registerGateway, unregisterGateway, getGateway } from '../outbound/outbound-service.js';
import { saveCredentialBackup, loadCredentialBackup } from '../features/credential-backup.js';
import { triggerUpdateCheck } from '../features/update-checker.js';
import { QQBotApprovalHandler, registerApprovalHandler, unregisterApprovalHandler, getApprovalHandler } from '../features/approval-handler.js';

export interface StartAccountContext {
  account: ResolvedQQBotAccount;
  abortSignal?: AbortSignal;
  cfg: any;
  /**
   * 框架传入的基础 logger（无 child 方法）。内部会自动包装为 PluginLogger。
   * 写日志的优先级：info > warn > error > debug，方法均为必选。
   */
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug: (msg: string) => void };
  getStatus: () => Record<string, unknown>;
  setStatus: (s: Record<string, unknown>) => void;
  [key: string]: unknown;
}

/**
 * 启动账户（含凭证恢复 + features 初始化）
 */
export async function startAccountWithCredentialRecovery(ctx: StartAccountContext): Promise<void> {
  let { account } = ctx;
  const { abortSignal, cfg } = ctx;
  const log: PluginLogger = createPluginLogger({
    prefix: `[${account.accountId}]`,
    ...(ctx.log?.info ? { output: ctx.log as PluginLogger } : {}),
  });
  const runtime = getQQBotRuntime();

  // 凭证恢复：配置中 appId/secret 为空时尝试从暂存文件恢复
  if (!account.appId || !account.clientSecret) {
    const backup = loadCredentialBackup(account.accountId);
    if (backup) {
      log?.info(`[qqbot:${account.accountId}] 从暂存文件恢复凭证 (appId=${backup.appId})`);
      try {
        const restoredCfg = applyQQBotAccountConfig(cfg, account.accountId, {
          appId: backup.appId,
          clientSecret: backup.clientSecret,
            });
        const adapters = getAdapters(runtime);
        if (adapters.persistConfig) {
          await adapters.persistConfig(() => restoredCfg);
        }
        account = resolveQQBotAccount(restoredCfg, account.accountId);
      } catch (e) {
        log?.error(`[qqbot:${account.accountId}] 凭证恢复失败: ${e}`);
      }
    }
  }

  // 创建 gateway 实例并注册
  const gw = new QQBotGateway(account, runtime, log);
  registerGateway(account.accountId, gw);

  const isCurrent = () => getGateway(account.accountId) === gw && !abortSignal?.aborted;
  let features: Promise<void> | undefined;
  try {
    await gw.start(
      {
        onReady: () => {
          if (!isCurrent()) return;
          saveCredentialBackup(account.accountId, account.appId, account.clientSecret);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
            lastError: null,
          });

          // Features belong to this account lifetime, not each WebSocket resume.
          features ??= initFeatures(account, cfg, log).catch((e) => {
            log.error(`[qqbot:${account.accountId}] initFeatures error: ${e}`);
          });
        },
        onDisconnected: ({ code, reason }) => {
          if (!isCurrent()) return;
          const error = `WebSocket closed: ${code}${reason ? ` ${reason}` : ''}`;
          ctx.setStatus({
            ...ctx.getStatus(),
            connected: false,
            lastDisconnect: { at: Date.now(), error },
          });
        },
        onError: (error) => {
          if (!isCurrent()) return;
          log.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({ ...ctx.getStatus(), lastError: error.message });
        },
      },
      abortSignal,
    );
  } catch (error) {
    if (getGateway(account.accountId) === gw) {
      ctx.setStatus({ ...ctx.getStatus(), lastError: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  } finally {
    if (getGateway(account.accountId) === gw) {
      ctx.setStatus({ ...ctx.getStatus(), running: false, connected: false });
      await features;
      if (getGateway(account.accountId) === gw) {
        await stopAccountGracefully({ accountId: account.accountId, log });
      }
    }
  }
}

/**
 * Gateway ready 后初始化各 feature 模块
 */
async function initFeatures(account: ResolvedQQBotAccount, cfg: any, log: PluginLogger): Promise<void> {
  // 1. 版本更新检测（后台预热，fire-and-forget）
  triggerUpdateCheck(log);

  const existing = getApprovalHandler(account.accountId);
  if (existing) {
    await existing.stop();
    unregisterApprovalHandler(account.accountId);
  }
  const approvalLog = log.child('approval');
  try {
    const handler = new QQBotApprovalHandler({
      accountId: account.accountId,
      appId: account.appId,
      clientSecret: account.clientSecret,
      cfg,
      log: approvalLog,
    });
    registerApprovalHandler(account.accountId, handler);
    await handler.start();
    approvalLog.info('registered');
  } catch (e) {
    approvalLog.debug(`not available: ${e}`);
  }
}

/**
 * Stop the registered account, also used when the SDK lifecycle exits.
 * Detach its resources before awaiting cleanup so a replacement remains registered.
 */
export async function stopAccountGracefully(params: {
  accountId: string;
  log?: PluginLogger;
}): Promise<void> {
  const { accountId, log } = params;
  const gw = getGateway(accountId);
  const handler = getApprovalHandler(accountId);
  // Release ownership before awaiting cleanup so an old stop cannot remove a replacement.
  unregisterGateway(accountId);
  unregisterApprovalHandler(accountId);
  if (gw) {
    try {
      await gw.stop();
      log?.info(`[qqbot:${accountId}] gateway stopped`);
    } catch (err) {
      log?.error(`[qqbot:${accountId}] gateway stop error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await handler?.stop();
  } catch {
  }
}

/**
 * 登出账户（清除凭证）
 */
export async function logoutAndClearCredentials(params: {
  accountId: string;
  cfg: any;
}): Promise<{ ok: boolean; cleared: boolean; envToken: boolean; loggedOut: boolean }> {
  const { accountId, cfg } = params;
  unregisterGateway(accountId);
  try {
    const h = getApprovalHandler(accountId);
    if (h) await h.stop();
  } catch {
  }
  unregisterApprovalHandler(accountId);

  const nextCfg = { ...cfg } as OpenClawConfig;
  const nextQQBot = cfg.channels?.qqbot ? { ...cfg.channels.qqbot } : undefined;
  let cleared = false;
  let changed = false;

  if (nextQQBot) {
    const qqbot = nextQQBot as Record<string, unknown>;
    if (accountId === DEFAULT_ACCOUNT_ID && qqbot.clientSecret) {
      delete qqbot.clientSecret;
      cleared = true;
      changed = true;
    }
    const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
    if (accounts && accountId in accounts) {
      const entry = accounts[accountId];
      if (entry && 'clientSecret' in entry) {
        delete entry.clientSecret;
        cleared = true;
        changed = true;
      }
      if (entry && Object.keys(entry).length === 0) {
        delete accounts[accountId];
        changed = true;
      }
    }
  }

  if (changed && nextQQBot) {
    nextCfg.channels = { ...nextCfg.channels, qqbot: nextQQBot };
    const runtime = getQQBotRuntime();
    const adapters = getAdapters(runtime);
    if (adapters.persistConfig) {
      await adapters.persistConfig(() => nextCfg);
    }
  }

  const resolved = resolveQQBotAccount(changed ? nextCfg : cfg, accountId);
  const loggedOut = resolved.secretSource === 'none';
  const envToken = Boolean(process.env.QQBOT_CLIENT_SECRET);
  return { ok: true, cleared, envToken, loggedOut };
}
