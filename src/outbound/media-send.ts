/**
 * 统一富媒体发送入口
 *
 * 职责：
 *   1. 路径安全校验（只允许白名单目录下的本地文件）
 *   2. 类型推断（扩展名 / MIME / 显式指定）
 *   3. 路由分发（image / voice / video / file）
 *   4. 语音发送失败 fallback 到文件
 *
 * 所有出站媒体发送（channel.outbound.sendMedia / deliver pipeline / Message 工具）
 * 统一经过此入口。
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolveAgentWorkspace } from '../adapter/workspace.js';
import type { ReplyTarget } from '@tencent-connect/qqbot-nodejs';
import type { QQBotGateway } from '../gateway/index.js';
import { tryGetQQBotRuntime } from '../runtime.js';
import { getAdapters } from '../adapter/resolve.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { validateRemoteUrl } from '../utils/ssrf-guard.js';
import { getGateway } from './outbound-service.js';
import { parseTarget } from './target.js';
import {
  isLocalFilePath,
  isDataUrl,
  normalizePath,
  inferMediaKind,
  inferMediaKindFromMime,
  isPathInAllowedRoots,
} from './local-file-router.js';
import type { MediaKind } from './outbound-service.js';

// ── 类型 ──

export interface SendMediaParams {
  /** 目标 (qqbot:c2c:xxx / qqbot:group:xxx) */
  to: string;
  /** 媒体源（URL / 本地路径 / data URL） */
  source: string;
  /** 附带文本 */
  text?: string;
  /** 显式指定类型（优先级最高） */
  mediaKind?: MediaKind;
  /** MIME type 提示（优先级次于 mediaKind） */
  mimeType?: string;
  /** 被动回复 ID */
  replyToId?: string;
  /** 账户 ID */
  accountId: string;
  /** 日志 */
  log?: PluginLogger;
  /** Agent ID（用于解析相对路径的工作区） */
  agentId?: string;
}

export interface SendMediaResult {
  messageId?: string;
  error?: string;
  /** 是否走了 fallback 路径 */
  fallback?: boolean;
}

// ── 安全常量 ──

/** 收集临时目录根路径：os.tmpdir + Unix /tmp（处理 macOS /tmp→/private/tmp 符号链接） */
function resolveTempRoots(): string[] {
  const roots = new Set<string>();
  try {
    const tmp = os.tmpdir();
    roots.add(fs.existsSync(tmp) ? fs.realpathSync(tmp) : tmp);
  } catch { /* skip */ }
  // Unix: 解析 /tmp 真实路径，覆盖 macOS 符号链接场景
  if (process.platform !== 'win32') {
    try { roots.add(fs.realpathSync('/tmp')); } catch { /* skip */ }
  }
  return [...roots];
}

/**
 * 构建动态白名单目录列表。
 *
 * 从 openclaw 核心已解析的 workspaceDir 反向推导配置目录，
 * 同时保留已知配置目录名以向后兼容。
 */
function buildDynamicAllowedRoots(workspaceDir?: string): string[] {
  const home = os.homedir();
  const derivedBase = workspaceDir ? path.dirname(workspaceDir) : path.join(home, '.openclaw');
  const roots: string[] = [];
  const added = new Set<string>();

  const addRoot = (p: string) => {
    try {
      const real = fs.existsSync(p) ? fs.realpathSync(p) : p;
      if (!added.has(real)) {
        added.add(real);
        roots.push(real);
      }
    } catch { /* skip */ }
  };

  // 已知配置目录名（包括默认和开发模式）
  const knownBases = [path.join(home, '.openclaw'), path.join(home, '.openclaw-dev')];

  // 当前配置目录优先（从 workspaceDir 反推）
  if (workspaceDir) {
    addRoot(path.join(derivedBase, 'media'));
    addRoot(path.join(derivedBase, 'workspace'));
    addRoot(path.join(derivedBase, 'outbound'));
    addRoot(workspaceDir);
  }

  // 所有已知配置目录（去重，确保向后兼容）
  for (const base of knownBases) {
    addRoot(path.join(base, 'media'));
    addRoot(path.join(base, 'workspace'));
    addRoot(path.join(base, 'outbound'));
  }

  // 临时目录
  for (const t of resolveTempRoots()) addRoot(t);

  return roots;
}

