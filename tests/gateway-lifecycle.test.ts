import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayCallbacks } from '../src/gateway/qqbot-gateway.js';
import type { StartAccountContext } from '../src/gateway/lifecycle.js';

const f = vi.hoisted(() => ({
  callbacks: undefined as GatewayCallbacks | undefined,
  finish: undefined as (() => void) | undefined,
  fail: undefined as ((error: Error) => void) | undefined,
  gateways: new Map(),
  handlers: new Map(),
  stop: vi.fn(),
  approvalStop: vi.fn(),
}));
vi.mock('../src/gateway/qqbot-gateway.js', () => ({
  QQBotGateway: class {
    start(callbacks: GatewayCallbacks) {
      f.callbacks = callbacks;
      return new Promise<void>((resolve, reject) => { f.finish = resolve; f.fail = reject; });
    }
    stop = f.stop;
  },
}));
vi.mock('../src/runtime.js', () => ({ getQQBotRuntime: () => ({}) }));
vi.mock('../src/config.js', () => ({ DEFAULT_ACCOUNT_ID: 'default' }));
vi.mock('../src/adapter/resolve.js', () => ({ getAdapters: () => ({}) }));
vi.mock('../src/utils/plugin-logger.js', () => ({
  createPluginLogger: () => {
    const log = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => log };
    return log;
  },
}));
vi.mock('../src/outbound/outbound-service.js', () => ({
  registerGateway: (id: string, gateway: unknown) => f.gateways.set(id, gateway),
  getGateway: (id: string) => f.gateways.get(id),
  unregisterGateway: (id: string) => f.gateways.delete(id),
}));
vi.mock('../src/features/credential-backup.js', () => ({ saveCredentialBackup: vi.fn() }));
vi.mock('../src/features/update-checker.js', () => ({ triggerUpdateCheck: vi.fn() }));
vi.mock('../src/features/approval-handler.js', () => ({
  QQBotApprovalHandler: class { start = vi.fn(); stop = f.approvalStop; },
  registerApprovalHandler: (id: string, handler: unknown) => f.handlers.set(id, handler),
  getApprovalHandler: (id: string) => f.handlers.get(id),
  unregisterApprovalHandler: (id: string) => f.handlers.delete(id),
}));
import { startAccountWithCredentialRecovery, stopAccountGracefully } from '../src/gateway/lifecycle.js';

function fixture() {
  let status: Record<string, unknown> = { running: true, connected: false, lastError: 'old failure' };
  const ctx: StartAccountContext = {
    account: { accountId: 'default', appId: 'synthetic', clientSecret: 'synthetic', enabled: true, secretSource: 'config', markdownSupport: true, config: {} },
    cfg: {},
    abortSignal: new AbortController().signal,
    getStatus: () => status,
    setStatus: (next) => { status = { ...status, ...next }; },
  };
  const run = startAccountWithCredentialRecovery(ctx);
  return { run, getStatus: ctx.getStatus };
}
beforeEach(() => { vi.clearAllMocks(); f.gateways.clear(); f.handlers.clear(); });
afterEach(() => { f.finish?.(); });

describe('account transport lifecycle', () => {
  it('reports disconnect immediately and clears the error when the transport resumes', async () => {
    const { run, getStatus } = fixture();
    f.callbacks!.onReady!();
    expect(getStatus()).toMatchObject({ connected: true });
    f.callbacks!.onDisconnected!({ code: 1006, reason: '' });
    expect(getStatus()).toMatchObject({ connected: false, lastDisconnect: { error: 'WebSocket closed: 1006', at: expect.any(Number) } });
    f.callbacks!.onError!(new Error('gateway discovery failed'));
    expect(getStatus()).toMatchObject({ connected: false, lastError: 'gateway discovery failed' });
    f.callbacks!.onReady!();
    expect(getStatus()).toMatchObject({ connected: true, lastError: null });
    f.callbacks!.onError!(new Error('message handler failed'));
    expect(getStatus()).toMatchObject({ connected: true, lastError: 'message handler failed' });
    f.finish!(); await run;
  });

  it('propagates exhausted recovery and removes the failed account resources', async () => {
    const { run, getStatus } = fixture();
    f.callbacks!.onReady!();
    await Promise.resolve();
    const failure = new Error('Max reconnect attempts reached');
    const rejected = expect(run).rejects.toBe(failure);
    f.fail!(failure);
    await rejected;
    expect(getStatus()).toMatchObject({ running: false, connected: false, lastError: failure.message });
    expect(f.gateways.size).toBe(0);
    expect(f.handlers.size).toBe(0);
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.approvalStop).toHaveBeenCalledTimes(1);
  });

  it('marks normal termination offline and does not overwrite a replacement account', async () => {
    const { run, getStatus } = fixture();
    f.callbacks!.onReady!();
    f.finish!(); await run;
    expect(getStatus()).toMatchObject({ running: false, connected: false });
    const replacement = { stop: vi.fn() };
    f.gateways.set('default', replacement);
    f.callbacks!.onReady!();
    expect(getStatus()).toMatchObject({ running: false, connected: false });
    expect(f.gateways.get('default')).toBe(replacement);
  });

  it('releases the registered instance before awaiting stop', async () => {
    const { run } = fixture();
    let finishStop!: () => void;
    f.stop.mockImplementationOnce(() => new Promise<void>(resolve => { finishStop = resolve; }));
    const stopping = stopAccountGracefully({ accountId: 'default' });
    const replacement = { stop: vi.fn() };
    f.gateways.set('default', replacement);
    finishStop(); await stopping;
    expect(f.gateways.get('default')).toBe(replacement);
    f.finish!(); await run;
  });
});
