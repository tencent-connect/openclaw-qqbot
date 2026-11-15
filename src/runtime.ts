/**
 * QQBot 插件运行时管理。
 *
 * 日志统一由 `utils/plugin-logger.ts` 提供，此处只管理 runtime 实例。
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";
import { setOpenClawVersion } from "./bot-instance.js";
import { flushAllRefIndexStores } from "./features/ref-index-store.js";
import { getOpenclawVersion } from "./utils/pkg-version.js";

let runtime: PluginRuntime | null = null;
let exitHooksInstalled = false;

export function setQQBotRuntime(next: PluginRuntime) {
  runtime = next;
  const version = getOpenclawVersion(next.version);
  setOpenClawVersion(version);
  installExitHooksOnce();
}

function installExitHooksOnce(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;

  const flush = () => {
    try { flushAllRefIndexStores(); } catch {}
  };

  process.on('beforeExit', flush);
  process.on('SIGINT', () => { flush(); process.exit(0); });
  process.on('SIGTERM', () => { flush(); process.exit(0); });
}

export function getQQBotRuntime(): PluginRuntime {
  if (!runtime) throw new Error("QQBot runtime not initialized");
  return runtime;
}

export function tryGetQQBotRuntime(): PluginRuntime | null {
  return runtime;
}
