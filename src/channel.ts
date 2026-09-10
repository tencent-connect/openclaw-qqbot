/**
 * QQ Bot ChannelPlugin 定义
 *
 * 薄壳编排层 — 实现 OpenClaw ChannelPlugin 接口，
 * 将各子模块（gateway/outbound/config/features）连接为完整通道插件。
 */
import {
  type ChannelPlugin,
  type OpenClawConfig,
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from 'openclaw/plugin-sdk/core';

import type { ResolvedQQBotAccount } from './types.js';
import {
  DEFAULT_ACCOUNT_ID,
  listQQBotAccountIds,
  resolveQQBotAccount,
  applyQQBotAccountConfig,
  resolveDefaultQQBotAccountId,
  isQQBotAccountConfigured,
  resolveRequireMention,
  resolveToolPolicy,
  resolveGroupConfig,
} from './config.js';
import { getQQBotRuntime, tryGetQQBotRuntime } from './runtime.js';
import { getAdapters } from './adapter/resolve.js';
import { sendText, getGateway } from './outbound/outbound-service.js';
import { sendMedia } from './outbound/media-send.js';
import { createPluginLogger, type PluginLogger } from './utils/plugin-logger.js';
import { qqbotSetupWizard } from './setup/surface.js';
import { qqbotLogin, startQrLogin, waitQrLogin } from './setup/login.js';
import { normalizeTarget, isQQBotTarget } from './outbound/target.js';
import { sanitizeQQBotText } from './outbound/sanitize.js';
import { startAccountWithCredentialRecovery, logoutAndClearCredentials, stopAccountGracefully } from './gateway/lifecycle.js';
import { isApprovalPayload, approvalStubs } from './features/approval-utils.js';
import { qqbotOnboardingAdapter } from './features/onboarding.js';
import { stripMentionText } from './utils/mention.js';

/** QQ Bot 单条消息文本长度上限 */
export const TEXT_CHUNK_LIMIT = 5000;

// ── GFM 表格检测 ──

/** GFM 表格数据行: | col1 | col2 | */
const GFM_TABLE_DATA_RE = /^\|.+\|.*\|/;
/** GFM 表格分隔行: |---|:---:|---| (1 个或多于 1 个破折号，支持对齐冒号) */
const GFM_TABLE_SEP_RE = /^\|[\s:-]+\|/;

/**
 * 判断一行是否为 GFM 表格行（数据行或分隔行）。
 * 保障 table-aware chunker 不会在表格内部切分。
 */
function isGfmTableLine(line: string): boolean {
  return GFM_TABLE_DATA_RE.test(line) || GFM_TABLE_SEP_RE.test(line);
}

export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  id: 'qqbot',
  meta: {
    id: 'qqbot',
    label: 'QQ Bot',
    selectionLabel: 'QQ Bot',
    docsPath: '/docs/channels/qqbot',
    blurb: 'Connect to QQ via official QQ Bot API',
    order: 50,
  },
  capabilities: {
    chatTypes: ['direct', 'group'],
    media: true,
    reactions: false,
    threads: false,
    blockStreaming: false,
  },
  gatewayMethods: ['web.login.start', 'web.login.wait'],
  reload: { configPrefixes: ['channels.qqbot'] },

  // ── 群消息策略 ──
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      if (!groupId) return undefined;
      return resolveRequireMention(cfg, groupId, accountId ?? undefined);
    },
    resolveToolPolicy: ({ cfg, accountId, groupId }) => {
      if (!groupId) return undefined;
      const policy = resolveToolPolicy(cfg, groupId, accountId ?? undefined);
      if (policy === 'full') return undefined;
      if (policy === 'none') return { allow: [], deny: ['*'] };
      return { allow: [] };
    },
    resolveGroupIntroHint: ({ cfg, accountId, groupId }) => {
      if (!groupId) return undefined;
      const groupCfg = resolveGroupConfig(cfg, groupId, accountId ?? undefined);
      return groupCfg.name ? `当前群: ${groupCfg.name}` : undefined;
    },
  },

  // ── @mention 检测与清理 ──
  mentions: {
    stripMentions: ({ text, ctx }) => {
      const mentions = (ctx as any)?.mentions;
      return stripMentionText(text, mentions);
    },
  },

  // @ts-ignore onboarding 兼容
  onboarding: qqbotOnboardingAdapter,

  // ── 配置管理 ──
  config: {
    listAccountIds: (cfg) => listQQBotAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveQQBotAccount(cfg, accountId),
    defaultAccountId: (cfg) => resolveDefaultQQBotAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({ cfg, sectionKey: 'qqbot', accountId, enabled, allowTopLevel: true }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg, sectionKey: 'qqbot', accountId,
        clearBaseFields: ['appId', 'clientSecret', 'clientSecretFile', 'name'],
      }),
    isConfigured: (account) => isQQBotAccountConfigured(account),
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: isQQBotAccountConfigured(account),
      tokenSource: account?.secretSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => {
      const account = resolveQQBotAccount(cfg, accountId ?? undefined);
      return (account.config?.allowFrom ?? []).map((e: string | number) => String(e)) as (string | number)[];
    },
    formatAllowFrom: ({ allowFrom }: { allowFrom: (string | number)[] }) =>
      allowFrom
        .map((e: string | number) => String(e).trim())
        .filter(Boolean)
        .map((e: string) => e.replace(/^qqbot:/i, '').toUpperCase()),
  },

  // ── Setup ──
  setup: {
    resolveAccountId: ({ accountId }) => accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_ID,
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({ cfg, channelKey: 'qqbot', accountId, name }),
    validateInput: ({ input }) => {
      if (!input.token && !input.tokenFile && !input.useEnv) {
        return 'QQBot requires --token (format: appId:clientSecret) or --use-env';
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let appId = '';
      let clientSecret = '';
      if (input.token) {
        const parts = input.token.split(':');
        if (parts.length === 2) { appId = parts[0]; clientSecret = parts[1]; }
      }
      return applyQQBotAccountConfig(cfg, accountId, {
        appId, clientSecret,
        clientSecretFile: input.tokenFile,
        name: input.name,
      }) as OpenClawConfig;
    },
  },

  setupWizard: qqbotSetupWizard,

  // ── Messaging ──
  messaging: {
    normalizeTarget,
    targetResolver: {
      looksLikeId: isQQBotTarget,
      hint: 'QQ Bot 目标格式: qqbot:c2c:openid (私聊) 或 qqbot:group:groupid (群聊)',
    },
  },

  // ── 出站 ──
  outbound: {
    deliveryMode: 'direct' as const,
    sanitizeText: ({ text }: { text: string; payload: any }) => sanitizeQQBotText(text),
    chunker: (text, limit) => {
      const adapters = getAdapters(getQQBotRuntime());
      if (adapters.chunkMarkdownText) return adapters.chunkMarkdownText(text, limit);
      // fallback（低版本降级）: 按换行边界切分，保留 Markdown 表格完整性
      const lines = text.split('\n');
      const chunks: string[] = [];
      let current = '';
      let tableBuffer: string[] = [];

      const flushTable = () => {
        if (tableBuffer.length === 0) return;
        const tableBlock = tableBuffer.join('\n');
        const candidate = current ? `${current}\n${tableBlock}` : tableBlock;
        if (candidate.length > limit && current) {
          chunks.push(current);
          current = tableBlock;
        } else {
          current = candidate;
        }
        tableBuffer = [];
      };

      for (const line of lines) {
        if (isGfmTableLine(line)) {
          tableBuffer.push(line);
          continue;
        }

        // 遇到非表格行，先刷新缓冲的表格
        flushTable();

        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length > limit && current) {
          chunks.push(current);
          current = line;
        } else {
          current = candidate;
        }
      }
      // 处理末尾的表格缓冲
      flushTable();
      if (current) chunks.push(current);
      return chunks.length > 0 ? chunks : [text];
    },
    chunkerMode: 'markdown',
    textChunkLimit: TEXT_CHUNK_LIMIT,
    shouldSuppressLocalPayloadPrompt: ({ payload }: any) => isApprovalPayload(payload),
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId ?? undefined);
      const outLog = createOutLog(account.accountId);
      outLog.debug(`sendText to=${to} len=${text.length} replyTo=${replyToId ?? '-'}`);
      const result = await sendText({ to, text, accountId, replyToId, account });
      if (result.error) throw new Error(result.error);
      return { channel: 'qqbot' as const, messageId: result.messageId ?? '' };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
      const resolvedAccountId = accountId ?? resolveDefaultQQBotAccountId(cfg);
      const outLog = createOutLog(resolvedAccountId);
      outLog.debug(`sendMedia to=${to} url=${mediaUrl?.slice(0, 80)} len=${text?.length ?? 0} replyTo=${replyToId ?? '-'}`);
      const result = await sendMedia({
        to,
        source: mediaUrl ?? '',
        text,
        replyToId,
        accountId: resolvedAccountId,
        log: outLog,
        agentId: resolveMCPAgentId(to, resolvedAccountId, cfg, outLog),
      });
      if (result.error) {
        outLog.error(`sendMedia failed: ${result.error}`);
        throw new Error(result.error);
      }
      return { channel: 'qqbot' as const, messageId: result.messageId ?? '' };
    },
  },

  // ── 网关 ──
  gateway: {
    startAccount: (ctx) => startAccountWithCredentialRecovery(ctx),
    stopAccount: async (ctx: { accountId: string; log?: any }) => {
      await stopAccountGracefully({
        accountId: ctx.accountId,
        log: ctx.log,
      });
    },
    logoutAccount: (params) => logoutAndClearCredentials(params),
    loginWithQrStart: async ({ accountId }: { accountId?: string }) => startQrLogin(accountId),
    loginWithQrWait: async ({ accountId }: { accountId?: string }) => {
      const result = await waitQrLogin(accountId);
      return { connected: result.connected, message: result.message };
    },
  },

  // ── 登录认证 ──
  auth: {
    login: qqbotLogin as any,
    // 审批权限（从 approvalStubs 迁移）
    authorizeActorAction: () => ({ authorized: true } as const),
    getActionAvailabilityState: () => ({ kind: 'enabled' as const } as const),
  },

  // ── 状态 ──
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? 'none',
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: isQQBotAccountConfigured(account),
      tokenSource: account?.secretSource,
      running: Boolean(runtime?.running ?? false),
      connected: Boolean(runtime?.connected ?? false),
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  // ── 审批（stub — 实际由 features/approval-handler 处理）──
  ...approvalStubs,
};

function resolveMCPAgentId(to: string, accountId: string, cfg: unknown, log?: PluginLogger): string | undefined {
  try {
    const parts = to.split(':');
    const scope = parts[1];
    const peerId = parts[2];
    if (!scope || !peerId) return undefined;
    const rt = tryGetQQBotRuntime();
    if (!rt) return undefined;
    const route = getAdapters(rt).resolveAgentRoute?.({
      cfg, channel: 'qqbot', accountId,
      peer: { kind: scope === 'group' ? 'group' : 'direct', id: peerId },
    });
    log?.debug(`resolveMCPAgentId to=${to} => agentId=${route?.agentId ?? 'none'}`);
    return route?.agentId;
  } catch { return undefined; }
}

function createOutLog(accountId: string): PluginLogger {
  const gwLog = getGateway(accountId)?.log;
  if (gwLog) return gwLog.child('outbound');
  return createPluginLogger({ forceConsole: true, prefix: `[${accountId}]` }).child('outbound');
}

// Re-export for backward compatibility
export { stripMentionText } from './utils/mention.js';
export { detectWasMentioned } from './utils/mention.js';
