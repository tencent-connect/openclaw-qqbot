/**
 * Runtime Adapters — 一次 resolve，全程复用。
 *
 * Capability Probe 模式：按候选 API 路径探测，选出第一个可用函数。
 * 对每个 runtime API 维护一个"候选列表"（最新在前），未来 API 改名时只需 +1 行。
 *
 * 调用方通过 `resolveRuntimeAdapters(runtime)` 获取适配层对象，
 * 后续所有 dispatch / channel 代码只使用 adapters 上的方法。
 */

import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { PluginLogger } from '../utils/plugin-logger.js';

// ── 类型 ──

export interface RuntimeAdapters {
  /** 入站事件处理（自动适配 inbound.run / turn.run） */
  inboundRun: ((params: any) => Promise<any>) | null;
  /** 回复分发（带 block buffer） */
  dispatchReply: ((params: any) => Promise<any>) | null;
  /** Agent 路由解析 */
  resolveAgentRoute: ((params: any) => any) | null;
  /** 构建入站上下文（自动适配 inbound.buildContext / reply.finalizeInboundContext） */
  buildInboundContext: ((params: any) => any) | null;
  /** Session store path 解析 */
  resolveStorePath: ((storeConfig: any, opts: any) => string) | null;
  /** Session 记录 */
  recordInboundSession: ((params: any) => Promise<void>) | null;
  /** 格式化 envelope（自动适配 formatAgentEnvelope / formatInboundEnvelope） */
  formatEnvelope: ((params: any) => string) | null;
  /** 解析 envelope format options */
  resolveEnvelopeFormatOptions: ((cfg: any) => any) | null;
  /** Markdown 文本分块 */
  chunkMarkdownText: ((text: string, limit: number) => string[]) | null;
  /** 远程媒体保存（图片/语音下载） */
  saveRemoteMedia: ((opts: { url: string; subdir?: string; originalFilename?: string }) => Promise<{ path: string } | null>) | null;
  /** 获取当前配置快照 */
  getConfig: (() => any) | null;
  /**
   * 持久化配置变更（高低版本兼容）。
   *
   * 内部优先级：
   *   1. mutateConfigFile（新版 API，原子操作，支持 afterWrite 策略）
   *   2. writeConfigFile（旧版 API，整体覆盖）
   *
   * 调用方只需传入完整 config 对象，不必关心框架版本差异。
   */
  /**
   * 持久化配置变更（高低版本兼容）。
   *
   * 接受一个 mutator 回调，接收当前 config 对象（可变），
   * 可直接修改或返回新对象。适配器负责确保写入和热重载。
   */
  persistConfig: ((mutator: (cfg: any) => any) => Promise<void>) | null;
  /** openclaw 版本 */
  version: string;
}

// ── Probe 辅助 ──

type ProbePath = string[];

/**
 * 从 runtime 对象沿路径探测函数。返回 bound function 或 null。
 */
function probeFunction(rt: any, paths: ProbePath[]): ((...args: any[]) => any) | null {
  for (const path of paths) {
    let target = rt;
    let parent = rt;
    for (let i = 0; i < path.length; i++) {
      parent = target;
      target = target?.[path[i]];
      if (target === undefined || target === null) break;
    }
    if (typeof target === 'function') {
      // bind 到 parent（倒数第二层），确保 this 上下文正确
      return target.bind(parent);
    }
  }
  return null;
}

/**
 * 从 runtime 对象沿路径探测值（非函数也可）。返回值或 null。
 */
function probeValue(rt: any, paths: ProbePath[]): any {
  for (const path of paths) {
    let target = rt;
    for (const key of path) {
      target = target?.[key];
      if (target === undefined || target === null) break;
    }
    if (target !== undefined && target !== null) return target;
  }
  return null;
}

// ── 主入口 ──

/**
 * 一次性 resolve 所有 runtime adapter。
 *
 * 通常在 gateway ready 后（首条消息到来前）调用一次，结果缓存复用。
 * 返回 null 的字段表示该能力不可用，调用方按需降级或走 fallback。
 */
