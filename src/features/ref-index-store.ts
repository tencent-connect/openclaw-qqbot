/**
 * 持久化 RefIndex 存储
 *
 * SDK 提供的 MemoryRefIndexStore 在进程重启后即丢失，
 * 而 QQ 引用消息（REFIDX_xxx）入站事件只携带 key，必须本地缓存才能回查。
 *
 * 设计：
 *   - 内存 LRU（与 SDK 同款）保证 O(1) 读取
 *   - JSONL 追加写持久化，进程重启时按时间顺序回放重建 LRU
 *   - 写入触发 compact 阈值时重写文件（去重 + 截断到 maxEntries）
 *   - 文件路径: ~/.openclaw/qqbot/data/ref-index.jsonl
 *
 * 实现 SDK 的 RefIndexStore 接口，可直接通过 `quoteRef({ store })` 注入。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RefEntry, RefIndexStore } from '@tencent-connect/qqbot-nodejs';
import { getQQBotDataDir } from '../utils/platform.js';
import { createPluginLogger } from '../utils/plugin-logger.js';
const log = createPluginLogger({ prefix: '[ref-index]' });


// ── 常量 ──

const DEFAULT_MAX_ENTRIES = 50000;
const DEFAULT_FILENAME = 'ref-index.jsonl';
/** 当磁盘 line 数超过 maxEntries * COMPACT_RATIO 时触发 compact */
const COMPACT_RATIO = 2;
/** 内存 LRU 的最小容量保护值 */
const MIN_MAX_ENTRIES = 100;

// ── 磁盘行结构 ──

interface DiskLine {
  /** RefIndex 键，例如 REFIDX_xxx 或 messageId */
  k: string;
  /** RefEntry 内容 */
  v: RefEntry;
  /** 写入时间戳（毫秒） */
  t: number;
}

// ── 持久化 Store ──

export interface PersistedRefIndexStoreOptions {
  /** 内存与磁盘的最大条目数。默认 2000。 */
  maxEntries?: number;
  /** 自定义存储文件路径。默认 ~/.openclaw/qqbot/data/ref-index.jsonl */
  filePath?: string;
}

/**
 * 持久化版本的 RefIndexStore
 *
 * - get：仅查内存（启动时从磁盘回放重建）
 * - set：内存 + JSONL 追加写；磁盘行数过多时触发 compact
 */
