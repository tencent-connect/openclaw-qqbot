/**
 * Pairing Runtime 动态加载（兼容旧版框架）
 *
 * 从 OpenClaw 安装目录动态加载 conversation-runtime 模块中的配对函数。
 * 不支持时返回 null，配对功能降级为不可用。
 */
import { createRequire } from 'node:module';
import path from 'node:path';

export interface PairingApi {
  readAllowFromStore: (params: { channel: string; accountId: string }) => Promise<string[]>;
  issueChallenge: (params: { channel: string; id: string; accountId: string }) => Promise<{ code: string }>;
  buildReply: (params: { code: string; channel: string }) => string;
  approveCode: (params: { channel: string; code: string; accountId?: string }) => Promise<{ id: string } | null>;
}

let _api: PairingApi | null | undefined;

/** 获取 Pairing API，首次调用触发加载并缓存 */
export function getPairingApi(): PairingApi | null {
  if (_api !== undefined) return _api;
  _api = loadPairingApi();
  return _api;
}

function loadPairingApi(): PairingApi | null {
  const currentFile = __filename;
  const req = createRequire(currentFile);
  const pluginRoot = path.resolve(path.dirname(currentFile), '..', '..');
  const fs = req('node:fs') as typeof import('node:fs');

  const tryLoad = (root: string) => {
    for (const rel of ['dist/plugin-sdk/conversation-runtime.js', 'plugin-sdk/conversation-runtime.js']) {
      const p = path.join(root, rel);
      try {
        if (fs.existsSync(p)) return req(p);
      } catch { /* try next */ }
    }
    return null;
  };

  let mod: any = null;
  try {
    const { findOpenclawRoot } = req(path.join(pluginRoot, 'scripts', 'link-sdk-core.cjs')) as {
      findOpenclawRoot: (root: string) => string | null;
    };
    const root = findOpenclawRoot(pluginRoot);
    if (root) mod = tryLoad(root);
  } catch { /* fallback */ }

  if (!mod) {
    try {
      const entry = process.argv[1];
      if (entry) {
        const realEntry = fs.realpathSync(entry);
        let dir = path.dirname(realEntry);
        for (let i = 0; i < 6; i++) {
          mod = tryLoad(dir);
          if (mod) break;
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
    } catch { /* fallback */ }
  }

  if (!mod?.readChannelAllowFromStore) return null;

  return {
    // readChannelAllowFromStore(channel, env?, accountId?) — 位置参数
    readAllowFromStore: (params) =>
      mod.readChannelAllowFromStore(params.channel, undefined, params.accountId),

    // upsertChannelPairingRequest({ channel, id, accountId }) — 对象参数
    issueChallenge: (params) =>
      mod.upsertChannelPairingRequest({
        channel: params.channel,
        id: params.id,
        accountId: params.accountId,
      }).then((r: any) => ({ code: r.code as string })),

    // buildPairingReply({ channel, idLine, code }) — 对象参数
    buildReply: (params) =>
      mod.buildPairingReply({
        channel: params.channel,
        idLine: '', // qqbot 无额外 ID 信息，留空即可
        code: params.code,
      }),

    // approveChannelPairingCode({ channel, code, accountId? }) — 对象参数
    approveCode: (params) =>
      mod.approveChannelPairingCode({
        channel: params.channel,
        code: params.code,
        accountId: params.accountId,
      }),
  };
}
