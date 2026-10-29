/**
 * Gateway Runtime 动态加载（兼容旧版框架）
 *
 * openclaw < 3.22 上 gateway-runtime.js 不存在，此函数返回 null。
 * 审批功能降级为不可用，不影响消息收发等核心能力。
 */
import { createRequire } from 'node:module';
import path from 'node:path';

export interface ApprovalGatewayClient {
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
  request: (method: string, params: unknown) => Promise<unknown>;
}

type ApprovalGatewayRuntime = {
  createOperatorApprovalsGatewayClient: (...args: any[]) => Promise<ApprovalGatewayClient>;
};

/** Accept only modules that actually export the approvals factory (stale ESM builds often don't). */
export function asApprovalGatewayRuntime(mod: unknown): ApprovalGatewayRuntime | null {
  if (!mod || typeof mod !== "object") return null;
  const record = mod as Record<string, unknown>;
  const nested = record.default;
  const candidates = [record, nested && typeof nested === "object" ? (nested as Record<string, unknown>) : null];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate.createOperatorApprovalsGatewayClient === "function") {
      return candidate as ApprovalGatewayRuntime;
    }
  }
  return null;
}

/** 动态加载 gateway-runtime 模块，旧版框架或缺少 factory 时返回 null */
export function loadApprovalGatewayRuntime(): ApprovalGatewayRuntime | null {
  const req = createRequire(__filename);
  const pluginRoot = path.resolve(path.dirname(__filename), '..', '..');
  const fs = req('node:fs') as typeof import('node:fs');

  const tryLoadFromRoot = (root: string) => {
    for (const rel of ['dist/plugin-sdk/gateway-runtime.js', 'plugin-sdk/gateway-runtime.js']) {
      const p = path.join(root, rel);
      try {
        if (fs.existsSync(p)) {
          const runtime = asApprovalGatewayRuntime(req(p));
          if (runtime) return runtime;
        }
      } catch { /* try next */ }
    }
    return null;
  };

  try {
    const { findOpenclawRoot } = req(path.join(pluginRoot, 'scripts', 'link-sdk-core.cjs')) as {
      findOpenclawRoot: (root: string) => string | null;
    };
    const root = findOpenclawRoot(pluginRoot);
    if (root) {
      const mod = tryLoadFromRoot(root);
      if (mod) return mod;
    }
  } catch { /* fallback */ }

  try {
    const entry = process.argv[1];
    if (entry) {
      const realEntry = fs.realpathSync(entry);
      let dir = path.dirname(realEntry);
      for (let i = 0; i < 6; i++) {
        const mod = tryLoadFromRoot(dir);
        if (mod) return mod;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch { /* fallback */ }

  return null;
}
