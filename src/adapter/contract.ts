/**
 * Runtime Contract Check — 启动时校验必需 API 可用性。
 *
 * 在 plugin.register() 中立刻调用，console 直接输出（register 阶段
 * runtime.logging 的 getChildLogger 存在但输出管道未接通）。
 */

import type { PluginRuntime } from 'openclaw/plugin-sdk';
import { createPluginLogger } from '../utils/plugin-logger.js';

const log = createPluginLogger({ prefix: '[contract]', forceConsole: false });

interface ApiProbe {
  name: string;
  probe: (rt: PluginRuntime) => boolean;
}

const REQUIRED: ApiProbe[] = [];

const OPTIONAL: ApiProbe[] = [
  {
    name: 'channel.reply.dispatchReplyWithBufferedBlockDispatcher',
    probe: (rt) => typeof (rt as any).channel?.reply?.dispatchReplyWithBufferedBlockDispatcher === 'function',
  },
  { name: 'channel.inbound.run (degraded)', probe: (rt) => {
    const c = (rt as any).channel;
    return typeof c?.inbound?.run === 'function' || typeof c?.turn?.run === 'function';
  }},
  { name: 'channel.inbound.buildContext', probe: (rt) => typeof (rt as any).channel?.inbound?.buildContext === 'function' },
  { name: 'channel.reply.formatAgentEnvelope', probe: (rt) => typeof (rt as any).channel?.reply?.formatAgentEnvelope === 'function' },
  { name: 'channel.text.chunkMarkdownText', probe: (rt) => typeof (rt as any).channel?.text?.chunkMarkdownText === 'function' },
  { name: 'channel.routing.resolveAgentRoute', probe: (rt) => typeof (rt as any).channel?.routing?.resolveAgentRoute === 'function' },
  { name: 'channel.session.resolveStorePath (deprecated)', probe: (rt) => typeof (rt as any).channel?.session?.resolveStorePath === 'function' },
  { name: 'channel.session.recordInboundSession (deprecated)', probe: (rt) => typeof (rt as any).channel?.session?.recordInboundSession === 'function' },
  { name: 'channel.reply.finalizeInboundContext (deprecated)', probe: (rt) => typeof (rt as any).channel?.reply?.finalizeInboundContext === 'function' },
  { name: 'channel.reply.formatInboundEnvelope (deprecated)', probe: (rt) => typeof (rt as any).channel?.reply?.formatInboundEnvelope === 'function' },
  { name: 'config.current', probe: (rt) => typeof (rt as any).config?.current === 'function' },
];

export interface ContractResult {
  ok: boolean;
  version: string;
  missing: string[];
  degraded: string[];
}

export function verifyRuntimeContract(rt: PluginRuntime): ContractResult {
  const version = (rt as any).version ?? 'unknown';
  const missing: string[] = [];
  const degraded: string[] = [];

  for (const r of REQUIRED) {
    if (!r.probe(rt)) missing.push(r.name);
  }
  for (const r of OPTIONAL) {
    if (!r.probe(rt)) degraded.push(r.name);
  }

  log.debug(`openclaw=${version} required=${REQUIRED.length - missing.length}/${REQUIRED.length} degraded=${degraded.length}/${OPTIONAL.length}`);
  if (missing.length) {
    log.error(`BROKEN — missing: ${missing.join(', ')}`);
  }
  if (degraded.length) {
    log.debug(`degraded: ${degraded.join(', ')}`);
  }

  return { ok: missing.length === 0, version, missing, degraded };
}
