import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';

/** /bot-ping — 测试当前 openclaw 与 QQ 连接的网络延迟 */
export function botPing(): SlashCommand {
  return {
    name: 'bot-ping',
    description: '测试当前 openclaw 与 QQ 连接的网络延迟',
    usage: [
      '/bot-ping',
      '',
      '测试 OpenClaw 主机与 QQ 服务器之间的网络延迟。',
      '返回网络传输耗时和插件处理耗时。',
    ].join('\n'),
    handler: (ctx) => {
      const now = Date.now();
      const ts = (ctx.message as any).timestamp;
      const eventTime = ts ? new Date(ts).getTime() : NaN;
      if (isNaN(eventTime)) {
        return '✅ pong!';
      }
      const totalMs = now - eventTime;
      const qqToPlugin = ctx.receivedAt - eventTime;
      const pluginProcess = now - ctx.receivedAt;
      return [
        '✅ pong！',
        '',
        `⏱ 延迟: ${totalMs}ms`,
        `  ├ 网络传输: ${qqToPlugin}ms`,
        `  └ 插件处理: ${pluginProcess}ms`,
      ].join('\n');
    },
  };
}
