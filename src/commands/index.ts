/**
 * 斜杠命令注册表
 *
 * 通过 SDK 的 slashCommand 中间件统一注册所有内置命令。
 * 每个命令拆分为独立文件，此处仅编排。
 */
import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import { botHelp } from './bot-help.js';
import { botPing } from './bot-ping.js';
import { botVersion } from './bot-version.js';
import { botMe } from './bot-me.js';
import { botUpgrade } from './bot-upgrade.js';
import { botStreaming } from './bot-streaming.js';
import { botClearStorage } from './bot-clear-storage.js';
import { botLogs } from './bot-logs.js';
import { botApprove } from './bot-approve.js';
import { botGroupAlways } from './bot-group-always.js';
import { botPairing } from './bot-pairing.js';

export interface CommandBuildOptions {
  getRuntime: () => PluginRuntime;
}

/**
 * 构建标准命令列表（匹配后直接回复，不进入 AI）
 */
export function buildCommandList(account: ResolvedQQBotAccount, opts: CommandBuildOptions): SlashCommand[] {
  const commands: SlashCommand[] = [];

  // help 需要访问完整命令列表，延迟绑定
  const help = botHelp(account, () => commands);
  commands.push(
    help,
    botPing(),
    botVersion(account),
    botMe(),
    botUpgrade(account),
    botLogs(opts.getRuntime()),
    botStreaming(account, opts.getRuntime),
    botClearStorage(account),
    botApprove(opts.getRuntime),
    botGroupAlways(account, opts.getRuntime),
    botPairing(opts.getRuntime),
  );

  return commands;
}
