/**
 * PluginWebhookAdapter — 将 OpenClaw Gateway HTTP 路由适配为 SDK WebhookServerAdapter。
 *
 * 复用 openclaw/plugin-sdk/webhook-ingress 的 target registry、rate limiting 和
 * resolveWebhookTargetWithAuthOrRejectSync 签名匹配，对齐旧版本插件行为。
 *
 * 多账号同路径：通过 resolveWebhookTargetWithAuthOrRejectSync 遍历 targets 做
 * Ed25519 签名匹配，找到正确的 target 后调用其 SDK handler 处理事件。
 */
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { WebhookServerAdapter, WebhookRequestHandler } from '@tencent-connect/qqbot-nodejs';
import { verifyWebhookSignature } from '@tencent-connect/qqbot-nodejs/protocol';

// ── 模块级共享状态 ──
interface WebhookTarget {
  path: string;
  accountId: string;
  appId: string;
  clientSecret: string;
  handler: WebhookRequestHandler;
}
const sharedTargets = new Map<string, WebhookTarget[]>();
const _routeUnregisters = new Map<string, () => void>();

export function createPluginWebhookAdapter(params: {
  account: ResolvedQQBotAccount;
  log: PluginLogger;
}): WebhookServerAdapter {
  let unregistered = false;
  let storedPath = '';
  const accountId = params.account.accountId;

  return {
    async listen(_port: number, path: string, handler: WebhookRequestHandler): Promise<void> {
      const ingress = await import('openclaw/plugin-sdk/webhook-ingress').catch(() => null);
      if (!ingress?.registerWebhookTargetWithPluginRoute) {
        params.log.error('Webhook ingress not available');
        return;
      }

      const webhookPath = storedPath = path && path !== '/' ? path : (params.account.config.webhook?.path ?? '/qqbot/webhook');

      // 去重：reload 时避免同一 accountId 重复注册
      const existing = sharedTargets.get(webhookPath);
      if (existing) {
        const dupIdx = existing.findIndex((t) => t.accountId === accountId);
        if (dupIdx >= 0) {
          existing[dupIdx] = { path: webhookPath, accountId, appId: params.account.appId, clientSecret: params.account.clientSecret, handler };
          params.log.info(`Webhook target refreshed for ${accountId} on ${webhookPath}`);
          return;
        }
      }

      // 注册 target（框架管理 targetsByPath + 首次触发路由注册）
      const target: WebhookTarget = {
        path: webhookPath,
        accountId,
        appId: params.account.appId,
        clientSecret: params.account.clientSecret,
        handler,
      };

      const result = ingress.registerWebhookTargetWithPluginRoute({
        targetsByPath: sharedTargets as any,
        target,
        route: {
          auth: 'plugin',
          match: 'exact',
          pluginId: 'openclaw-qqbot',
          source: 'qqbot-webhook',
          accountId,
          replaceExisting: true,
          log: (msg: string) => params.log.info(msg),
          handler: createSharedHandler(webhookPath, params.log),
        },
        onLastPathTargetRemoved: () => {
          params.log.info(`Last webhook target removed from ${webhookPath}`);
        },
      });
      _routeUnregisters.set(webhookPath, result.unregister);

      params.log.info(`Webhook target added on ${webhookPath} (${sharedTargets.get(webhookPath)!.length} account(s))`);
    },

    close(): void {
      if (unregistered) return;
      unregistered = true;
      if (storedPath) {
        _routeUnregisters.get(storedPath)?.();
        _routeUnregisters.delete(storedPath);
      }
    },
  };
}

