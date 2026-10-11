/**
 * 审批相关工具函数
 *
 * 审批 payload 判断逻辑，供 channel.ts 和 features/approval-handler 使用。
 */

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';
export type ApprovalKind = 'exec' | 'plugin';

export interface ParsedApprovalButtonData {
  approvalId: string;
  approvalKind: ApprovalKind;
  decision: ApprovalDecision;
}

/** 构造可安全容纳 `plugin:<uuid>` 等带分隔符 ID 的回调数据。 */
export function buildApprovalButtonData(
  approvalId: string,
  decision: ApprovalDecision,
): string {
  const approvalKind: ApprovalKind = approvalId.startsWith('plugin:') ? 'plugin' : 'exec';
  return `approve:v2:${approvalKind}:${encodeURIComponent(approvalId)}:${decision}`;
}

/** 严格解析审批按钮回调，拒绝未知版本、类型和 decision。 */
export function parseApprovalButtonData(buttonData: string): ParsedApprovalButtonData | null {
  const match = buttonData.match(
    /^approve:v2:(exec|plugin):([^:]+):(allow-once|allow-always|deny)$/,
  );
  if (!match) return null;

  const approvalKind = match[1] as ApprovalKind;
  const decision = match[3] as ApprovalDecision;
  let approvalId: string;
  try {
    approvalId = decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
  if (!approvalId) return null;
  if ((approvalId.startsWith('plugin:') ? 'plugin' : 'exec') !== approvalKind) return null;

  return { approvalId, approvalKind, decision };
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
