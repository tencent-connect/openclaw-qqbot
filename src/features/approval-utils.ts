/**
 * 审批相关工具函数
 *
 * 审批 payload 判断逻辑，供 channel.ts 和 features/approval-handler 使用。
 */

/** 审批卡片投递目标（QQ 私聊或群聊） */
export interface ApprovalTarget {
  type: "c2c" | "group";
  id: string;
}

/**
 * Resolve the QQ delivery target for an approval card.
 *
 * sessionKey and turnSourceTo are parsed independently and the first one that
 * carries a qqbot segment wins. A DM (or cron/API-triggered) session may be
 * bound to a channel-agnostic session key (e.g. agent:main:main or
 * agent:main:cron:<uuid>:run:<uuid>); in that case sessionKey matches nothing
 * and we must fall back to turnSourceTo, otherwise the approval card is
 * silently dropped (shows up as "no QQ target" in the log).
 *
 * sessionKey keeps priority so existing group-chat behavior is unchanged.
 * The id is intentionally length-agnostic ([A-F0-9]+): openids are 32 hex
 * chars, but QQ group ids are plain decimal numbers of varying length.
 */
export function resolveTarget(
  sessionKey: string | null | undefined,
  turnSourceTo: string | null | undefined
): ApprovalTarget | null {
  const parse = (
    value: string | null | undefined
  ): ApprovalTarget | null => {
    if (!value) return null;
    const m = value.match(/qqbot:(c2c|direct|group):([A-F0-9]+)/i);
    if (!m) return null;
    const type = m[1]!.toLowerCase() === "group" ? "group" : "c2c";
    return { type, id: m[2]! };
  };
  return parse(sessionKey) ?? parse(turnSourceTo);
}

/** 检查 payload 是否为审批消息（execApproval / plugin approval） */
export function isApprovalPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  const cd = p.channelData;
  if (cd && typeof cd === 'object' && !Array.isArray(cd)) {
    const execApproval = (cd as Record<string, unknown>).execApproval;
    if (execApproval && typeof execApproval === 'object' && !Array.isArray(execApproval)) {
      return true;
    }
  }
  const text = typeof p.text === 'string' ? p.text : '';
  return /(?:Plugin|Exec) approval (?:required|allowed|denied|expired)/i.test(text);
}

/** 审批 ChannelPlugin stub — 空壳实现（实际审批由 features/approval-handler 处理） */
export const approvalStubs = {
  execApprovals: {
    getInitiatingSurfaceState: () => ({ kind: 'enabled' as const }),
    shouldSuppressForwardingFallback: () => true,
    shouldSuppressLocalPrompt: ({ payload }: { payload: unknown }) => isApprovalPayload(payload),
    buildPendingPayload: () => null,
    buildResolvedPayload: () => null,
  },
  approvals: {
    delivery: {
      hasConfiguredDmRoute: () => true,
      shouldSuppressForwardingFallback: () => true,
    },
    render: {
      exec: { buildPendingPayload: () => null, buildResolvedPayload: () => null },
      plugin: { buildPendingPayload: () => null, buildResolvedPayload: () => null },
    },
  },
} as const;
