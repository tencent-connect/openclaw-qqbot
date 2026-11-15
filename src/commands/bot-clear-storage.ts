import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkCommandAuth } from './config-util.js';
import { getQQBotMediaDir } from '../utils/platform.js';

const MAX_DISPLAY = 10;

interface FileEntry {
  filePath: string;
  size: number;
}

/** 递归扫描目录下所有文件，按大小降序 */
function scanFiles(dirPath: string): FileEntry[] {
  const files: FileEntry[] = [];
  if (!fs.existsSync(dirPath)) return files;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); }
      else if (entry.isFile()) {
        try { files.push({ filePath: full, size: fs.statSync(full).size }); } catch { /* skip */ }
      }
    }
  };
  walk(dirPath);
  return files.sort((a, b) => b.size - a.size);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** /bot-clear-storage — 清理下载文件（两步：扫描 → --force 删除） */
export function botClearStorage(_account: ResolvedQQBotAccount): SlashCommand {
  const targetDir = getQQBotMediaDir('downloads');
  const displayDir = targetDir.replace(os.homedir(), '~');

  return {
    name: 'bot-clear-storage',
    description: '清理通过QQBot对话产生的文件以及下载的资源',
    scope: 'c2c',
    authorized: checkCommandAuth,
    usage: [
      '/bot-clear-storage',
      '',
      '扫描当前机器人产生的下载文件并列出明细。',
      '确认后执行删除，释放主机磁盘空间。',
      '',
      '/bot-clear-storage --force   确认执行清理',
      '',
      '⚠️ 仅在私聊中可用。',
    ].join('\n'),
    handler: (ctx) => {
      const isForce = ctx.command.raw?.trim() === '--force';

      if (!isForce) {
        // ── 第一步：扫描并展示 ──
        const files = scanFiles(targetDir);
        if (files.length === 0) {
          return `✅ 当前没有需要清理的文件\n\n目录 \`${displayDir}\` 为空或不存在。`;
        }

        const totalSize = files.reduce((s, f) => s + f.size, 0);
        const lines = [
          `即将清理 \`${displayDir}\` 下所有文件，共 ${files.length} 个，占用 ${formatSize(totalSize)}。`,
          '',
          `文件概况：`,
        ];

        for (const f of files.slice(0, MAX_DISPLAY)) {
          const rel = path.relative(targetDir, f.filePath).replace(/\\/g, '/');
          lines.push(`  ${rel} (${formatSize(f.size)})`);
        }
        if (files.length > MAX_DISPLAY) {
          lines.push(`  ...共 ${files.length} 个文件 (${formatSize(totalSize)})`);
        }

        lines.push('', '---', '', '确认清理后文件将永久删除，后续 AI 无法找回。', '‼️ <qqbot-cmd-enter text="/bot-clear-storage --force" />');
        return lines.join('\n');
      }

      // ── 第二步：--force 执行删除 ──
      const files = scanFiles(targetDir);
      if (files.length === 0) {
        return '✅ 没有需要清理的文件。';
      }

      let deleted = 0;
      let failed = 0;
      for (const f of files) {
        try { fs.unlinkSync(f.filePath); deleted++; } catch { failed++; }
      }

      const parts = [`🗑️ 已删除 ${deleted} 个文件`];
      if (failed > 0) parts.push(`，${failed} 个失败`);
      parts.push(`\n📁 \`${displayDir}\``);

      // 清理空目录
      try { fs.rmdirSync(targetDir); } catch { /* not empty */ }

      return parts.join('');
    },
  };
}
