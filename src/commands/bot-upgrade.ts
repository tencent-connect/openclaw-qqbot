import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { getPackageVersion } from '../utils/pkg-version.js';
import { getUpdateInfo } from '../features/update-checker.js';
import { checkCommandAuth } from './config-util.js';

const PLUGIN_VERSION = getPackageVersion();
const DEFAULT_UPGRADE_URL = 'https://docs.qq.com/doc/DSGxOZk1oVnVKVkpq';
const GITHUB_URL = 'https://github.com/tencent-connect/openclaw-qqbot';

/** /bot-upgrade — 检查更新并查看升级指引 */
export function botUpgrade(account: ResolvedQQBotAccount): SlashCommand {
  return {
    name: 'bot-upgrade',
    description: '检查更新并查看升级指引',
    scope: 'c2c',
    authorized: checkCommandAuth,
    usage: [
      '/bot-upgrade              检查是否有新版本',
    ].join('\n'),
    handler: async () => {
      const url = account.config.upgradeUrl ?? DEFAULT_UPGRADE_URL;
      const info = await getUpdateInfo();

      if (info.checkedAt === 0) {
        return '⏳ 版本检查中，请稍后再试';
      }

      if (info.error) {
        return [
          '❌ 主机网络访问异常，无法检查更新',
          '',
          `查看升级指引：[点击查看](${url})`,
        ].join('\n');
      }

      if (!info.hasUpdate) {
        return [
          `✅ 当前已是最新版本 v${PLUGIN_VERSION}`,
          '',
          `项目地址：[GitHub](${GITHUB_URL})`,
        ].join('\n');
      }

      return [
        '🆕 发现新版本',
        '',
        `当前版本：**v${PLUGIN_VERSION}**`,
        `最新版本：**v${info.latest}**`,
        '',
        `📖 升级指引：[点击查看](${url})`,
        `🌟 官方 GitHub 仓库：[点击前往](${GITHUB_URL})`,
      ].join('\n');
    },
  };
}
