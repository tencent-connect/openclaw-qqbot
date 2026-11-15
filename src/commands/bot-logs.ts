import type { SlashCommand } from '@tencent-connect/qqbot-nodejs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { getQQBotMediaDir } from '../utils/platform.js';
import { checkCommandAuth } from './config-util.js';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import { getAdapters } from '../adapter/resolve.js';


const MAX_LINES_PER_FILE = 1000;
const MAX_FILES = 4;
const LOG_KEYWORDS = ['gateway', 'openclaw', 'clawdbot', 'moltbot'];
const LOG_PATTERN = new RegExp(LOG_KEYWORDS.join('|'), 'i');

interface LogFileEntry {
  filePath: string;
  sourceDir: string;
  mtime: number;
}

// ── 配置日志路径 ──

/** 从 openclaw.json logging.file 提取配置的日志文件路径 */
function getConfiguredLogFiles(runtime: PluginRuntime): string[] {
  const files: string[] = [];
  try {
    const cfg = getAdapters(runtime).getConfig?.() ?? {};
    const logFile = (cfg as any)?.logging?.file;
    if (typeof logFile === 'string') {
      files.push(path.resolve(logFile));
    }
  } catch { /* config unavailable */ }
  return files;
}

// ── 候选目录收集 ──

function collectCandidateLogDirs(runtime: PluginRuntime): string[] {
  const homeDir = os.homedir();
  const dirs = new Set<string>();
  const pushDir = (p: string | undefined | null) => {
    if (!p) return;
    try { dirs.add(path.resolve(p)); } catch { /* skip */ }
  };
  const pushStateDir = (stateDir: string) => {
    if (!stateDir) return;
    pushDir(stateDir);
    pushDir(path.join(stateDir, 'logs'));
  };

  // 0. 从配置 logging.file 提取目录（最精确）
  for (const logFile of getConfiguredLogFiles(runtime)) {
    pushDir(path.dirname(logFile));
  }

  // 1. *_STATE_DIR 环境变量
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/STATE_DIR$/i.test(key) && /(OPENCLAW|CLAWDBOT|MOLTBOT)/i.test(key)) {
      pushStateDir(value);
    }
  }

  // 2. 常见状态目录
  for (const name of LOG_KEYWORDS) {
    pushDir(path.join(homeDir, `.${name}`));
    pushDir(path.join(homeDir, `.${name}`, 'logs'));
    pushDir(path.join(homeDir, name));
    pushDir(path.join(homeDir, name, 'logs'));
  }

  // 3. home/cwd/AppData 下包含产品名的子目录
  const searchRoots = new Set([homeDir, process.cwd(), path.dirname(process.cwd())]);
  if (process.env.APPDATA) searchRoots.add(process.env.APPDATA);
  if (process.env.LOCALAPPDATA) searchRoots.add(process.env.LOCALAPPDATA);
  for (const root of searchRoots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const re = LOG_PATTERN;
        if (!re.test(entry.name)) continue;
        const base = path.join(root, entry.name);
        pushDir(base);
        pushDir(path.join(base, 'logs'));
      }
    } catch { /* skip */ }
  }

  // 4. /var/log (Linux)
  if (process.platform !== 'win32') {
    for (const name of LOG_KEYWORDS) {
      pushDir(path.join('/var/log', name));
    }
  }

  // 5. /tmp
  if (process.platform === 'win32') {
    pushDir('C:\\tmp');
    if (process.env.TEMP) pushDir(process.env.TEMP);
    if (process.env.TMP) pushDir(process.env.TMP);
    if (process.env.LOCALAPPDATA) pushDir(path.join(process.env.LOCALAPPDATA, 'Temp'));
  } else {
    pushDir('/tmp');
  }
  for (const name of LOG_KEYWORDS) {
    pushDir(path.join('/tmp', name));
    if (process.platform === 'win32' && process.env.TEMP) {
      pushDir(path.join(process.env.TEMP, name));
    }
  }

  // PM2
  const pm2Home = process.env.PM2_HOME ?? path.join(homeDir, '.pm2');
  pushDir(path.join(pm2Home, 'logs'));

  return Array.from(dirs);
}

// ── 日志文件收集 ──

