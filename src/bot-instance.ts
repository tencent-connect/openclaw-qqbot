/**
 * Bot 实例访问器
 *
 * 提供统一的方式获取当前活跃的 QQBot SDK 实例。
 * 替代原 api.ts 的所有功能 — 消费者通过 getBotForAccount() 获取 bot，
 * 然后使用 bot.api / bot.send() 等 SDK 原生能力。
 */
import os from 'node:os';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import { getGateway } from './outbound/outbound-service.js';
import { getPackageVersion } from './utils/pkg-version.js';


const PLUGIN_VERSION = getPackageVersion();
let _openclawVersion = 'unknown';

export function setOpenClawVersion(version: string): void {
  if (version) _openclawVersion = version;
}

export function getOpenClawVersion(): string {
  return _openclawVersion;
}

export function buildUserAgent(suffix?: string): string {
  const base = `QQBotPlugin/${PLUGIN_VERSION} (Node/${process.versions.node}; ${os.platform()}; OpenClaw/${_openclawVersion})`;
  return suffix ? `${base} ${suffix}` : base;
}

// ── Bot 实例获取 ──

/**
 * 获取指定账户的 QQBot SDK 实例。
 *
 * @throws 如果该账户的 gateway 尚未启动
 *
 * @example
 * ```ts
 * const bot = getBotForAccount(accountId);
 * await bot.send({ target, content: 'hello' });
 * const guilds = await bot.api.get('/users/@me/guilds');
 * const token = await bot.api.getToken();
 * ```
 */
export function getBotForAccount(accountId: string): QQBot {
  const gw = getGateway(accountId);
  if (!gw) {
    throw new Error(`[qqbot] Bot "${accountId}" not running — gateway not started`);
  }
  return gw.bot;
}

/**
 * 尝试获取指定账户的 QQBot SDK 实例（不抛异常）。
 * 返回 null 表示 gateway 尚未启动。
 */
export function tryGetBotForAccount(accountId: string): QQBot | null {
  const gw = getGateway(accountId);
  return gw?.bot ?? null;
}
