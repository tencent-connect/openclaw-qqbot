import type { QQBot } from '@tencent-connect/qqbot-nodejs';

const pendingRequests = new Map<string, Promise<unknown>>();
const wrappedApis = new WeakSet<QQBot['messageApi']>();

/** Serialize QQ stream HTTP requests without locking inbound Agent turns. */
export function serializeStreamRequests(bot: QQBot): void {
  const api = bot.messageApi;
  if (wrappedApis.has(api)) return;
  wrappedApis.add(api);
  const send = api.sendC2CStreamMessage.bind(api);

  // Wrap the public API rather than StreamSession.update(): the SDK also
  // sends frames from throttle timers, trailing flushes and complete().
  api.sendC2CStreamMessage = async (credentials, openid, request) => {
    const key = JSON.stringify([credentials.appId, openid]);
    const previous = pendingRequests.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => send(credentials, openid, request));
    pendingRequests.set(key, current);
    try {
      return await current;
    } finally {
      if (pendingRequests.get(key) === current) pendingRequests.delete(key);
    }
  };
}
