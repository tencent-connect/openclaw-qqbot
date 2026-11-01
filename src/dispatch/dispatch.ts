/**
 * 消息转发 — 入站消息 → OpenClaw AI
 *
 * 出站两条车道，同时只跑一条：
 *   native-stream  C2C 且开启 QQ 原生流式 → StreamingController 拥有文本
 *   static-blocks  其余情况 → 只有 deliver(kind=block|final) 发送文本
 */
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { buildEnvelope } from './envelope-builder.js';
import { assembleBody, type AssembledBody } from './body-assembler.js';
import { sendText, getGateway } from '../outbound/outbound-service.js';
import { sendMedia } from '../outbound/media-send.js';
import { deliverReply, type DeliverPayload, type DeliverInfo, type DeliverContext } from '../outbound/deliver-pipeline.js';
import { buildCtxPayload } from './ctx-builder.js';

import { DeliverDebouncer } from '../outbound/debounce.js';
import { StreamingController, shouldUseStreaming } from '../outbound/streaming-controller.js';
import { getAdapters } from '../adapter/resolve.js';
import { clearGroupHistory } from '../features/history-store.js';
import { createQqbotReplyOptions } from './reply-options.js';
import {
  deliverDispatchPayload,
  deliverDispatchPayloadSafe,
  type DispatchDeliverState,
} from './dispatch-deliver.js';

/**
 * 可重试的瞬时 dispatch 失败。
 *
 * - `DispatchSessionRefreshRequiredError`：同一 session 有并发启动时，核心在校验阶段发现
 *   会话已变（新 run 抢先建立），会要求调用方重试。
 * - `Model runtime replacement is in progress`：核心正在热替换模型运行时，短时间内拒绝
 *   已被插件接纳的工作项。
 *
 * 这两类都不是消息本身的问题，原样抛给用户只会得到一条“没跑成”的提示，所以这里做有限重试。
 */
const RETRYABLE_DISPATCH_ERROR = /DispatchSessionRefreshRequired|Model runtime replacement is in progress|admitted plugin work cannot wait/i;
const DISPATCH_RETRY_DELAYS_MS = [300, 1200];

function isRetryableDispatchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return RETRYABLE_DISPATCH_ERROR.test(`${err.name}: ${err.message}`);
}

