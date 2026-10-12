import type { Middleware } from '@tencent-connect/qqbot-nodejs';

/** Preserve request cancellation without serializing a peer's entire Agent Run. */
export function processingTimeout(maxProcessingMs: number): Middleware {
  return async (ctx, next) => {
    if (!(maxProcessingMs > 0)) {
      await next();
      return;
    }
    const timer = setTimeout(() => {
      ctx.log.warn?.(`[processing-timeout] aborting msgId=${ctx.message.messageId} after ${maxProcessingMs}ms`);
      ctx.abort('concurrency:processing-timeout');
    }, maxProcessingMs);
    timer.unref();
    try {
      await next();
    } finally {
      clearTimeout(timer);
    }
  };
}
