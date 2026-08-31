/**
 * 按 QQ 传输能力订阅 replyOptions。
 *
 * 文本车道不变：
 *   static-blocks：文本只走 deliver(kind=block|final)
 *   native-stream：onPartialReply 写入 StreamingController，返回 true
 *
 * 其余 GetReplyOptions agent 事件一律订阅做日志监控，返回 false，
 * 不把工具名 / reasoning / plan 发到 QQ。
 * 不订 onNarrationUpdate：一挂核心就会开始生成旁白。
 * 不订 onBlockReply：文本走 dispatcher deliver，避免双发。
 *
 * 核心默认 verbose=off 时会丢掉工具类回调。要让监控真正收到
 * onToolStart / onToolResult / onItemEvent / onPlanUpdate 等，必须同时打开：
 *   allowToolLifecycleWhenProgressHidden
 *   suppressDefaultToolProgressMessages（也阻止默认工具进度进 deliver）
 *   forceToolResultProgress（verbose 关着时仍转发 onToolResult，且不再把工具文本投到 QQ）
 */
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { StreamingController } from '../outbound/streaming-controller.js';

type ProgressResult = boolean | void;

/** GetReplyOptions 里需要监控的 agent 事件（不含 onPartialReply / onNarrationUpdate / onBlockReply）。 */
export const QQBOT_MONITORED_AGENT_EVENTS = [
  'onAssistantMessageStart',
  'onToolStart',
  'onToolResult',
  'onBlockReplyQueued',
  'onReasoningStream',
  'onReasoningEnd',
  'onItemEvent',
  'onPlanUpdate',
  'onApprovalEvent',
  'onCommandOutput',
  'onPatchSummary',
  'onCompactionStart',
  'onCompactionEnd',
  'onModelSelected',
] as const;

export type QqbotMonitoredAgentEvent = (typeof QQBOT_MONITORED_AGENT_EVENTS)[number];

const EVENT_SUMMARY_KEYS = [
  'name',
  'phase',
  'status',
  'kind',
  'title',
  'toolCallId',
  'itemId',
  'provider',
  'model',
] as const;

export function createQqbotReplyOptions(params: {
  abortSignal?: AbortSignal;
  runId?: string;
  streamingController: StreamingController | null;
  log?: PluginLogger;
}): Record<string, unknown> {
  const { abortSignal, runId, streamingController, log } = params;
  const eventLog = log?.child('agent');
  return {
    abortSignal,
    runId,
    disableBlockStreaming: false,
    commentaryPayloadsEnabled: true,
    allowToolLifecycleWhenProgressHidden: true,
    suppressDefaultToolProgressMessages: true,
    forceToolResultProgress: true,
    ...createMonitoredAgentEventHandlers(eventLog),
    ...(streamingController
      ? {
          onPartialReply: async (payload: { text?: string }): Promise<ProgressResult> => {
            const text = payload.text ?? '';
            eventLog?.debug(`onPartialReply textLen=${text.length}`);
            if (!text) return false;
            await streamingController.onPartialReply(text);
            return true;
          },
        }
      : {
          onPartialReply: (payload: { text?: string }): false => {
            eventLog?.debug(`onPartialReply${summarizeAgentEvent(payload)}`);
            return false;
          },
        }),
  };
}

function createMonitoredAgentEventHandlers(
  log: PluginLogger | undefined,
): Record<QqbotMonitoredAgentEvent, (payload?: unknown) => ProgressResult> {
  const handlers = {} as Record<QqbotMonitoredAgentEvent, (payload?: unknown) => ProgressResult>;
  for (const name of QQBOT_MONITORED_AGENT_EVENTS) {
    handlers[name] = function monitorAgentEvent(payload?: unknown): false {
      log?.debug(`${name}${summarizeAgentEvent(payload)}`);
      return false;
    };
  }
  return handlers;
}

function summarizeAgentEvent(payload: unknown): string {
  if (payload == null || typeof payload !== 'object') {
    return '';
  }
  const rec = payload as Record<string, unknown>;
  const bits: string[] = [];
  for (const key of EVENT_SUMMARY_KEYS) {
    const value = rec[key];
    if (value == null || value === '') continue;
    bits.push(`${key}=${String(value)}`);
  }
  return bits.length > 0 ? ` ${bits.join(' ')}` : '';
}
