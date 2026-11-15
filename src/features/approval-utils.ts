/**
 * 审批相关工具函数
 *
 * 审批 payload 判断逻辑，供 channel.ts 和 features/approval-handler 使用。
 */

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