export function resolveRuntimeAdapters(
  rt: PluginRuntime,
  log?: PluginLogger,
): RuntimeAdapters {
  const version = (rt as any).version ?? 'unknown';

  const inboundRun = probeFunction(rt, [
    ['channel', 'inbound', 'run'],      // current (2026-05+)
    ['channel', 'turn', 'run'],          // legacy (removed 2026-05-27)
  ]);

  const dispatchReply = probeFunction(rt, [
    ['channel', 'reply', 'dispatchReplyWithBufferedBlockDispatcher'],
  ]);

  const resolveAgentRoute = probeFunction(rt, [
    ['channel', 'routing', 'resolveAgentRoute'],
  ]);

  // 构建入站上下文：新 API 优先，低版本 fallback 到 deprecated finalizeInboundContext
  // 两个 API 签名不同，通过 wrapper 统一为 buildInboundContext(params) 接口
  const rawBuildContext = probeFunction(rt, [
    ['channel', 'inbound', 'buildContext'],
  ]);
  const rawFinalizeContext = !rawBuildContext
    ? probeFunction(rt, [['channel', 'reply', 'finalizeInboundContext']])
    : null;

  const buildInboundContext: RuntimeAdapters['buildInboundContext'] = rawBuildContext
    ? (params) => rawBuildContext(params)
    : rawFinalizeContext
      ? (params) => {
          // 将统一参数转换为旧 API 的 rawCtxPayload 格式
          const isCommand = params.access?.commands?.authorized ?? false;
          const rawCtx = {
            Body: params.message.body,
            BodyForAgent: params.message.bodyForAgent,
            RawBody: params.message.rawBody,
            CommandBody: params.message.commandBody ?? params.message.rawBody,
            CommandSource: isCommand ? 'text' : undefined,
            CommandTurn: params.command ?? undefined,
            CommandAuthorized: isCommand,
            From: params.from,
            To: params.reply.to,
            SessionKey: params.route.routeSessionKey,
            AccountId: params.route.accountId ?? params.accountId,
            ChatType: params.conversation.kind,
            GroupSystemPrompt: params.conversation.label,
            SenderId: params.sender.id,
            SenderName: params.sender.name,
            Provider: params.provider ?? params.channel,
            Surface: params.surface ?? params.channel,
            MessageSid: params.messageId,
            Timestamp: params.timestamp ?? Date.now(),
            OriginatingChannel: params.channel,
            OriginatingTo: params.reply.originatingTo ?? params.reply.to,
            ...params.extra,
          };
          return rawFinalizeContext(rawCtx);
        }
      : null;

  const resolveStorePath = probeFunction(rt, [
    ['channel', 'session', 'resolveStorePath'],
  ]);

  const recordInboundSession = probeFunction(rt, [
    ['channel', 'session', 'recordInboundSession'],
  ]);

  // 格式化 envelope：新 API 优先，低版本 fallback 到 deprecated formatInboundEnvelope
  const formatEnvelope = probeFunction(rt, [
    ['channel', 'reply', 'formatAgentEnvelope'],    // current (2026-06+)
    ['channel', 'reply', 'formatInboundEnvelope'],  // deprecated，低版本兼容
  ]);

  const resolveEnvelopeFormatOptions = probeFunction(rt, [
    ['channel', 'reply', 'resolveEnvelopeFormatOptions'],
  ]);

  const chunkMarkdownText = probeFunction(rt, [
    ['channel', 'text', 'chunkMarkdownText'],
  ]);

  const saveRemoteMedia = probeFunction(rt, [
    ['channel', 'media', 'saveRemoteMedia'],
  ]);

  const getConfig = probeFunction(rt, [
    ['config', 'current'],
  ]) ?? probeFunction(rt, [
    ['getConfig'],
  ]) ?? probeFunction(rt, [
    ['config', 'loadConfig'],
  ]);

  // config 持久化：优先 mutateConfigFile（新版，原子操作），fallback writeConfigFile（旧版）
  const rawMutateConfig = probeFunction(rt, [['config', 'mutateConfigFile']]);
  const rawWriteConfig = probeFunction(rt, [['config', 'writeConfigFile']]);

  const persistConfig: RuntimeAdapters['persistConfig'] = rawMutateConfig
    ? async (mutator: (cfg: any) => any) => {
        // 新版 API：mutate 回调接收当前 config，可直接修改或返回新对象
        await rawMutateConfig({
          afterWrite: 'hot-reload',
          mutate: mutator,
        });
      }
    : rawWriteConfig && getConfig
      ? async (mutator: (cfg: any) => any) => {
          // 旧版 API：先读取当前 config → 应用 mutator → 整体写入
          const current = JSON.parse(JSON.stringify(getConfig()));
          mutator(current);
          await rawWriteConfig(current);
        }
      : null;

  // 日志汇总
  const resolved = [
    inboundRun && 'inboundRun',
    dispatchReply && 'dispatchReply',
    resolveAgentRoute && 'resolveAgentRoute',
    buildInboundContext && 'buildInboundContext',
    resolveStorePath && 'resolveStorePath',
    recordInboundSession && 'recordInboundSession',
    formatEnvelope && 'formatEnvelope',
    chunkMarkdownText && 'chunkMarkdownText',
    saveRemoteMedia && 'saveRemoteMedia',
    getConfig && 'getConfig',
    persistConfig && `persistConfig(${rawMutateConfig ? 'mutate' : 'write'})`,
  ].filter(Boolean);

  log?.info(
    `[qqbot:adapter] openclaw=${version} resolved ${resolved.length} adapters: ${resolved.join(', ')}`,
  );

  return {
    inboundRun,
    dispatchReply,
    resolveAgentRoute,
    buildInboundContext,
    resolveStorePath,
    recordInboundSession,
    formatEnvelope,
    resolveEnvelopeFormatOptions,
    chunkMarkdownText,
    saveRemoteMedia,
    getConfig,
    persistConfig,
    version,
  };
}

