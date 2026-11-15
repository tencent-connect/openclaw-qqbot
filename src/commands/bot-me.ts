import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';

/** /bot-me — 查看发送者 OpenID（仅私聊） */
export function botMe(): SlashCommand {
  return {
    name: 'bot-me',
    description: '查看你的 OpenID（仅私聊）',
    usage: `/bot-me

查看你在当前 QQBot 应用下的唯一 OpenID。
此 ID 用于管理员识别、访问控制等场景。`,
    scope: 'c2c',
    handler: (ctx) => {
      const senderId = ctx.message.senderId ?? 'unknown';
      return `🆔 你的 OpenID: \`${senderId}\``;
    },
  };
}
