/**
 * SDK MiddlewareState 类型扩展
 *
 * 通过 TypeScript module augmentation 为 SDK 的 MiddlewareState 添加
 * 中间件填充的 well-known keys 类型声明。
 *
 * 这些字段由 SDK 内置中间件 / 项目自定义中间件填充：
 * - envelope:              envelopeFormatter 中间件 → 组装后的 agentBody（字符串）
 * - assembledBody:         envelopeFormatter format 注入函数 → 完整 AssembledBody 缓存
 * - history:               historyBuffer 中间件 → 群历史消息列表
 * - quote:                 quoteRef 中间件 → 引用消息信息
 * - mention:               mentionGate 中间件 → @bot 判定结果
 * - command:               slashCommand 中间件 → 解析的命令
 * - processedAttachments:  attachmentProcessor 中间件 → 语音 STT、图片 URL
 */
import '@tencent-connect/qqbot-nodejs';
import type { AssembledBody } from './dispatch/body-assembler.js';
import type { ProcessedAttachments } from './middleware/attachment.js';

declare module '@tencent-connect/qqbot-nodejs' {
  interface MiddlewareState {
    /** envelopeFormatter 输出的字符串（默认 = AssembledBody.agentBody） */
    envelope?: string;
    /** 项目自定义 format 注入的完整组装结果（dispatch 阶段直接消费） */
    assembledBody?: AssembledBody;
    /** historyBuffer 填充的群历史 */
    history?: Array<{
      role: string;
      content: string;
      senderId?: string;
      senderName?: string;
      timestamp?: number;
    }>;
    /** quoteRef 解析的引用信息 */
    quote?: {
      content: string;
      senderId: string;
      attachments?: unknown[];
      messageId?: string;
    };
    /** mentionGate 判定结果 */
    mention?: {
      wasMentioned: boolean;
      stripped?: string;
    };
    /** slashCommand 解析的命令（命令被匹配时存在） */
    command?: {
      name: string;
      args: string;
    };
    /** attachmentProcessor 处理的附件结果 */
    processedAttachments?: ProcessedAttachments;
  }
}
