/**
 * 消息转发 — 入站消息 → OpenClaw AI
 *
 * 核心职责：
 * 1. 从 SDK MiddlewareContext 构建 OpenClaw 标准信封
 * 2. 通过 runtime-adapter 将消息交给 AI 处理
 *
 * 架构说明：
 * - 所有 runtime.channel.* 访问均通过 runtime-adapter 隔离
 * - log: 前缀由 PluginLogger + 框架自动注入，消息体不重复 accountId
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
import { resolveTTSProvider } from '../outbound/tts-provider.js';


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

  const ttsRuntime = (runtime as any)?.tts ?? (runtime as any)?.channel?.runtimeContexts?.get?.('tts'); // @adapter-bypass: TTS is not part of the channel adapter API
  const ttsProvider = resolveTTSProvider(runtime, cfg);

  const debounceConfig = account.config?.deliverDebounce;
  const debouncer = debounceConfig?.enabled !== false
    ? new DeliverDebouncer(debounceConfig, (targetId, mergedText) =>
        sendText({ to: targetId, text: mergedText, accountId: account.accountId, replyToId: envelope.messageId, account }).then(() => {}),
      )
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
      mediaKind: opts?.mediaKind,
      replyToId: envelope.messageId,
      accountId: account.accountId,
      agentId: route.agentId,
      log: deliverCtx.log,
    }),
    textToSpeech: ttsRuntime?.textToSpeech
      ? (params) => ttsRuntime.textToSpeech(params)
      : ttsProvider
        ? async (params) => {
            try {
              return { audioPath: await ttsProvider.textToSpeech(params) };
            } catch (error) {
              return { audioPath: null, error: error instanceof Error ? error.message : String(error) };
            }
          }
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

  if (!adapters.inboundRun) {
    // 低版本：手动 session + dispatchReply 直调
    if (adapters.recordInboundSession) {
      try {
        await adapters.recordInboundSession({
          storePath,
          sessionKey: route.sessionKey,
          ctx: ctxPayload,
        });
      } catch { /* best-effort */ }
    }
    await adapters.dispatchReply!({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: DeliverPayload, info?: DeliverInfo) => {
          const text = payload.text?.trim() ?? '';
          // 低版本无 block/final 协议，流式启动后 final 仍需跳过（降级除外）
          if (!payload.mediaUrl && !payload.mediaUrls?.length
            && text
            && (deliveredTexts.has(text)
              || (streamingController?.hasStarted && !streamingController?.shouldFallbackToStatic))
          ) {
            return;
          }
          const filteredPayload = deliveredMediaUrls.size > 0
            ? {
                ...payload,
                mediaUrl: payload.mediaUrl && !deliveredMediaUrls.has(payload.mediaUrl)
                  ? payload.mediaUrl : undefined,
                mediaUrls: payload.mediaUrls?.filter((u) => !deliveredMediaUrls.has(u)),
              }
            : payload;
          await deliverReply(filteredPayload, info, deliverCtx);
          if (text) deliveredTexts.add(text);
          // 记录已投递媒体（流式路径可能已先发送）
          for (const u of filteredPayload.mediaUrls ?? []) deliveredMediaUrls.add(u);
          if (filteredPayload.mediaUrl) deliveredMediaUrls.add(filteredPayload.mediaUrl);
        },
      },
      replyOptions: {
        abortSignal: ctx.signal,
        runId: envelope.messageId,
        ...(streamingController
          ? {
              onPartialReply: async (p: { text?: string }) => {
                if (p.text) await streamingController.onPartialReply(p.text);
              },
            }
          : {}),
      },
    });
    if (streamingController && !streamingController.isTerminal) {
      await streamingController.finalize();
    }
    if (debouncer) await debouncer.flushAll();
  } else {
    await adapters.inboundRun!({
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
              dispatcherOptions: {
                deliver: async (payload: DeliverPayload, info?: DeliverInfo) => {
                  try {
                    const kind = (info as any)?.kind as string | undefined;
                    const text = payload.text?.trim() ?? '';
                    const hasMedia = !!(payload.mediaUrl || payload.mediaUrls?.length);
                    dlog?.debug(`deliver kind=${kind ?? 'none'} textLen=${text.length} voice=${!!payload.audioAsVoice} media=${hasMedia}`);

                    // ── 1. block: 媒体/语音立即发送，文本留给流式 ──
                    if (kind === 'block') {
                      if (payload.audioAsVoice) {
                        await deliverReply(payload, info, deliverCtx);
                      } else {
                        await forwardMediaUrls(payload, deliverCtx, deliveredMediaUrls, dlog);
                      }
                    }

                    // ── 2. 流式路径：流式已启动且未降级 → 跳过静态发送 ──
                    if (streamingController?.hasStarted && !streamingController.shouldFallbackToStatic) {
                      if (kind !== 'block') await streamingController.finalize();
                      if (!streamingController.shouldFallbackToStatic) return;
                      dlog?.warn(`streaming fallback to static`);
                    }

                    // ── 3. 文本去重：同文本已发过 → 跳过 ──
                    if (kind === 'final' && !hasMedia && text && deliveredTexts.has(text)) {
                      return;
                    }

                    // ── 4. tool 媒体：立即转发 ──
                    if (kind === 'tool') {
                      await forwardMediaUrls(payload, deliverCtx, deliveredMediaUrls, dlog);
                      return;
                    }

                    // ── 5. 默认路径：过滤已发媒体 + 发送 ──
                    const filteredPayload = filterDeliveredMedia(payload, deliveredMediaUrls);
                    await deliverReply(filteredPayload, info, deliverCtx);
                    if (text) deliveredTexts.add(text);
                  } catch (err) {
                    dlog?.error(`deliver error: ${err instanceof Error ? err.message : String(err)}`);
                  }
                },
            },
            replyOptions: {
              abortSignal: ctx.signal,
              runId: envelope.messageId,
              ...(streamingController
                ? {
                    onPartialReply: async (p: { text?: string }) => {
                      if (p.text) await streamingController.onPartialReply(p.text);
                    },
                  }
                : {}),
            },
          });
        },
      }),
    },
  });
  }
 
  dlog?.debug(`inboundRun completed sessionKey=${route.sessionKey}`);

  // 群消息回复后清空历史缓存（避免下次 @ 时重复组包）
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