function createSharedHandler(path: string, log: PluginLogger) {
  return async (req: any, res: any) => {
    try {
      const ingress = await import('openclaw/plugin-sdk/webhook-ingress').catch(() => null);

      if (!ingress?.withResolvedWebhookRequestPipeline) {
        await handleSimple(req, res, path, log);
        return;
      }

      await ingress.withResolvedWebhookRequestPipeline({
        req,
        res,
        targetsByPath: sharedTargets,
        rateLimiter: ingress.createFixedWindowRateLimiter?.({
          windowMs: 60_000, maxRequests: 600, maxTrackedKeys: 4096,
        }),
        inFlightLimiter: ingress.createWebhookInFlightLimiter?.({
          maxInFlightPerKey: 8, maxTrackedKeys: 4096,
        }),
        requireJsonContentType: true,
        handle: async ({ targets }) => {
          const bodyResult = await ingress.readWebhookBodyOrReject({
            req, res, maxBytes: 1_048_576, timeoutMs: 30_000,
          });
          if (!bodyResult.ok) {
            log.warn?.(`[webhook] body rejected`);
            return;
          }

          const rawBody = Buffer.from(bodyResult.value, 'utf-8');

          let payload: any;
          try { payload = JSON.parse(bodyResult.value); } catch (err) {
            log.warn?.(`[webhook] invalid json: ${(err as Error).message}`);
            res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid json' })); return;
          }

          // op:13 → 用第一个 target 的 SDK handler（无需签名）
          if (payload.op === 13) {
            const t = targets[0];
            if (!t) {
              log.warn?.(`[webhook] op:13 no target on ${path}`);
              res.statusCode = 500; res.end(JSON.stringify({ error: 'no target' })); return;
            }
            const h = resolveTargetHandler(path, t.accountId);
            if (!h) {
              log.warn?.(`[webhook] op:13 no handler for ${t.accountId}`);
              res.statusCode = 500; res.end(JSON.stringify({ error: 'no handler' })); return;
            }
            await delegateToHandler(h, req, res, rawBody);
            return;
          }

          // op:0 → 签名匹配 target → SDK handler 处理事件
          const timestamp = getHeader(req, 'x-signature-timestamp') ?? '';
          const signature = getHeader(req, 'x-signature-ed25519') ?? '';
          if (!timestamp || !signature) {
            log.warn?.(`[webhook] missing signature headers on ${req.url}`);
            res.statusCode = 401; res.end(JSON.stringify({ error: 'missing signature' })); return;
          }

          const matched = ingress.resolveWebhookTargetWithAuthOrRejectSync({
            targets, res,
            isMatch: (t: any) => verifyWebhookSignature({
              body: rawBody, timestamp, signature, botSecret: t.clientSecret as string,
            }),
            unauthorizedStatusCode: 401,
            unauthorizedMessage: JSON.stringify({ error: 'invalid signature' }),
          });
          if (!matched) {
            log.warn?.(`[webhook] signature mismatch on ${path} (${targets.length} target(s))`);
            return;
          }

          const h = resolveTargetHandler(path, matched.accountId);
          if (!h) {
            log.error?.(`[webhook] no handler for matched target ${matched.accountId}`);
            res.statusCode = 500; res.end(JSON.stringify({ error: 'no handler' })); return;
          }
          await delegateToHandler(h, req, res, rawBody);
        },
      });
    } catch (err) {
      log.error(`Webhook handler error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    }
  };
}

function resolveTargetHandler(path: string, accountId: string): WebhookRequestHandler | undefined {
  return sharedTargets.get(path)?.find((t) => t.accountId === accountId)?.handler;
}

async function delegateToHandler(handler: WebhookRequestHandler, req: any, res: any, rawBody: Buffer) {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k.toLowerCase()] = v as string | string[];
  }
  const resp = await handler({ body: rawBody, headers });
  res.statusCode = resp.status;
  if (resp.headers) {
    for (const [k, v] of Object.entries(resp.headers)) res.setHeader(k, v as string);
  }
  res.end(resp.body);
}

async function handleSimple(req: any, res: any, path: string, log: PluginLogger) {
  try {
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/json')) { res.statusCode = 400; res.end(JSON.stringify({ error: 'unsupported content type' })); return; }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > 1_048_576) { res.statusCode = 413; res.end(JSON.stringify({ error: 'too large' })); return; }
      chunks.push(buf);
    }
    const rawBody = Buffer.concat(chunks);
    const entries = sharedTargets.get(path) ?? [];
    for (const entry of entries) {
      const resp = await entry.handler({ body: rawBody, headers: mapHeaders(req) });
      if (resp.status < 400) {
        res.statusCode = resp.status;
        if (resp.headers) for (const [k, v] of Object.entries(resp.headers)) res.setHeader(k, v as string);
        res.end(resp.body);
        return;
      }
    }
    res.statusCode = 401; res.end(JSON.stringify({ error: 'invalid signature' }));
  } catch (err) {
    log.error(`Webhook simple handler error: ${(err as Error).message}`);
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: 'internal error' })); }
  }
}

function mapHeaders(req: any): Record<string, string | string[]> {
  const h: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) h[k.toLowerCase()] = v as string | string[];
  return h;
}

function getHeader(req: any, key: string): string | undefined {
  const val = req.headers[key];
  return Array.isArray(val) ? val[0] : val;
}