/** 入站 Base64 / Data URL 最大字节数（10MB） */
const MAX_DATA_URL_BYTES = 10 * 1024 * 1024;

// ── 统一入口 ──

/**
 * 统一富媒体发送入口
 */
export async function sendMedia(params: SendMediaParams): Promise<SendMediaResult> {
  const { source, accountId, log } = params;
  const mlog = log?.child('media');

  if (!source) {
    mlog?.error('source is empty');
    return { error: 'sendMedia: source is required' };
  }

  // 1. 安全校验 + 路径规范化
  const wsDir = resolveWorkspaceFromAgent(params.agentId);
  mlog?.debug(`resolveMediaPath source=${source} agentId=${params.agentId ?? 'none'} workspaceDir=${wsDir ?? 'none'}`);
  const resolved = await resolveMediaPath(source, mlog, wsDir);
  if (!resolved.ok) {
    mlog?.error(`resolveMediaPath failed: ${resolved.error}`);
    return { error: resolved.error };
  }

  // 2. 推断类型
  const kind = params.mediaKind
    ?? (params.mimeType ? inferMediaKindFromMime(params.mimeType) : undefined)
    ?? inferMediaKind(resolved.path);

  // 3. 获取 gateway
  const gw = getGateway(accountId);
  if (!gw) {
    return { error: `Bot "${accountId}" not running` };
  }

  const target = parseTarget(params.to);

  // 4. 路由分发
  switch (kind) {
    case 'voice':
      return sendVoiceMedia(gw, target, resolved.path, params);
    case 'video':
      return sendVideoMedia(gw, target, resolved.path, params);
    case 'file':
      return sendFileMedia(gw, target, resolved.path, params);
    case 'image':
    default:
      return sendImageMedia(gw, target, resolved.path, params);
  }
}

// ── 路径安全校验 ──

interface ResolveResult {
  ok: true;
  path: string;
  isLocal: boolean;
}

interface ResolveError {
  ok: false;
  error: string;
}

