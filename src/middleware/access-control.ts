/**
 * 动态访问控制中间件。
 *
 * 从 ctx.state.policy（由 policy-injector 注入）动态读取策略，支持配置热更新。
 * 模式：disabled | open | allowlist | pairing（仅 c2c）
 */
import type { Middleware } from '@tencent-connect/qqbot-nodejs';
import { getPairingApi } from '../adapter/pairing.js';


/**
 * 创建动态访问控制中间件。
 *
 * 决策优先级：
 *   1. disabled → 拒绝
 *   2. open → 放行
 *   3. allowlist → allowFrom 匹配（默认模式）
 *   4. pairing → allowFrom + pairing store，未配对发起挑战
 */
export function dynamicAccessControl(params: {
  accountId: string;
  getRuntime: () => any;
}): Middleware {
  const { accountId, getRuntime } = params;

  return async (ctx, next) => {
    const p = ctx.state.policy as Record<string, unknown> | undefined;
    const isGroup = ctx.message.kind === 'group';
    const mode: string = isGroup
      ? (p?.groupMode as string) ?? 'open'
      : (p?.c2cMode as string) ?? 'allowlist';

    if (mode === 'disabled') {
      ctx.log?.info?.(`[access] blocked ${isGroup ? 'group' : 'c2c'} from ${ctx.message.senderId}: policy disabled`);
      ctx.stop('access:policy_disabled');
      return;
    }
    if (mode === 'open') {
      await next();
      return;
    }

    // allowlist / pairing：c2c 用 allowFrom，group 用 groupAllowFrom
    const allowList = isGroup
      ? ((p?.groupAllowFrom as string[]) ?? [])
      : ((p?.allowFrom as string[]) ?? []);
    if (!allowList.length || allowList.includes('*')) {
      await next();
      return;
    }

    const id = isGroup
      ? (ctx.message.groupOpenid ?? '')
      : (ctx.message.senderId as string);
    if (allowList.includes(id)) {
      await next();
      return;
    }

    // allowlist 未匹配 → pairing 模式尝试 pairing store（仅 c2c）
    if (mode === 'pairing' && !isGroup) {
      await checkPairingMode(ctx, next, {
        accountId,
        getRuntime,
        senderId: ctx.message.senderId as string,
      });
      return;
    }

    // 未匹配 → 拒绝
    const listLabel = isGroup ? 'groupAllowFrom' : 'allowFrom';
    ctx.log?.info?.(
      `[access] blocked ${isGroup ? 'group' : 'c2c'} from ${id}: not in ${listLabel}`,
    );
    ctx.stop('access:not_allowlisted');
  };
}

/**
 * pairing 模式：检查 pairing store + 发起配对挑战。
 */
async function checkPairingMode(
  ctx: any,
  next: () => Promise<void>,
  opts: { accountId: string; getRuntime: () => any; senderId: string },
): Promise<void> {
  const api = getPairingApi();
  if (!api) {
    ctx.log?.info?.(`[access] pairing unavailable for ${opts.senderId}`);
    ctx.stop('access:pairing_unavailable');
    return;
  }

  try {
    const storeIds = await api.readAllowFromStore({
      channel: 'qqbot',
      accountId: opts.accountId,
    });
    if (storeIds.includes(opts.senderId) || storeIds.includes('*')) {
      await next();
      return;
    }

    const challenge = await api.issueChallenge({
      channel: 'qqbot',
      id: opts.senderId,
      accountId: opts.accountId,
    });
    const frameworkReply = api.buildReply({
      code: challenge.code,
      channel: 'qqbot',
    });
    const reply = [
      frameworkReply,
      '',
      'QQ 管理员可直接执行：',
      '',
      '```',
      `/bot-pairing approve ${challenge.code}`,
      '```',
    ].join('\n');

    ctx.log?.info?.(`[access] pairing required for ${opts.senderId}`);
    await ctx.bot.sendText(ctx.replyTarget, reply).catch(() => {/* ignore */});
    ctx.stop('access:pairing_required');
  } catch (err) {
    ctx.log?.error?.(`[access] pairing error: ${(err as Error).message}`);
    ctx.stop(`access:pairing_error: ${(err as Error).message}`);
  }
}
