/**
 * Setup 工具动态加载（plugin-sdk/setup + plugin-sdk/setup-tools）
 *
 * 新版本 openclaw 有这些导出，旧版本可能缺失。
 * 不可用时提供最小降级实现。
 */
import { createRequire } from 'node:module';

const req = createRequire(__filename);

let _setup: typeof import('openclaw/plugin-sdk/setup') | null | undefined;
let _tools: typeof import('openclaw/plugin-sdk/setup-tools') | null | undefined;

function loadSetup() {
  if (_setup !== undefined) return _setup;
  try { _setup = req('openclaw/plugin-sdk/setup'); } catch { _setup = null; }
  return _setup;
}

function loadTools() {
  if (_tools !== undefined) return _tools;
  try { _tools = req('openclaw/plugin-sdk/setup-tools'); } catch { _tools = null; }
  return _tools;
}

export type { ChannelSetupWizard } from 'openclaw/plugin-sdk/setup';

export const DEFAULT_ACCOUNT_ID = 'default';

export function createStandardChannelSetupStatus(
  ...args: Parameters<NonNullable<typeof _setup>['createStandardChannelSetupStatus']>
): ReturnType<NonNullable<typeof _setup>['createStandardChannelSetupStatus']> {
  const mod = loadSetup();
  if (mod) return mod.createStandardChannelSetupStatus(...args);
  return {
    channelLabel: args[0]?.channelLabel ?? 'QQ Bot',
    configuredLabel: 'Configured',
    unconfiguredLabel: 'Not configured',
    resolveConfigured: () => false,
  } as unknown as ReturnType<NonNullable<typeof _setup>['createStandardChannelSetupStatus']>;
}

export function setSetupChannelEnabled(
  ...args: Parameters<NonNullable<typeof _setup>['setSetupChannelEnabled']>
): void {
  loadSetup()?.setSetupChannelEnabled?.(...args);
}

export function formatDocsLink(
  ...args: Parameters<NonNullable<typeof _tools>['formatDocsLink']>
): ReturnType<NonNullable<typeof _tools>['formatDocsLink']> {
  const mod = loadTools();
  if (mod) return mod.formatDocsLink(...args);
  return (args[1] ? `${args[1]}: ${args[0]}` : args[0]) as ReturnType<NonNullable<typeof _tools>['formatDocsLink']>;
}