async function withDispatchRetry<T>(
  label: string,
  run: () => Promise<T>,
  log?: PluginLogger,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      const delay = DISPATCH_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryableDispatchError(err)) throw err;
      log?.warn(
        `${label} transient dispatch failure, retry ${attempt + 1}/${DISPATCH_RETRY_DELAYS_MS.length} in ${delay}ms: ${(err as Error).message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * 将经过中间件处理的入站消息转发给 OpenClaw AI
 */
export async function dispatchToOpenClaw(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log?: PluginLogger,
): Promise<void> {
  const dlog = log?.child('dispatch');
  const adapters = getAdapters(runtime, dlog);
  const envelope = buildEnvelope(ctx, msg, account);

  dlog?.debug(`received sender=${envelope.senderId} scope=${envelope.chatScope} msgId=${envelope.messageId}`);

  if (!adapters.dispatchReply) {
    dlog?.error(`runtime adapter dispatchReply not available (openclaw=${adapters.version})`);
    return;
  }

  const assembled: AssembledBody =
    ((ctx.state as Record<string, unknown>).assembledBody as AssembledBody | undefined) ??
    assembleBody(ctx, msg, account);

  const cfg = adapters.getConfig?.() ?? {};

  const route = adapters.resolveAgentRoute?.({
    cfg,
    channel: 'qqbot',
    accountId: account.accountId,
    peer: {
      kind: envelope.chatScope === 'group' ? 'group' : 'direct',
      id: envelope.chatScope === 'group' ? (envelope.groupId ?? envelope.senderId) : envelope.senderId,
    },
  }) ?? { sessionKey: `qqbot:${account.accountId}:${envelope.senderId}`, accountId: account.accountId };

  const qualifiedTarget = envelope.targetId;
  const agentId = route.agentId ?? 'default';
  const storePath = adapters.resolveStorePath?.((cfg as any)?.session?.store, { agentId }) ?? '';

  const ctxPayload = buildCtxPayload({ assembled, envelope, route, msg, ctx, adapters });

  const ttsRuntime = (runtime as any)?.tts ?? (runtime as any)?.channel?.runtimeContexts?.get?.('tts');

  const debounceConfig = account.config?.deliverDebounce;
  const debouncer = debounceConfig?.enabled !== false
    ? new DeliverDebouncer(debounceConfig, async (targetId, mergedText) => {
        const result = await sendText({
          to: targetId,
          text: mergedText,
          accountId: account.accountId,
          replyToId: envelope.messageId,
          account,
        });
        // sendText 内部把异常转成了 { error }；这里必须抛出去，
        // 否则 ledger 会把失败当成功并保留 30 分钟的发送占位。
        if (result.error) throw new Error(result.error);
      })
    : undefined;

  const deliverCtx: DeliverContext = {
    qualifiedTarget,
    accountId: account.accountId,
    replyToId: envelope.messageId,
    chatScope: envelope.chatScope === 'group' ? 'group' : 'direct',
    cfg,
    debouncer: debouncer?.enabled ? debouncer : undefined,
    sendText: (to, text) => sendText({ to, text, accountId: account.accountId, replyToId: envelope.messageId, account }),
    sendMedia: (to, source, opts) => sendMedia({
      to,
      source,
      text: opts?.text ?? '',
      replyToId: envelope.messageId,
      accountId: account.accountId,
      agentId: route.agentId,
      log: deliverCtx.log,
    }),
    textToSpeech: ttsRuntime?.textToSpeech
      ? (params) => ttsRuntime.textToSpeech(params)
      : undefined,
    audioFileToSilkBase64: ttsRuntime?.audioFileToSilkBase64
      ? (audioPath: string) => ttsRuntime.audioFileToSilkBase64(audioPath)
      : undefined,
    log: log?.child('deliver'),
    agentId: route.agentId ?? 'default',
  };

  const streamingEnabled = shouldUseStreaming(
    account,
    envelope.chatScope === 'group' ? 'group' : 'c2c',
  );

  const streamingController = streamingEnabled
    ? createStreamingController(envelope, account, log?.child('streaming'))
    : null;

  if (streamingController) {
    dlog?.debug(`streaming enabled for ${envelope.senderId}`);
  }

  const deliveredMediaUrls = new Set<string>();
  const deliveredTexts = new Set<string>();
  const replyOptions = createQqbotReplyOptions({
    abortSignal: ctx.signal,
    runId: envelope.messageId,
    streamingController,
    log: dlog,
  });
  const deliverState: DispatchDeliverState = {
    ctx: deliverCtx,
    streamingController,
    deliveredMediaUrls,
    deliveredTexts,
    log: dlog,
    inboundMessageId: envelope.messageId,
    deliverReply,
  };

  if (!adapters.inboundRun) {
    if (adapters.recordInboundSession) {
      try {
        await adapters.recordInboundSession({
          storePath,
          sessionKey: route.sessionKey,
          ctx: ctxPayload,
        });
      } catch { /* best-effort */ }
    }
    await withDispatchRetry('dispatchReply', () => adapters.dispatchReply!({
      ctx: ctxPayload,
      cfg,
      // 走低层派发：核心必须先过 queue policy 再等活跃 run，steer 才可能注入
      dispatchReplyFromConfig: adapters.lowLevelDispatch ?? undefined,
      dispatcherOptions: {
        deliver: (payload: DeliverPayload, info?: DeliverInfo) =>
          deliverDispatchPayload(payload, info, deliverState),
      },
      replyOptions,
    }), dlog);
  } else {
    await withDispatchRetry('inboundRun', () => adapters.inboundRun!({
      channel: 'qqbot',
      accountId: route.accountId,
      raw: envelope,
      adapter: {
        ingest: (raw: any) => ({
          id: envelope.messageId,
          rawText: assembled.rawBody,
          textForAgent: assembled.agentBody,
          textForCommands: assembled.rawBody,
          raw,
        }),
        resolveTurn: (_input: unknown, _eventClass: unknown, _preflight: unknown) => ({
          channel: 'qqbot',
          accountId: route.accountId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: adapters.recordInboundSession,
          record: {
            onRecordError: (err: unknown) => {
              dlog?.error(`Session record error: ${err}`);
            },
          },
          runDispatchLifecycle: {
            turnAdoptionLifecycle: undefined,
            onDispatchSkipped: (reason: string) => {
              dlog?.info(`dispatch skipped reason=${reason} sessionKey=${route.sessionKey}`);
            },
          },
          runDispatch: () => {
            return adapters.dispatchReply!({
              ctx: ctxPayload,
              cfg,
              dispatchReplyFromConfig: adapters.lowLevelDispatch ?? undefined,
              dispatcherOptions: {
                deliver: (payload: DeliverPayload, info?: DeliverInfo) =>
                  deliverDispatchPayloadSafe(payload, info, deliverState),
              },
              replyOptions,
            });
          },
        }),
      },
    }), dlog);
  }

  dlog?.debug(`inboundRun completed sessionKey=${route.sessionKey}`);

  if (envelope.chatScope === 'group') {
    clearGroupHistory(account.accountId, envelope.groupId ?? envelope.senderId);
  }

  if (streamingController && !streamingController.isTerminal) {
    await streamingController.finalize();
  }

  if (debouncer) {
    await debouncer.flushAll();
  }
}

function createStreamingController(
  envelope: ReturnType<typeof buildEnvelope>,
  account: ResolvedQQBotAccount,
  log?: PluginLogger,
): StreamingController | null {
  const gw = getGateway(account.accountId);
  if (!gw) {
    log?.error(`cannot enable streaming — gateway not running`);
    return null;
  }
  return new StreamingController({
    gateway: gw,
    target: {
      scope: 'c2c',
      targetId: envelope.senderId,
      msgId: envelope.messageId,
    },
    accountId: account.accountId,
    replyToId: envelope.messageId,
    log,
  });
}
