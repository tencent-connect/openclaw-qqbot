/**
 * Agent workspace 目录解析（动态加载 plugin-sdk/health）
 *
 * 新版本 openclaw 有 openclaw/plugin-sdk/health 导出，
 * 旧版本不可用时 fallback 到 QQ Bot media 目录。
 */
import { createRequire } from 'node:module';
import { getQQBotMediaDir } from '../utils/platform.js';

const req = createRequire(__filename);

let health: {
  resolveAgentWorkspaceDir: (cfg: any, agentId: string) => string;
  resolveDefaultAgentId: (cfg: any) => string;
} | null = null;

export function resolveAgentWorkspace(cfg: any, agentId?: string): string {
  if (!health) {
    try {
      health = req('openclaw/plugin-sdk/health') as typeof health;
    } catch {
      health = null;
    }
  }
  if (health) {
    return health.resolveAgentWorkspaceDir(cfg, agentId ?? health.resolveDefaultAgentId(cfg));
  }
  return getQQBotMediaDir();
}
