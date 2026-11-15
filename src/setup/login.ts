/**
 * QQ Bot QR 登录 — 两阶段接口适配
 *
 * 使用 @tencent-connect/qqbot-connector 的 startQrConnect 回调 API，
 * 将扫码绑定流程拆分为 start / wait 两个阶段，对接 ChannelPlugin 的
 * gateway.loginWithQrStart / loginWithQrWait。
 */
import { startQrConnect, type QrConnectCredentials } from '@tencent-connect/qqbot-connector';

// ── 类型 ──

export interface QrLoginStartResult {
  qrDataUrl?: string;
  message: string;
}

export interface QrLoginWaitResult {
  connected: boolean;
  message: string;
  credentials?: QrConnectCredentials[];
}

// ── 挂起的登录会话 ──

interface PendingSession {
  /** 等待扫码结果的 Promise（onSuccess resolve, onFailure reject） */
  credentialsPromise: Promise<QrConnectCredentials[]>;
  /** 取消当前流程 */
  dispose: () => void;
}

const pendingSessions = new Map<string, PendingSession>();

// ── 启动 QR 登录 ──

export function startQrLogin(accountId?: string, source = 'openclaw'): Promise<QrLoginStartResult> {
  const key = accountId ?? 'default';

  // 清理旧会话
  pendingSessions.get(key)?.dispose();
  pendingSessions.delete(key);

  return new Promise((resolve) => {
    let credentialsResolve: (creds: QrConnectCredentials[]) => void;
    let credentialsReject: (err: Error) => void;

    // 凭据 Promise — 在 onSuccess/onFailure 中 settle
    const credentialsPromise = new Promise<QrConnectCredentials[]>((res, rej) => {
      credentialsResolve = res;
      credentialsReject = rej;
    });

    const dispose = startQrConnect(
      {
        onQrDisplayed(url) {
          resolve({
            qrDataUrl: url,
            message: '请使用手机 QQ 扫描二维码完成绑定',
          });
        },
        onSuccess: (creds) => credentialsResolve!(creds),
        onFailure: (err) => credentialsReject!(err),
      },
      { displayQrCodeToConsole: true, source },
    );

    pendingSessions.set(key, { dispose, credentialsPromise });
  });
}

// ── 等待扫码结果 ──

export async function waitQrLogin(accountId?: string): Promise<QrLoginWaitResult> {
  const key = accountId ?? 'default';
  const session = pendingSessions.get(key);

  if (!session) {
    return { connected: false, message: '没有正在进行的登录会话，请先运行 login 命令。' };
  }

  try {
    const credentials = await session.credentialsPromise;
    pendingSessions.delete(key);

    if (credentials.length === 0) {
      return { connected: false, message: '未获取到 QQ Bot 凭据。' };
    }

    return {
      connected: true,
      message: `绑定成功！AppID: ${credentials.map((c) => c.appId).join(', ')}`,
      credentials,
    };
  } catch (err) {
    pendingSessions.delete(key);
    return {
      connected: false,
      message: `绑定失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── 主动取消 ──

export function cancelQrLogin(accountId?: string): void {
  const key = accountId ?? 'default';
  pendingSessions.get(key)?.dispose();
  pendingSessions.delete(key);
}

// ── 解析 channelInput (appId:clientSecret) ──

export function parseChannelInput(channelInput?: string | null): { appId: string; clientSecret: string } | null {
  if (!channelInput) return null;
  const parts = channelInput.trim().split(':');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { appId: parts[0], clientSecret: parts[1] };
  }
  return null;
}

// ── auth.login 入口 ──

export interface QqbotLoginParams {
  cfg: Record<string, unknown>;
  accountId?: string | null;
  channelInput?: string | null;
  verbose?: boolean;
  /** 框架注入的 runtime（含 config 持久化 API） */
  [key: string]: unknown;
}

/**
 * auth.login 完整实现。
 *
 * 账号策略：
 *   --account <id>  → 写入指定账户
 *   channelInput     → 用 appId 作为账户键
 *   QR 扫码         → 用扫码返回的 appId 作为新账户键
 */
export async function qqbotLogin({
  cfg,
  accountId,
  channelInput,
  verbose,
  ...rest
}: QqbotLoginParams): Promise<void> {
  // 延迟导入，避免循环依赖
  const { applyQQBotAccountConfig } = await import('../config.js');
  const { persistAuthConfig } = await import('../adapter/resolve.js');
  const { applyAccountDefaults } = await import('./finalize.js');
  const { resolveAccountKey } = await import('./account-key.js');

  const runtime: Record<string, unknown> = rest as any;
  const resolvedId = accountId ? accountId.trim().toLowerCase() : null;

  // 如果传了 appId:clientSecret，直接写入配置
  const parsed = parseChannelInput(channelInput);
  if (parsed) {
    const key = resolveAccountKey(cfg as any, parsed.appId, resolvedId);
    const result = applyQQBotAccountConfig(cfg as any, key, {
      appId: parsed.appId,
      clientSecret: parsed.clientSecret,
    });
    Object.assign(cfg, result);
    // 对齐 setup：写入默认 streaming/dmPolicy
    const withDefaults = applyAccountDefaults(cfg as any, key);
    Object.assign(cfg, withDefaults);
    await persistAuthConfig(runtime, cfg, 'restart');
    if (verbose) console.log(`QQ Bot 已配置 (${key}) AppID: ${parsed.appId}`);
    return;
  }

  // QR 扫码登录
  const { qrDataUrl, message } = await startQrLogin(resolvedId || 'pending');
  console.log(`\n${message}`);
  if (qrDataUrl) console.log(`QR 链接: ${qrDataUrl}`);

  const result = await waitQrLogin(resolvedId || 'pending');
  if (!result.connected || !result.credentials) {
    throw new Error(result.message);
  }

  for (const cred of result.credentials) {
    const key = resolveAccountKey(cfg as any, cred.appId, resolvedId);
    const next = applyQQBotAccountConfig(cfg as any, key, {
      appId: cred.appId,
      clientSecret: cred.appSecret,
    });
    Object.assign(cfg, next);
    // 对齐 setup：写入默认 streaming/dmPolicy，扫码用户加入白名单
    const withDefaults = applyAccountDefaults(cfg as any, key, cred.userOpenid);
    Object.assign(cfg, withDefaults);
  }
  await persistAuthConfig(runtime, cfg, 'restart');
  console.log(`QQ Bot 登录成功！`);
}