async function resolveMediaPath(source: string, log?: SendMediaParams['log'], workspaceDir?: string): Promise<ResolveResult | ResolveError> {
  const normalized = normalizePath(source);

  // Data URL → 大小限制检查
  if (isDataUrl(normalized)) {
    if (normalized.length > MAX_DATA_URL_BYTES) {
      const sizeMB = (normalized.length / (1024 * 1024)).toFixed(1);
      return { ok: false, error: `Data URL 过大（${sizeMB}MB，最大 10MB）` };
    }
    return { ok: true, path: normalized, isLocal: false };
  }

  // 远程 URL → SSRF 安全检查
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    try {
      await validateRemoteUrl(normalized);
    } catch (err) {
      log?.warn(`SSRF blocked for media URL: ${normalized}`);
      return { ok: false, error: `媒体 URL 被 SSRF 防护拦截: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, path: normalized, isLocal: false };
  }

  // 纯文件名→工作区兜底查找
  if (!isLocalFilePath(normalized)) {
    const resolved = resolveWorkingFile(normalized, workspaceDir);
    if (resolved) {
      return { ok: true, path: resolved, isLocal: true };
    }
    return { ok: true, path: normalized, isLocal: false };
  }

  // 本地路径 → 安全校验
  const resolved = path.resolve(normalized);
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `File not found: ${resolved}` };
  }

  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return { ok: false, error: `Cannot resolve path: ${resolved}` };
  }

  // 动态白名单：静态根目录 + 当前 agent 工作区
  const dynamicRoots = buildDynamicAllowedRoots(workspaceDir);
  const allowed = isPathInAllowedRoots(real, dynamicRoots);

  if (!allowed) {
    log?.warn(`path blocked — not in allowed directory: ${real}`);
    return { ok: false, error: `文件路径不在允许的目录中` };
  }

  return { ok: true, path: real, isLocal: true };
}

/** Agent ID → workspaceDir（动态加载 plugin-sdk/health） */
function resolveWorkspaceFromAgent(agentId?: string): string | undefined {
  const cfg = resolveConfigViaAdapter();
  if (!cfg) return undefined;
  return resolveAgentWorkspace(cfg, agentId);
}

/** 通过 adapter 获取配置 */
function resolveConfigViaAdapter(): Record<string, unknown> | undefined {
  try {
    const rt = tryGetQQBotRuntime();
    if (!rt) return undefined;
    return getAdapters(rt).getConfig?.();
  } catch { return undefined; }
}

/** 纯文件名在 cwd + 工作区兜底查找 */
function resolveWorkingFile(name: string, workspaceDir?: string): string | null {
  for (const p of [path.resolve(name), workspaceDir ? path.join(workspaceDir, name) : null]) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// ── 各类型 sender ──

async function sendImageMedia(
  gw: QQBotGateway,
  target: ReplyTarget,
  source: string,
  params: SendMediaParams,
): Promise<SendMediaResult> {
  try {
    const result = await gw.sendMedia(target, source, {
      text: params.text,
      msgId: params.replyToId,
    });
    return { messageId: result.id };
  } catch (err) {
    return { error: formatErr(err) };
  }
}

async function sendVoiceMedia(
  gw: QQBotGateway,
  target: ReplyTarget,
  source: string,
  params: SendMediaParams,
): Promise<SendMediaResult> {
  // 语音源路由：本地 → { localPath }，URL → { url }，其他 → { base64 }
  const voiceSource = resolveVoiceSource(source);

  try {
    const result = await gw.sendVoice(target, voiceSource, {
      msgId: params.replyToId,
    });
    return { messageId: result.id };
  } catch (err) {
    // 语音失败 → fallback 到文件发送
    params.log?.child('media')?.warn(`sendVoice failed (${formatErr(err)}), falling back to sendFile`);
    try {
      const fileName = path.basename(source);
      const fallback = await gw.sendFile(target, source, {
        text: params.text,
        msgId: params.replyToId,
        fileName,
      });
      return { messageId: fallback.id, fallback: true };
    } catch (fallbackErr) {
      return { error: `voice: ${formatErr(err)} | fallback file: ${formatErr(fallbackErr)}` };
    }
  }
}

async function sendVideoMedia(
  gw: QQBotGateway,
  target: ReplyTarget,
  source: string,
  params: SendMediaParams,
): Promise<SendMediaResult> {
  try {
    const result = await gw.sendVideo(target, source, {
      text: params.text,
      msgId: params.replyToId,
    });
    return { messageId: result.id };
  } catch (err) {
    return { error: formatErr(err) };
  }
}

async function sendFileMedia(
  gw: QQBotGateway,
  target: ReplyTarget,
  source: string,
  params: SendMediaParams,
): Promise<SendMediaResult> {
  try {
    const fileName = path.basename(source);
    const result = await gw.sendFile(target, source, {
      text: params.text,
      msgId: params.replyToId,
      fileName,
    });
    return { messageId: result.id };
  } catch (err) {
    return { error: formatErr(err) };
  }
}

// ── 辅助 ──

function resolveVoiceSource(source: string): { url?: string; base64?: string; localPath?: string } {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return { url: source };
  }
  if (source.startsWith('data:') || (!source.startsWith('/') && !source.startsWith('./') && !source.startsWith('../') && !source.startsWith('~'))) {
    // data URL 或纯 base64 字符串
    const commaIdx = source.indexOf(',');
    return { base64: commaIdx > 0 ? source.slice(commaIdx + 1) : source };
  }
  return { localPath: source };
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
