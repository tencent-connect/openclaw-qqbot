/**
 * 请求级上下文（基于 AsyncLocalStorage）
 *
 * 解决并发消息下工具获取当前会话信息的竞态问题。
 * gateway 在处理每条入站消息时通过 runWithRequestContext() 建立作用域，
 * 作用域内的所有异步代码（包括 AI agent 调用、tool execute）
 * 都能通过 getRequestContext() 安全地拿到当前请求的上下文。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** 投递目标地址，如 qqbot:c2c:xxx 或 qqbot:group:xxx */
  target: string;
  /** 当前请求的 QQBot 账户 ID（多账户场景） */
  accountId?: string;
  /** 当前消息 ID */
  messageId?: string;
  /** 发送者 open_id */
  openId?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

/**
 * 在请求级作用域中执行回调
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return asyncLocalStorage.run(ctx, fn);
}

/**
 * 获取当前请求的上下文
 */
export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * 获取当前请求的投递目标地址
 */
export function getRequestTarget(): string | undefined {
  return asyncLocalStorage.getStore()?.target;
}

/**
 * 获取当前请求的账户 ID
 */
export function getRequestAccountId(): string | undefined {
  return asyncLocalStorage.getStore()?.accountId;
}
