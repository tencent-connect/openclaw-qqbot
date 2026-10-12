import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { WebSocketServer } from 'ws';

const f = vi.hoisted(() => ({ dir: '', gateways: new Map<string, { bot: QQBot }>(), inbound: vi.fn() }));
vi.mock('../src/runtime.js', () => ({ getQQBotRuntime: () => ({}) }));
vi.mock('../src/config.js', () => ({ DEFAULT_ACCOUNT_ID: 'default' }));
vi.mock('../src/adapter/resolve.js', () => ({ getAdapters: () => ({}) }));
vi.mock('../src/bot-instance.js', () => ({ buildUserAgent: () => 'qqbot-recovery-test' }));
vi.mock('../src/gateway/middleware-setup.js', () => ({ setupMiddlewares: vi.fn() }));
vi.mock('../src/gateway/event-handlers.js', () => ({ handleMessage: f.inbound, handleInteraction: vi.fn() }));
vi.mock('../src/adapter/webhook.js', () => ({ createPluginWebhookAdapter: vi.fn() }));
vi.mock('../src/features/ref-index-store.js', () => ({ getPersistedRefIndexStore: vi.fn() }));
vi.mock('../src/features/msgid-cache.js', () => ({ getCachedMsgId: vi.fn() }));
vi.mock('../src/utils/platform.js', () => ({ getQQBotDataDir: () => f.dir }));
vi.mock('../src/utils/plugin-logger.js', () => ({
  createPluginLogger: () => {
    const log = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => log };
    return log;
  },
}));
vi.mock('../src/outbound/outbound-service.js', () => ({
  registerGateway: (id: string, gateway: { bot: QQBot }) => f.gateways.set(id, gateway),
  getGateway: (id: string) => f.gateways.get(id),
  unregisterGateway: (id: string) => f.gateways.delete(id),
}));
vi.mock('../src/features/credential-backup.js', () => ({ saveCredentialBackup: vi.fn() }));
vi.mock('../src/features/update-checker.js', () => ({ triggerUpdateCheck: vi.fn() }));
vi.mock('../src/features/approval-handler.js', () => ({
  QQBotApprovalHandler: class { start = vi.fn(); stop = vi.fn(); },
  registerApprovalHandler: vi.fn(), getApprovalHandler: vi.fn(), unregisterApprovalHandler: vi.fn(),
}));
import { startAccountWithCredentialRecovery } from '../src/gateway/lifecycle.js';
import type { StartAccountContext } from '../src/gateway/lifecycle.js';

let server: WebSocketServer | undefined;
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const ws of server?.clients ?? []) ws.terminate();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  vi.restoreAllMocks();
  f.gateways.clear();
  if (f.dir) await rm(f.dir, { recursive: true, force: true });
});

it('reports the real SDK disconnect and receives a message after the host restarts an exhausted account', async () => {
  f.dir = await mkdtemp(join(tmpdir(), 'qqbot-recovery-'));
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const url = `ws://127.0.0.1:${address.port}`;
  const sockets: import('ws').WebSocket[] = [];
  server.on('connection', ws => {
    sockets.push(ws);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100_000 } }));
    ws.on('message', raw => {
      const { op } = JSON.parse(raw.toString());
      if (op === 2 || op === 6) ws.send(JSON.stringify({ op: 0, t: op === 6 ? 'RESUMED' : 'READY', s: 1, d: { session_id: 'synthetic-session' } }));
    });
  });
  let online = true;
  let failures = 0;
  const originalStart = QQBot.prototype.start;
  vi.spyOn(QQBot.prototype, 'start').mockImplementation(function (this: QQBot, signal) {
    vi.spyOn(this.tokenManager, 'getAccessToken').mockResolvedValue('synthetic-token');
    vi.spyOn(this.messageApi, 'getGatewayUrl').mockImplementation(async () => {
      if (!online) { failures++; throw new Error('simulated gateway outage'); }
      return url;
    });
    return originalStart.call(this, signal);
  });
  // Compress backoff only; exercise real SDK, wrapper, socket I/O and host-facing status.
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) =>
    realSetTimeout(callback, [1000, 2000, 5000, 10_000, 30_000, 60_000].includes(delay as number) ? 1 : delay, ...args)
  ) as typeof setTimeout);
  let status: Record<string, unknown> = {};
  const start = () => {
    const controller = new AbortController(); controllers.push(controller);
    const ctx: StartAccountContext = {
      account: { accountId: 'default', appId: 'synthetic', clientSecret: 'synthetic', enabled: true, secretSource: 'config', markdownSupport: true, config: {} },
      cfg: {}, abortSignal: controller.signal,
      getStatus: () => status,
      setStatus: next => { status = { ...status, ...next }; },
    };
    return startAccountWithCredentialRecovery(ctx);
  };
  const first = start().catch(error => error);
  await vi.waitFor(() => expect(status.connected).toBe(true));
  online = false; sockets[0].terminate();
  await vi.waitFor(() => expect(status.connected).toBe(false));
  expect(status.lastDisconnect).toMatchObject({ error: 'WebSocket closed: 1006' });
  await vi.waitFor(() => expect(failures).toBe(100));
  expect(await first).toEqual(expect.objectContaining({ message: expect.stringMatching(/reconnect attempts/i) }));
  expect(status).toMatchObject({ running: false, connected: false });
  expect(f.gateways.size).toBe(0);
  online = true;
  const restarted = start();
  await vi.waitFor(() => expect(status).toMatchObject({ running: true, connected: true, lastError: null }));
  sockets[1].send(JSON.stringify({
    op: 0, t: 'C2C_MESSAGE_CREATE', s: 2,
    d: { id: 'synthetic-message', content: 'hello after recovery', timestamp: new Date().toISOString(), author: { user_openid: 'synthetic-user' } },
  }));
  await vi.waitFor(() => expect(f.inbound).toHaveBeenCalledOnce());
  expect(f.inbound.mock.calls[0][1]).toMatchObject({ content: 'hello after recovery' });
  controllers[1].abort(); await restarted;
  expect(status).toMatchObject({ running: false, connected: false });
});
