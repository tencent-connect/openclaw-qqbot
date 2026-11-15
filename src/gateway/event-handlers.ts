/**
 * QQBotGateway 事件处理
 *
 * 处理 SDK 的 message / interaction 事件：
 * - message: 中间件处理完毕后，将消息转发到 OpenClaw AI
 * - interaction: 配置更新 / 审批按钮
 */

import type { MiddlewareContext, QQBotInboundMessage, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { dispatchToOpenClaw } from '../dispatch/index.js';
import { runWithRequestContext } from '../request-context.js';
import { getApprovalHandler } from '../features/approval-handler.js';
import { recordKnownUser } from '../features/proactive.js';
import { cacheMsgId } from '../features/msgid-cache.js';
import { getAdapters } from '../adapter/resolve.js';
import { resolveGroupConfigFromAccount, resolveGroupPolicy, resolveMentionPatterns } from '../config.js';
import { getPackageVersion } from '../utils/pkg-version.js';
import { getOpenClawVersion } from '../bot-instance.js';

export async function handleMessage(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<void> {
  const hlog = log.child('handle');
  const scope = msg.replyTarget.scope;
  const targetId = scope === 'group'
    ? `qqbot:group:${msg.replyTarget.targetId}`
    : `qqbot:c2c:${msg.replyTarget.targetId}`;

  const mergedCount = (ctx.state.mergedMessages as unknown[] | undefined)?.length;
  if (mergedCount) {
    hlog.info(`merged batch count=${mergedCount} msgId=${msg.messageId}`);
  } else {
    hlog.debug(`enter msgId=${msg.messageId} scope=${scope} contentLen=${(msg.content ?? '').length}`);
  }

  try {
    cacheMsgId(scope, msg.replyTarget.targetId, msg.messageId);

    recordKnownUser({
      type: scope === 'group' ? 'group' : 'c2c',
      openid: scope === 'group' ? msg.replyTarget.targetId : msg.senderId,
      accountId: account.accountId,
      nickname: msg.senderName,
      lastInteractionAt: Date.now(),
    });

    await runWithRequestContext(
      {
        accountId: account.accountId,
        messageId: msg.messageId,
        openId: msg.senderId,
        target: targetId,
      },
      () => dispatchToOpenClaw(ctx, msg, account, runtime, log),
    );
  } catch (err) {
    hlog.error(`dispatch error: ${err}`);
  }
  hlog.debug(`done msgId=${msg.messageId}`);
}

const INTERACTION_QUERY  = 2001;
const INTERACTION_UPDATE = 2002;

export async function handleInteraction(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
  acknowledgeInteraction: (id: string, code?: number, data?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (event.data?.type === INTERACTION_QUERY) {
    await handleConfigQuery(event, account, runtime, log, acknowledgeInteraction);
    return;
  }
  if (event.data?.type === INTERACTION_UPDATE) {
    await handleConfigUpdate(event, account, runtime, log);
    try {
      const adapters = getAdapters(runtime);
      const cfg = adapters.getConfig?.() ?? {};
      const groupOpenid = (event as any).group_openid ?? '';
      const updatedCfg = groupOpenid ? resolveGroupConfigFromAccount(account, groupOpenid) : null;
      const requireMention = updatedCfg?.requireMention ?? true;
      const clawCfg = buildClawCfg(requireMention, [], resolveGroupPolicy(cfg, account.accountId));
      await acknowledgeInteraction(event.id, 0, { claw_cfg: clawCfg });
    } catch {
      try { await acknowledgeInteraction(event.id); } catch { /* ignore */ }
    }
    return;
  }

  await handleApproval(event, account, log, acknowledgeInteraction);
}

// ── Interaction 子处理 ──

async function handleConfigQuery(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
  ack: (id: string, code?: number, data?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const groupOpenid = (event as any).group_openid ?? '';
  try {
    const adapters = getAdapters(runtime);
    const cfg = adapters.getConfig?.() ?? {};
    const groupCfg = groupOpenid ? resolveGroupConfigFromAccount(account, groupOpenid) : null;
    const requireMention = groupCfg?.requireMention ?? true;
    const agentId = groupOpenid
      ? adapters.resolveAgentRoute?.({ cfg, channel: 'qqbot', accountId: account.accountId, peer: { kind: 'group', id: groupOpenid } })?.agentId
      : undefined;
    const mentionPatterns = resolveMentionPatterns(cfg, agentId);
    const clawCfg = buildClawCfg(requireMention, mentionPatterns, resolveGroupPolicy(cfg, account.accountId));
    log.info(`interaction query: group=${groupOpenid} requireMention=${requireMention}`);
    await ack(event.id, 0, { claw_cfg: clawCfg });
  } catch (err) {
    log.warn(`interaction query failed: ${(err as Error)?.message ?? err}, ack without data`);
    try { await ack(event.id); } catch { /* ignore */ }
  }
}

async function handleConfigUpdate(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<void> {
  const resolved = (event.data as any)?.resolved;
  const update = resolved?.claw_cfg;
  const groupOpenid = (event as any).group_openid ?? '';

  if (update?.require_mention !== undefined && groupOpenid) {
    try {
      await setGroupRequireMention(runtime, account.accountId, groupOpenid, update.require_mention === 'mention');
      log.info(`interaction: group=${groupOpenid} requireMention=${update.require_mention}`);
    } catch (err) {
      log.error(`interaction update failed: ${err}`);
    }
  }
}

async function handleApproval(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  log: PluginLogger,
  ack: (id: string) => Promise<void>,
): Promise<void> {
  try { await ack(event.id); } catch { /* ignore */ }

  const buttonData = event.data?.resolved?.button_data;
  if (!buttonData?.startsWith('approve:')) return;

  // 身份授权校验：操作者需在 allowFrom 白名单中
  const operatorId = resolveOperatorId(event);
  if (!isApprovalAuthorized(account, operatorId)) {
    log.warn(`[approval] unauthorized operator=${operatorId ?? 'unknown'} account=${account.accountId}`);
    return;
  }

  const parts = buttonData.split(':');
  if (parts.length < 3) return;

  const handler = getApprovalHandler(account.accountId);
  if (!handler) return;

  const approvalId = parts[1];
  const decision = parts[2] as 'allow-once' | 'allow-always' | 'deny';
  try { await handler.resolveApproval(approvalId, decision); } catch (err) {
    log.error(`interaction approve error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const CHANNEL_VER = getPackageVersion();

// ── 审批授权校验 ──

/**
 * 从交互事件中提取操作者身份标识。
 * QQ Bot 按钮回调事件中，操作者 openid 通常在 `user_openid` 或 `data.resolved.user_id` 字段。
 */
function resolveOperatorId(event: InteractionEvent): string | undefined {
  const evt = event as any;
  return evt.user_openid
    ?? evt.data?.resolved?.user_id
    ?? evt.data?.resolved?.user_openid
    ?? evt.openid;
}

/**
 * 校验操作者是否有权限执行审批操作。
 * 规则：allowFrom 为空或含 "*" → 开放；否则操作者必须在 allowFrom 中。
 */
function isApprovalAuthorized(account: ResolvedQQBotAccount, operatorId?: string): boolean {
  if (!operatorId) return false;
  const allowFrom = account.config?.allowFrom ?? [];
  if (!allowFrom.length || allowFrom.includes('*')) return true;
  return allowFrom.includes(operatorId);
}

function buildClawCfg(
  requireMention: boolean,
  mentionPatterns: string[],
  groupPolicy: string,
): Record<string, unknown> {
  return {
    channel_type: 'qqbot',
    channel_ver: CHANNEL_VER,
    claw_type: 'openclaw',
    claw_ver: getOpenClawVersion(),
    require_mention: requireMention ? 'mention' : 'always',
    group_policy: groupPolicy,
    mention_patterns: mentionPatterns.join(','),
    online_state: 'online',
  };
}

// ── Config 写入 ──

function setGroupRequireMention(
  runtime: PluginRuntime,
  accountId: string,
  groupOpenid: string,
  requireMention: boolean,
): Promise<void> {
  const adapters = getAdapters(runtime);
  return adapters.persistConfig?.((cfg: any) => {
    const qqbot = (cfg.channels ?? {})?.qqbot ?? {};
    const groups = accountId !== 'default' && qqbot.accounts?.[accountId]
      ? (qqbot.accounts[accountId].groups = { ...qqbot.accounts[accountId].groups })
      : (qqbot.groups = { ...qqbot.groups });
    groups[groupOpenid] = { ...groups[groupOpenid], requireMention };
  }) ?? Promise.resolve();
}