function collectRecentLogFiles(logDirs: string[], runtime: PluginRuntime): LogFileEntry[] {
  const candidates: LogFileEntry[] = [];
  const dedupe = new Set<string>();

  const pushFile = (filePath: string, sourceDir: string) => {
    const normalized = path.resolve(filePath);
    if (dedupe.has(normalized)) return;
    try {
      const stat = fs.statSync(normalized);
      if (!stat.isFile() || stat.size === 0) return;
      dedupe.add(normalized);
      candidates.push({ filePath: normalized, sourceDir, mtime: stat.mtimeMs });
    } catch { /* skip */ }
  };

  // 配置指定的日志文件（最高优先级）
  for (const logFile of getConfiguredLogFiles(runtime)) {
    pushFile(logFile, path.dirname(logFile));
  }

  for (const dir of logDirs) {
    // 知名文件名
    for (const name of ['gateway.log', 'gateway.err.log', 'openclaw.log', 'clawdbot.log', 'moltbot.log']) {
      pushFile(path.join(dir, name), dir);
    }
    // 扫描所有 .log/.txt，按关键词过滤
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(log|txt)$/i.test(entry.name)) continue;
        const re = LOG_PATTERN;
        if (!re.test(entry.name)) continue;
        pushFile(path.join(dir, entry.name), dir);
      }
    } catch { /* skip */ }
  }

  return candidates.sort((a, b) => b.mtime - a.mtime);
}

// ── 命令 ──

/** /bot-logs — 导出本地日志文件 */
export function botLogs(runtime: PluginRuntime): SlashCommand {
  return {
    name: 'bot-logs',
    description: '导出本地日志文件',
    scope: 'c2c',
    authorized: checkCommandAuth,
    usage: [
      '/bot-logs',
      '',
      `导出最近的 OpenClaw 日志文件（最多 ${MAX_FILES} 个）。`,
      `每个文件最多保留最后 ${MAX_LINES_PER_FILE} 行，以文件形式返回。`,
    ].join('\n'),
    handler: async (ctx) => {
      const logDirs = collectCandidateLogDirs(runtime);
      const recentFiles = collectRecentLogFiles(logDirs, runtime).slice(0, MAX_FILES);

      if (recentFiles.length === 0) {
        const existingDirs = logDirs.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
        const searched = existingDirs.length > 0
          ? existingDirs.map((d) => `  • ${d}`).join('\n')
          : logDirs.map((d) => `  • ${d}`).join('\n');
        return [
          '⚠️ 未找到日志文件',
          '',
          '已搜索以下路径：',
          searched,
        ].join('\n');
      }

      const lines: string[] = [];
      let totalIncluded = 0;
      let totalOriginal = 0;
      let truncatedCount = 0;

      for (const logFile of recentFiles) {
        try {
          const content = fs.readFileSync(logFile.filePath, 'utf8');
          const allLines = content.split('\n');
          const tail = allLines.slice(-MAX_LINES_PER_FILE);
          if (tail.length > 0) {
            const fileName = path.basename(logFile.filePath);
            lines.push(`\n== ${fileName} (last ${tail.length}/${allLines.length}) ==`);
            lines.push(...tail);
            totalIncluded += tail.length;
            totalOriginal += allLines.length;
            if (allLines.length > MAX_LINES_PER_FILE) truncatedCount++;
          }
        } catch { /* skip */ }
      }

      if (lines.length === 0) {
        return '⚠️ 找到日志文件但读取失败';
      }

      const tmpDir = getQQBotMediaDir('exports');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const suffix = crypto.randomBytes(4).toString('hex');
      const tmpFile = path.join(tmpDir, `bot-logs-${timestamp}-${suffix}.txt`);
      fs.writeFileSync(tmpFile, lines.join('\n'), 'utf8');

      let summary = `${recentFiles.length} 个日志文件，共 ${totalIncluded} 行`;
      if (truncatedCount > 0) summary += `（${truncatedCount} 个截断，原始 ${totalOriginal} 行）`;

      try {
        const senderId = ctx.message.senderId;
        if (senderId) {
          await ctx.bot.sendFile(
            { scope: 'c2c', targetId: senderId, msgId: ctx.message.messageId },
            { localPath: tmpFile },
            { fileName: `bot-logs-${timestamp}-${suffix}.txt` },
          );
        }
      } catch (err) {
        return `📋 ${summary}\n⚠️ 文件发送失败：${err instanceof Error ? err.message : err}\n📎 ${tmpFile}`;
      }

      return `📋 ${summary}`;
    },
  };
}
