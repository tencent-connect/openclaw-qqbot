import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { getPackageVersion } from '../utils/pkg-version.js';

const PLUGIN_VERSION = getPackageVersion();

/** 群聊时隐藏的仅限私聊指令 */
const GROUP_EXCLUDED = new Set([
  'bot-upgrade', 'bot-clear-storage', 'bot-logs',
  'bot-approve', 'bot-group-always', 'bot-group-allways', 'bot-streaming', 'bot-me',
]);

/** /bot-help — 查看所有指令以及用途 */
export function botHelp(_account: ResolvedQQBotAccount, allCommands: () => SlashCommand[]): SlashCommand {
  return {
    name: 'bot-help',
    description: '查看所有指令以及用途',
    usage: [
      '/bot-help',
      '',
      '列出所有可用的 QQBot 插件内置指令及其简要说明。',
      '使用 /指令名 ? 可查看某条指令的详细用法。',
    ].join('\n'),
    handler: (ctx) => {
      const isGroup = ctx.message.kind === 'group';
      const lines = ['### QQBot插件内置调试指令', ''];

      for (const cmd of allCommands()) {
        const name = Array.isArray(cmd.name) ? cmd.name[0] : cmd.name;
        if (cmd.hidden) continue;
        if (isGroup && GROUP_EXCLUDED.has(name)) continue;
        if (cmd.authorized && cmd.authorized(ctx as any) !== true) continue;
        lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description ?? ''}`);
      }

      lines.push('', `> 插件版本 v${PLUGIN_VERSION}`);
      return lines.join('\n');
    },
  };
}
