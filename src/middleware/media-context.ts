import type { HistoryEntry, HistoryStore, Middleware, MiddlewareContext, RefEntry, RefIndexStore, ResolvedQuote } from '@tencent-connect/qqbot-nodejs';
import type { MessageAttachment } from '../types.js';

export interface MediaHistoryEntry extends HistoryEntry {
  attachments?: MessageAttachment[];
  msgIdx?: string;
}
export interface MediaRefEntry extends RefEntry {
  attachments?: MessageAttachment[];
  peerId?: string;
}

/** Preserve media metadata before mentionGate, without triggering an agent or downloading chatter. */
export function mediaHistoryBuffer(store: HistoryStore, groupKey: (ctx: MiddlewareContext) => string | undefined): Middleware {
  return async (ctx, next) => {
    const key = groupKey(ctx);
    if (key) {
      const configured = (ctx.state.policy as { group?: { historyLimit?: number } } | undefined)?.group?.historyLimit ?? 20;
      const limit = Math.min(100, Math.max(0, Math.floor(configured)));
      if (limit > 0) {
        ctx.state.history = await store.list(key, limit);
        const m = ctx.message;
        await store.append(key, {
          senderId: m.senderId, senderName: m.senderName,
          content: m.content, timestamp: Date.parse(m.timestamp) || Date.now(), messageId: m.messageId,
          msgIdx: m.msgIdx, attachments: m.attachments?.map(a => ({ ...a })),
        } as MediaHistoryEntry, limit);
      } else {
        ctx.state.history = [];
        await store.clear?.(key);
      }
    }
    await next();
  };
}

/** Keep original attachment metadata scoped to the peer that produced its reference. */
export function enrichMediaRef(entry: RefEntry, ctx: MiddlewareContext): MediaRefEntry {
  return {
    ...entry,
    peerId: ctx.message.replyTarget.targetId,
    attachments: ctx.message.attachments?.map(a => ({ ...a })),
  };
}

export interface ContextImage { attachment: MessageAttachment; label: string }

/** Explicit quotes take precedence. History is already isolated by account + group. */
export async function collectContextImages(ctx: MiddlewareContext, store: RefIndexStore): Promise<ContextImage[]> {
  const quote = ctx.state.quote as ResolvedQuote | undefined;
  const history = (ctx.state.history ?? []) as MediaHistoryEntry[];
  const out: ContextImage[] = [];
  const seen = new Set((ctx.message.attachments ?? []).map(a => a.url).filter(Boolean));
  /** Keep only unique, downloadable pictures while preserving quote-first order. */
  const add = (a: MessageAttachment, label: string) => {
    if (!a.content_type?.startsWith('image/') || !a.url || seen.has(a.url)) return;
    seen.add(a.url);
    out.push({ attachment: a, label });
  };
  if (quote) {
    const stored = await store.get(quote.refKey) as MediaRefEntry | undefined;
    const trusted = stored?.peerId === ctx.message.replyTarget.targetId && stored.scope === ctx.message.kind;
    const original = history.find(h => h.msgIdx === quote.refKey || h.messageId === quote.refKey);
    const originals = trusted ? stored?.attachments ?? [] : original?.attachments ?? [];
    for (const a of quote.attachments ?? []) {
      const recovered = !a.url && a.filename
        ? originals.find(o => o.filename === a.filename)
        : undefined;
      add(recovered ?? { content_type: a.contentType, url: a.url, filename: a.filename }, 'Quoted image');
    }
    // QQ sometimes supplies only refMsgIdx, without msg_elements.
    for (const a of originals) add(a, 'Quoted image');
  }
  // Include only recent buffered pictures; do not turn an entire busy group into a large vision request.
  const recent = history.flatMap(h => (h.attachments ?? []).map(attachment => ({
    attachment, label: `History image from ${h.senderName ?? h.senderId} (message ${h.messageId})`,
  }))).filter(x => x.attachment.content_type?.startsWith('image/')).slice(-4);
  for (const item of recent) add(item.attachment, item.label);
  return out.slice(0, 8);
}
