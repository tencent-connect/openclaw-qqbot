import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import { updateAccountConfig, checkCommandAuth } from './config-util.js';

/** /bot-group-always — 修改群消息默认响应模式 */
export function botGroupAlways(account: ResolvedQQBotAccount, getRuntime: () => PluginRuntime): SlashCommand {
  return {
    name: ['bot-group-always', 'bot-group-allways'],
    description: '修改群消息默认响应模式',
    scope: 'c2c',
    authorized: checkCommandAuth,
    usage: [
      '/bot-group-always on   AI 自主判断何时发言（无需 @）',
      '/bot-group-always off  仅在被 @ 时回复',
      '/bot-group-always      查看当前设置',
      '',
      '设为 on 后，AI 会自主判断每条消息是否需要回复（无需 @）。',
      '仍可通过 groups.{groupId}.requireMention 对单个群覆盖。',
    ].join('\n'),
    handler: async (ctx) => {
      const arg = (Array.isArray(ctx.command.args) ? ctx.command.args.join(' ') : String(ctx.command.args ?? '')).trim().toLowerCase();
      const currentRequireMention = account.config.defaultRequireMention ?? true;

      // 无参数 → 查看状态
      if (!arg) {
        return [
          `🤖 群自主发言状态：${currentRequireMention ? '❌ 仅被 @ 时回复' : '✅ 自主判断何时发言'}`,
          `使用 <qqbot-cmd-input text="/bot-group-always on" show="/bot-group-always on"/> 设为自主发言`,
          `使用 <qqbot-cmd-input text="/bot-group-always off" show="/bot-group-always off"/> 设为仅被 @ 时回复`,
        ].join('\n');
      }

      if (arg !== 'on' && arg !== 'off') {
        return '❌ 参数错误，请使用 on 或 off\n\n示例：/bot-group-always on';
      }

      // on = 自主发言 (requireMention=false), off = 仅被 @ (requireMention=true)
      const newRequireMention = arg === 'off';

      if (newRequireMention === currentRequireMention) {
        return `🤖 群自主发言已经是"${arg}"状态，无需操作`;
      }

      const error = await updateAccountConfig(account, getRuntime, (acfg) => {
        (acfg as any).defaultRequireMention = newRequireMention;
      });
      if (error) return error;

      // 更新内存中的配置
      account.config.defaultRequireMention = newRequireMention;

      return [
        `✅ 群自主发言已设置为 ${newRequireMention ? '**off**（仅被 @ 时回复）' : '**on**（AI 自主判断何时发言）'}`,
        '',
        newRequireMention
          ? '仅在被 @ 机器人才会回复。'
          : 'AI 将自主判断群消息是否需要回复，无需被 @ 即可发言。',
      ].join('\n');
    },
  };
}
