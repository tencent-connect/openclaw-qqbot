import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { getPackageVersion } from '../utils/pkg-version.js';
import { getUpdateInfo } from '../features/update-checker.js';
import { getOpenClawVersion } from '../bot-instance.js';

const PLUGIN_VERSION = getPackageVersion();
const GITHUB_URL = 'https://github.com/tencent-connect/openclaw-qqbot';

/** /bot-version — 查看插件版本号 */
export function botVersion(_account: ResolvedQQBotAccount): SlashCommand {
  return {
    name: 'bot-version',
    description: '查看插件版本号',
    usage: [
      '/bot-version',
      '',
      '查看当前 QQBot 插件版本和 OpenClaw 框架版本。',
      '同时检查是否有新版本可用。',
    ].join('\n'),
    handler: async () => {
      const frameworkVersion = getOpenClawVersion();
      const lines = [
        `🦞框架版本：${frameworkVersion}`,
        `🤖QQBot 插件版本：v${PLUGIN_VERSION}`,
      ];

      const info = await getUpdateInfo();
      if (info.checkedAt === 0) {
        lines.push('⏳ 版本检查中...');
      } else if (info.error) {
        lines.push('⚠️ 版本检查失败');
      } else if (info.hasUpdate && info.latest) {
        lines.push(`🆕最新可用版本：v${info.latest}，点击 <qqbot-cmd-input text="/bot-upgrade" show="/bot-upgrade"/> 查看升级指引`);
      }

      lines.push(`🌟官方 GitHub 仓库：[点击前往](${GITHUB_URL})`);
      return lines.join('\n');
    },
  };
}
