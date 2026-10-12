/**
 * SDK 中间件编排
 *
 * 根据账户配置组装 SDK 内置中间件链。
 * 中间件负责过滤和上下文富化；入站并发直接交给 OpenClaw Session Queue，
 * 最终统一由 bot.on("message") 处理转发，不持有覆盖整个 Agent Run 的锁。
 */
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import {
  messageFilter,
  contentSanitizer,
  rateLimiter,
  mentionGate,
  quoteRef,
  historyBuffer,
  envelopeFormatter,
  typingIndicator,
  slashCommand,
  errorHandler,
} from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { buildCommandList } from '../commands/index.js';
import { attachmentProcessor } from '../middleware/attachment.js';
import { assembleBody } from '../dispatch/body-assembler.js';
import { getPersistedRefIndexStore } from '../features/ref-index-store.js';
import { createPolicyInjector } from '../middleware/policy-injector.js';
import { getHistoryStore, historyGroupKey } from '../features/history-store.js';
import { dynamicAccessControl } from '../middleware/access-control.js';
import { stripMentionText } from '../utils/mention.js';
import { processingTimeout } from '../middleware/processing-timeout.js';

export interface MiddlewareSetupOptions {
  /** 获取 runtime */
  getRuntime: () => any;
}

/**
 * 为 QQBot 实例编排完整的中间件链
 */
export function setupMiddlewares(bot: QQBot, account: ResolvedQQBotAccount, opts: MiddlewareSetupOptions): void {
  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter({ skipSelfEcho: false }));

  // 3. 动态策略注入 — 每条消息注入 ctx.state.policy
  //    后续 dynamicAccessControl / mentionGate / historyBuffer 自动读取
  bot.use(createPolicyInjector(account));

  // 4. 群历史缓冲 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
  //    limit 从 ctx.state.policy.group.historyLimit 读取，key 带 accountId 前缀隔离多账号
  bot.use(historyBuffer({
    store: getHistoryStore(),
    groupKey: (ctx) => {
      const gid = ctx.message.groupOpenid;
      if (ctx.message.kind !== 'group' || !gid) return undefined;
      return historyGroupKey(account.accountId, gid);
    },
  }));

  // 5. 动态访问控制 — 从 ctx.state.policy 动态读取，支持 pairing
  bot.use(dynamicAccessControl({
    accountId: account.accountId,
    getRuntime: opts.getRuntime,
  }));

  // 6. 群聊 @bot 门控（从 ctx.state.policy.group 读取动态配置）
  bot.use(mentionGate());
  // 7. 内容清洗（去 @marker、表情标签、多余空白）
  // SDK 用 appId 匹配 @标记，但 QQ openid 不等于 appId，追加 stripMentionText 正确剥离
  bot.use(contentSanitizer({
    parseFaceTags: true,
    transform: (content, ctx) => stripMentionText(content, (ctx.message as any).mentions),
  }));

  // 8. 三层限流（sender / group / global）
  bot.use(rateLimiter());

  // 9. 插件斜杠命令：匹配后直接 reply + stop，不进入核心队列
  //    依赖：ctx.state.policy（policyInjector, #3）、ctx.message.*（原始消息）
  //    /stop、/steer 等框架级命令继续进入 OpenClaw 的入站命令路径
  const slash = slashCommand({ commands: buildCommandList(account, { getRuntime: opts.getRuntime }) });
  bot.use(slash.middleware);

  // 10. 每条请求独立计时；后续消息必须能在活跃 Run 期间到达核心 Steering 队列
  bot.use(processingTimeout(account.processingTimeoutMs));

  // 11. C2C 输入状态指示器
  bot.use(typingIndicator());

  // 12. 引用消息解析（默认优先 msg_elements 获取文件名等丰富信息）
  bot.use(quoteRef({
    store: getPersistedRefIndexStore(account.accountId),
  }));

  // 13. 附件处理（语音 STT 转录 + 图片/文件下载）
  bot.use(attachmentProcessor({ getRuntime: opts.getRuntime }));

  // 14. 上下文组装（构建框架规约的 body）
  bot.use(envelopeFormatter({
    format: (ctx) => {
      const assembled = assembleBody(ctx, ctx.message as never, account, opts.getRuntime);
      (ctx.state as Record<string, unknown>).assembledBody = assembled;
      return assembled.agentBody;
    },
  }));
}
