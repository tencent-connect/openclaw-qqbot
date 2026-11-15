import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import { getPairingApi } from '../adapter/pairing.js';
import { checkCommandAuth } from './config-util.js';

/** /bot-pairing — DM 配对审批管理 */
export function botPairing(_getRuntime: () => PluginRuntime): SlashCommand {
  return {
    name: 'bot-pairing',
    description: '管理 DM 配对审批',
    scope: 'c2c',
    hidden: true,
    usage: `/bot-pairing approve <code>

批准指定配对码，允许对应用户私聊机器人。
配对码由用户首次私聊时自动生成。`,
    authorized: checkCommandAuth,
    handler: async (ctx) => {
      const args = (Array.isArray(ctx.command.args) ? ctx.command.args.join(' ') : String(ctx.command.args ?? '')).trim();
      const parts = args.split(/\s+/);
      const subCmd = parts[0]?.toLowerCase();
      const code = parts[1]?.trim();

      if (subCmd !== 'approve' || !code) {
        return '⚠️ 用法: /bot-pairing approve <配对码>';
      }

      const api = getPairingApi();
      if (!api) {
        return '⚠️ 当前 OpenClaw 版本不支持配对审批功能。';
      }

      try {
        const result = await api.approveCode({
          channel: 'qqbot',
          code,
        });

        if (!result?.id) {
          return [
            `⚠️ 配对码 \`${code}\` 无效或已过期。`,
            '',
            '每个配对码有效期为 1 小时。',
          ].join('\n');
        }

        return [
          '✅ 已批准用户访问。',
          '',
          `用户 ID: \`${result.id}\``,
        ].join('\n');
      } catch (err) {
        return `❌ 审批失败: ${(err as Error).message}`;
      }
    },
  };
}
