/**
 * Runtime Adapter — 隔离 OpenClaw 框架 API 变更对插件核心逻辑的冲击。
 *
 * 所有 `runtime.channel.*` / `runtime.config.*` 访问 **必须** 经由本模块导出的函数。
 * 禁止在 adapter/ 外直接使用 `(runtime as any).channel.*`。
 *
 * 设计原则：
 *   1. Capability Probe — 按候选 API 路径探测，兼容多版本框架
 *   2. Contract Check — 启动时校验必需 API 可用性，fail-fast 暴露问题
 *   3. 单一 resolve 入口 — 一次 resolve，全程复用缓存
 */

export { verifyRuntimeContract, type ContractResult } from './contract.js';
export { resolveRuntimeAdapters, getAdapters, type RuntimeAdapters } from './resolve.js';
export { loadApprovalGatewayRuntime, type ApprovalGatewayClient } from './gateway.js';