export class PersistedRefIndexStore implements RefIndexStore {
  private readonly memory = new Map<string, RefEntry>();
  private readonly maxEntries: number;
  private readonly filePath: string;
  /** 当前磁盘累计写入的行数（用于 compact 阈值判断） */
  private diskLineCount = 0;
  /** 是否已成功初始化（磁盘回放完成） */
  private initialized = false;
  /** 串行化写入，防止并发 append 撕裂行 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: PersistedRefIndexStoreOptions = {}) {
    this.maxEntries = Math.max(options.maxEntries ?? DEFAULT_MAX_ENTRIES, MIN_MAX_ENTRIES);
    this.filePath = options.filePath ?? path.join(getQQBotDataDir('data'), DEFAULT_FILENAME);
    this.init();
  }

  /**
   * 初始化：按时间顺序回放 JSONL 重建内存 LRU
   */
  private init(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.initialized = true;
        return;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      this.diskLineCount = lines.length;

      // 按时间排序回放（防止文件被外部修改后乱序）
      const parsed: DiskLine[] = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as DiskLine;
          if (obj?.k && obj?.v) {
            parsed.push(obj);
          }
        } catch {
          // 跳过损坏行
        }
      }
      parsed.sort((a, b) => a.t - b.t);

      for (const { k, v } of parsed) {
        this.touchMemory(k, v);
      }

      // 启动时若磁盘行数已超阈值，立刻 compact 一次
      if (this.diskLineCount > this.maxEntries * COMPACT_RATIO) {
        this.compactSync();
      }
    } catch (err) {
      log.error(
        `init failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.initialized = true;
    }
  }

  // ── RefIndexStore 接口 ──

  get(key: string): RefEntry | undefined {
    return this.memory.get(key);
  }

  set(key: string, entry: RefEntry): void {
    this.touchMemory(key, entry);
    // 追加写持久化（串行化）
    this.writeChain = this.writeChain.then(() => this.appendToDisk(key, entry));
  }

  // ── 内部：内存 LRU 维护 ──

  private touchMemory(key: string, entry: RefEntry): void {
    // 已存在则先删除再插入，保证插入顺序 = LRU 顺序
    if (this.memory.has(key)) {
      this.memory.delete(key);
    } else if (this.memory.size >= this.maxEntries) {
      // 容量已满 → 淘汰最旧的（Map 的迭代顺序即插入顺序）
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) {
        this.memory.delete(oldest);
      }
    }
    this.memory.set(key, entry);
  }

  // ── 内部：磁盘追加 + compact ──

  private async appendToDisk(key: string, entry: RefEntry): Promise<void> {
    const line: DiskLine = { k: key, v: entry, t: Date.now() };
    const text = JSON.stringify(line) + '\n';
    try {
      await fs.promises.appendFile(this.filePath, text, 'utf8');
      this.diskLineCount += 1;
      if (this.diskLineCount > this.maxEntries * COMPACT_RATIO) {
        await this.compact();
      }
    } catch (err) {
      log.error(
        `append failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 异步 compact：将内存 LRU 状态完整重写到磁盘，丢弃历史冗余。
   */
  private async compact(): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    try {
      const now = Date.now();
      // Map 迭代顺序 = 插入顺序（旧 → 新），保持 LRU 顺序
      const lines: string[] = [];
      for (const [k, v] of this.memory.entries()) {
        lines.push(JSON.stringify({ k, v, t: now } satisfies DiskLine));
      }
      const content = lines.length > 0 ? lines.join('\n') + '\n' : '';
      await fs.promises.writeFile(tmpPath, content, 'utf8');
      await fs.promises.rename(tmpPath, this.filePath);
      this.diskLineCount = lines.length;
      log.info(
        `compacted to ${lines.length} entries`,
      );
    } catch (err) {
      log.error(
        `compact failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 清理可能残留的 tmp 文件
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // ignore
      }
    }
  }

  /**
   * 同步 compact（仅 init 阶段使用，避免回放后立刻保留巨大磁盘文件）
   */
  private compactSync(): void {
    const tmpPath = `${this.filePath}.tmp`;
    try {
      const now = Date.now();
      const lines: string[] = [];
      for (const [k, v] of this.memory.entries()) {
        lines.push(JSON.stringify({ k, v, t: now } satisfies DiskLine));
      }
      const content = lines.length > 0 ? lines.join('\n') + '\n' : '';
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, this.filePath);
      this.diskLineCount = lines.length;
    } catch (err) {
      log.error(
        `compactSync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 诊断 ──

  /** 当前内存中的条目数 */
  get size(): number {
    return this.memory.size;
  }

  /** 是否已完成初始化（磁盘回放） */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** 诊断快照 */
  stats(): {
    memoryEntries: number;
    diskLines: number;
    maxEntries: number;
    filePath: string;
  } {
    return {
      memoryEntries: this.memory.size,
      diskLines: this.diskLineCount,
      maxEntries: this.maxEntries,
      filePath: this.filePath,
    };
  }

  /**
   * 强制将当前内存状态持久化到磁盘（进程退出前调用）
   */
  flush(): void {
    this.compactSync();
  }
}

// ── 默认单例（按 accountId 隔离） ──

const stores = new Map<string, PersistedRefIndexStore>();

/**
 * 获取按 accountId 隔离的持久化 RefIndexStore 单例。
 *
 * 每个账户独立存储文件，避免多账户混用同一个 refIdx 命名空间。
 */

export function getPersistedRefIndexStore(accountId: string): PersistedRefIndexStore {
  let store = stores.get(accountId);
  if (!store) {
    const filePath = path.join(getQQBotDataDir('data', accountId), DEFAULT_FILENAME);
    store = new PersistedRefIndexStore({ filePath });
    stores.set(accountId, store);
  }
  return store;
}

/**
 * 进程退出前 flush 所有 store
 */
export function flushAllRefIndexStores(): void {
  for (const store of stores.values()) {
    store.flush();
  }
}