// ── 全局缓存（所有消费者共享同一份 adapters） ──

let _cachedAdapters: RuntimeAdapters | null = null;
let _cachedRuntimeRef: WeakRef<PluginRuntime> | null = null;

/**
 * 获取 RuntimeAdapters 的全局缓存版本。
 *
 * - 自动基于 runtime 实例的 WeakRef 判断是否需要重新 resolve
 * - 如果 runtime 被替换（框架热更新、二次 register），自动刷新
 * - 所有消费者（dispatch / channel / middleware）共用一份，避免重复 probe
 *
 * @param rt 当前 PluginRuntime 实例
 * @param log 可选日志（仅在首次 resolve 或 runtime 变更时输出）
 */
export function getAdapters(
  rt: PluginRuntime,
  log?: PluginLogger,
): RuntimeAdapters {
  const cached = _cachedRuntimeRef?.deref();
  if (cached === rt && _cachedAdapters) {
    return _cachedAdapters;
  }
  // runtime 引用变化（首次 / 热更新）→ 重新 resolve
  _cachedAdapters = resolveRuntimeAdapters(rt, log);
  _cachedRuntimeRef = new WeakRef(rt);
  return _cachedAdapters;
}

/**
 * 持久化配置（auth.login 场景，兼容高低版本）。
 *
 * 探测顺序：
 *   1. config.mutateConfigFile  — 新版原子操作
 *   2. config.writeConfigFile   — 旧版整体覆盖
 *   3. writeConfigFile          — 更旧的顶层 API
 */
export async function persistAuthConfig(
  runtime: Record<string, unknown>,
  cfg: Record<string, unknown>,
  afterWrite = 'restart',
): Promise<void> {
  const config: Record<string, unknown> | undefined = runtime.config as any;

  if (typeof config?.mutateConfigFile === 'function') {
    await (config.mutateConfigFile as Function)({
      mutate: () => cfg,
      afterWrite,
    });
    return;
  }
  if (typeof config?.writeConfigFile === 'function') {
    await (config.writeConfigFile as Function)(cfg);
    return;
  }
  if (typeof runtime.writeConfigFile === 'function') {
    await (runtime.writeConfigFile as Function)(cfg);
    return;
  }

  // 最后兜底：裸写文件
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(homedir(), '.openclaw', 'openclaw.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

/**
 * 强制清除 adapter 缓存（仅测试用）
 */
export function _resetAdaptersCache(): void {
  _cachedAdapters = null;
  _cachedRuntimeRef = null;
}

