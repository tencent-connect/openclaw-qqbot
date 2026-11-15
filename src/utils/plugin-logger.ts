/**
 * PluginLogger — 统一日志接口
 *
 * 默认后端为 OpenClaw 框架 logger（`runtime.logging.getChildLogger`），
 * 运行时不可用时临时降级 console，就绪后自动切换缓存。
 */

import { getRequestContext } from "../request-context.js";
import { tryGetQQBotRuntime } from "../runtime.js";

export interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  child(tag: string): PluginLogger;
}

export interface PluginLoggerOpts {
  prefix?: string;
  output?: Pick<PluginLogger, 'info' | 'warn' | 'error' | 'debug'>;
  /** 强制 console 输出，忽略 runtime.logging（register 阶段使用） */
  forceConsole?: boolean;
}

// ─── Console fallback ───────────────────────────────────────────────────────

function consoleSink(): Pick<PluginLogger, 'info' | 'warn' | 'error' | 'debug'> {
  const C = '\x1b[36m', Y = '\x1b[33m', R = '\x1b[31m', G = '\x1b[90m', X = '\x1b[0m';
  return {
    debug: (m) => console.debug(`${G}[qqbot]${X}`, m),
    info: (m) => console.log(`${C}[qqbot]${X}`, m),
    warn: (m) => console.warn(`${Y}[qqbot]${X}`, m),
    error: (m) => console.error(`${R}[qqbot]${X}`, m),
  };
}

// ─── Trace metadata ─────────────────────────────────────────────────────────

function enrichMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  const ctx = getRequestContext();
  if (!ctx) return meta;
  const trace: Record<string, unknown> = {};
  if (ctx.accountId) trace.accountId = ctx.accountId;
  if (ctx.messageId) trace.messageId = ctx.messageId;
  if (ctx.openId) trace.openId = ctx.openId;
  if (Object.keys(trace).length === 0) return meta;
  return meta ? { ...trace, ...meta } : trace;
}

// ─── Framework bridge ───────────────────────────────────────────────────────

type Sink = Pick<PluginLogger, 'info' | 'warn' | 'error' | 'debug'>;

function frameworkSink(): Sink {
  // 不缓存——register() 阶段 getChildLogger 可行但输出未接好。
  // 每次使用时重新 resolve，gateway 启动后自然拿到正确 logger。
  const resolve = (): Sink => {
    try {
      const r = tryGetQQBotRuntime();
      if (r?.logging) {
        const child = r.logging.getChildLogger({ subsystem: 'qqbot/core' }) as any;
        return {
          debug: child.debug?.bind(child),
          info: child.info.bind(child),
          warn: child.warn.bind(child),
          error: child.error.bind(child),
        };
      }
    } catch {}
    return consoleSink();
  };

  return {
    debug: (msg, meta) => resolve().debug?.(msg, meta),
    info: (msg, meta) => resolve().info(msg, meta),
    warn: (msg, meta) => resolve().warn(msg, meta),
    error: (msg, meta) => resolve().error(msg, meta),
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createPluginLogger(opts: PluginLoggerOpts = {}): PluginLogger {
  const output = opts.output ?? (opts.forceConsole ? consoleSink() : frameworkSink());
  const prefix = opts.prefix ?? '';

  const fmt = (msg: string): string =>
    prefix ? `${prefix} ${msg}` : msg;

  const buildChild = (parentPrefix: string, tag: string): PluginLogger =>
    createPluginLogger({
      output,
      prefix: parentPrefix ? `${parentPrefix}[${tag}]` : `[${tag}]`,
    });

  return {
    info: (msg, meta) => output.info(fmt(msg), enrichMeta(meta)),
    warn: (msg, meta) => output.warn(fmt(msg), enrichMeta(meta)),
    error: (msg, meta) => output.error(fmt(msg), enrichMeta(meta)),
    debug: (msg, meta) => output.debug(fmt(msg), enrichMeta(meta)),
    child: (tag: string) => buildChild(prefix, tag),
  };
}