// ── 辅助函数 ──

/** 提取 payload 中的媒体 URL 并逐个发送（去重） */
async function forwardMediaUrls(
  payload: DeliverPayload,
  ctx: DeliverContext,
  delivered: Set<string>,
  log?: PluginLogger,
): Promise<void> {
  const urls: string[] = [];
  if (payload.mediaUrls?.length) urls.push(...payload.mediaUrls);
  if (payload.mediaUrl && !urls.includes(payload.mediaUrl)) urls.push(payload.mediaUrl);
  const newUrls = urls.filter((u) => !delivered.has(u));
  for (const url of newUrls) {
    try {
      await sendMedia({
        to: ctx.qualifiedTarget,
        source: url,
        text: '',
        replyToId: ctx.replyToId,
        accountId: ctx.accountId,
        log: ctx.log,
        agentId: ctx.agentId,
      });
      delivered.add(url);
    } catch (err) {
      log?.error(`media forward failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 过滤已发送的媒体 URL */
function filterDeliveredMedia(
  payload: DeliverPayload,
  delivered: Set<string>,
): DeliverPayload {
  if (delivered.size === 0) return payload;
  return {
    ...payload,
    mediaUrl: payload.mediaUrl && !delivered.has(payload.mediaUrl) ? payload.mediaUrl : undefined,
    mediaUrls: payload.mediaUrls?.filter((u) => !delivered.has(u)),
  };
}
