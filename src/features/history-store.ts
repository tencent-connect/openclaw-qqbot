import { MemoryHistoryStore } from '@tencent-connect/qqbot-nodejs';
import type { HistoryStore } from '@tencent-connect/qqbot-nodejs';

let _store: HistoryStore | null = null;

export function getHistoryStore(): HistoryStore {
  if (!_store) _store = new MemoryHistoryStore();
  return _store;
}

/** 用 accountId 前缀隔离多账号，避免同群历史串用 */
export function historyGroupKey(accountId: string, groupId: string): string {
  return `${accountId}:${groupId}`;
}

/** 清空群历史（dispatch 完成后调用） */
export function clearGroupHistory(accountId: string, groupId: string): void {
  _store?.clear?.(historyGroupKey(accountId, groupId));
}
