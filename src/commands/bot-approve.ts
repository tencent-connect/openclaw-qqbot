import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import { getAdapters } from '../adapter/resolve.js';
import { updateGlobalConfig, checkCommandAuth } from './config-util.js';

/** 审批预设配置 */
const PRESETS: Record<string, { security: string; ask: string; desc: string }> = {
  on: { security: 'allowlist', ask: 'on-miss', desc: '开启审批（白名单模式）' },
  off: { security: 'full', ask: 'off', desc: '关闭审批' },
  always: { security: 'allowlist', ask: 'always', desc: '严格模式（每次都审批）' },
};

/** 格式化当前审批状态 */
function formatStatus(security: string, ask: string): string {
  const secIcon = security === 'full' ? '🟢' : security === 'allowlist' ? '🟡' : '🔴';
  const askIcon = ask === 'off' ? '🟢' : ask === 'always' ? '🔴' : '🟡';
  const desc =
    security === 'deny' ? '⚠️ 当前为 deny 模式，所有命令执行被拒绝' :
    security === 'full' && ask === 'off' ? '✅ 所有命令无需审批直接执行' :
    security === 'allowlist' && ask === 'on-miss' ? '🛡️ 白名单命令直接执行，其余需审批' :
    ask === 'always' ? '🔒 每次命令执行都需要人工审批' :
    `ℹ️ security=${security}, ask=${ask}`;

  return [
    '🔐 当前审批配置',
    '',
    `${secIcon} 安全模式 (security): **${security}**`,
    `${askIcon} 审批模式 (ask): **${ask}**`,
    '',
    desc,
  ].join('\n');
}

/** 操作指引菜单 */
function menuText(): string {
  return [
    '🔐 命令执行审批配置',
    '',
    '<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（白名单模式）',
    '<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批',
    '<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式',
    '<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认',
    '<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置',
  ].join('\n');
}

/** /bot-approve — 管理命令执行审批配置 */
export function botApprove(getRuntime: () => PluginRuntime): SlashCommand {
  return {
    name: 'bot-approve',
    description: '管理命令执行审批配置',
    scope: 'c2c',
    authorized: checkCommandAuth,
    usage: [
      '/bot-approve            查看操作指引',
      '/bot-approve on         开启审批（白名单模式，推荐）',
      '/bot-approve off        关闭审批，命令直接执行',
      '/bot-approve always     始终审批，每次执行都需审批',
      '/bot-approve reset      恢复框架默认值',
      '/bot-approve status     查看当前审批配置',
    ].join('\n'),
    handler: async (ctx) => {
      const arg = (Array.isArray(ctx.command.args) ? ctx.command.args.join(' ') : String(ctx.command.args ?? '')).trim().toLowerCase();
      const runtime = getRuntime();

      if (!runtime) {
        return '⚠️ runtime 不可用，无法管理审批配置。';
      }

      const adapters = getAdapters(runtime);

      const loadExecConfig = () => {
        const cfg = adapters.getConfig?.() ?? {};
        const tools = (cfg as any).tools ?? {};
        const exec = tools.exec ?? {};
        return {
          security: String(exec.security ?? 'deny'),
          ask: String(exec.ask ?? 'on-miss'),
        };
      };

      // 无参数 → 操作指引
      if (!arg) {
        return menuText();
      }

      // status → 查看当前配置
      if (arg === 'status') {
        const { security, ask } = loadExecConfig();
        return [
          formatStatus(security, ask),
          '',
          '<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批',
          '<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批',
          '<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式',
          '<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认',
        ].join('\n');
      }

      // on / off / always → 写入预设
      const preset = PRESETS[arg];
      if (preset) {
        const error = await updateGlobalConfig(getRuntime, (cfg: any) => {
          cfg.tools ??= {};
          cfg.tools.exec ??= {};
          cfg.tools.exec.security = preset.security;
          cfg.tools.exec.ask = preset.ask;
        });
        if (error) return error;

        if (arg === 'on') {
          return ['✅ 审批已开启', '', '• security = allowlist', '• ask = on-miss', '', '已批准的命令自动加入白名单，下次直接执行。'].join('\n');
        }
        if (arg === 'off') {
          return ['✅ 审批已关闭', '', '• security = full', '• ask = off', '', '⚠️ 所有命令将直接执行，不会弹出审批确认。'].join('\n');
        }
        return ['✅ 已切换为严格审批模式', '', '• security = allowlist', '• ask = always', '', '每个命令都会弹出审批按钮，需手动确认。'].join('\n');
      }

      // reset → 删除 tools.exec.security 和 tools.exec.ask
      if (arg === 'reset') {
        const error = await updateGlobalConfig(getRuntime, (cfg: any) => {
          const exec = cfg.tools?.exec;
          if (exec) {
            delete exec.security;
            delete exec.ask;
            if (Object.keys(exec).length === 0) delete cfg.tools.exec;
            if (cfg.tools && Object.keys(cfg.tools).length === 0) delete cfg.tools;
          }
        });
        if (error) return error;

        return ['✅ 审批配置已重置', '', '已移除 tools.exec.security 和 tools.exec.ask', '框架将使用默认值（security=deny, ask=on-miss）', '', '如需开启命令执行，请使用 /bot-approve on'].join('\n');
      }

      return [
        `❌ 未知参数: ${arg}`,
        '',
        '可用选项: on | off | always | reset | status',
      ].join('\n');
    },
  };
}
