/**
 * 凭证暂存与恢复
 *
 * 解决热更新被打断时 openclaw.json 中 appId/secret 丢失的问题。
 *
 * 存储路径：~/.openclaw/qqbot/data/credential-backup/current.json
 * 使用子目录避免被框架 SQLite 迁移扫描（迁移只匹配 data/credential-backup.json）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getQQBotDataDir } from '../utils/platform.js';

const BACKUP_DIR = 'credential-backup';
const BACKUP_FILENAME = 'current.json';
const LEGACY_FILENAME = 'credential-backup.json';

interface CredentialBackup {
  accountId: string;
  appId: string;
  clientSecret: string;
  savedAt: string;
}

function getBackupPath(): string {
  return path.join(getQQBotDataDir('data'), BACKUP_DIR, BACKUP_FILENAME);
}

/**
 * 保存凭证快照到暂存文件（gateway 成功启动后调用）
 */
export function saveCredentialBackup(accountId: string, appId: string, clientSecret: string): void {
  if (!appId || !clientSecret) return;
  try {
    const backupPath = getBackupPath();
    const dir = path.dirname(backupPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: CredentialBackup = {
      accountId,
      appId,
      clientSecret,
      savedAt: new Date().toISOString(),
    };
    const tmpPath = backupPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, backupPath);
  } catch {
    // 非关键操作，静默忽略
  }
}

/**
 * 从暂存文件读取凭证（仅在配置为空时调用）
 * 返回 null 表示无可用备份
 */
export function loadCredentialBackup(accountId?: string): CredentialBackup | null {
  try {
    // 优先读新路径
    const backupPath = getBackupPath();
    if (fs.existsSync(backupPath)) {
      const data = readBackupFile(backupPath, accountId);
      if (data) return data;
    }
    // 兼容旧路径（升级过渡）
    const legacyPath = path.join(getQQBotDataDir('data'), LEGACY_FILENAME);
    if (fs.existsSync(legacyPath)) {
      return readBackupFile(legacyPath, accountId);
    }
    return null;
  } catch {
    return null;
  }
}

function readBackupFile(filePath: string, accountId?: string): CredentialBackup | null {
  const raw = fs.readFileSync(filePath, 'utf8');
  const data: CredentialBackup = JSON.parse(raw);
  if (!data.appId || !data.clientSecret) return null;
  if (accountId && data.accountId !== accountId) return null;
  return data;
}
