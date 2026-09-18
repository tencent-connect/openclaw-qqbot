/**
 * 状态目录解析测试
 *
 * 验证插件尊重 OPENCLAW_STATE_DIR(及历史名称),不再硬编码 ~/.openclaw。
 * 对应 issue #266:自定义状态目录部署下,插件仍往 ~/.openclaw 散落目录,
 * 触发 doctor 的 "Multiple state directories detected" 告警。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getOpenClawStateDir, getQQBotDataDir, getQQBotMediaDir } from '../src/utils/platform.js';

// ── fixture:临时状态目录 + 环境变量保存/恢复 ──

const STATE_DIR_KEYS = ['OPENCLAW_STATE_DIR', 'CLAWDBOT_STATE_DIR', 'MOLTBOT_STATE_DIR'];
const savedEnv: Record<string, string | undefined> = {};
let tmpStateDir = '';

beforeEach(() => {
  for (const key of STATE_DIR_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-state-'));
});

afterEach(() => {
  for (const key of STATE_DIR_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
});

// ── 测试 ──

describe('getOpenClawStateDir', () => {
  it('OPENCLAW_STATE_DIR 优先', () => {
    process.env.OPENCLAW_STATE_DIR = tmpStateDir;
    expect(getOpenClawStateDir()).toBe(path.resolve(tmpStateDir));
  });

  it('回退到历史名称 CLAWDBOT_STATE_DIR', () => {
    process.env.CLAWDBOT_STATE_DIR = tmpStateDir;
    expect(getOpenClawStateDir()).toBe(path.resolve(tmpStateDir));
  });

  it('回退到历史名称 MOLTBOT_STATE_DIR', () => {
    process.env.MOLTBOT_STATE_DIR = tmpStateDir;
    expect(getOpenClawStateDir()).toBe(path.resolve(tmpStateDir));
  });

  it('OPENCLAW_STATE_DIR 优先于历史名称', () => {
    process.env.OPENCLAW_STATE_DIR = tmpStateDir;
    process.env.CLAWDBOT_STATE_DIR = path.join(tmpStateDir, 'other');
    expect(getOpenClawStateDir()).toBe(path.resolve(tmpStateDir));
  });

  it('环境变量值两侧空白被剥离', () => {
    process.env.OPENCLAW_STATE_DIR = `  ${tmpStateDir}  `;
    expect(getOpenClawStateDir()).toBe(path.resolve(tmpStateDir));
  });

  it('未设置时回退到 ~/.openclaw', () => {
    expect(getOpenClawStateDir()).toBe(path.join(os.homedir(), '.openclaw'));
  });
});

describe('getQQBotDataDir / getQQBotMediaDir 跟随状态目录', () => {
  it('数据目录落在 OPENCLAW_STATE_DIR 下并自动创建', () => {
    process.env.OPENCLAW_STATE_DIR = tmpStateDir;
    const dir = getQQBotDataDir('sessions');
    expect(dir).toBe(path.join(tmpStateDir, 'qqbot', 'sessions'));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('媒体目录落在 OPENCLAW_STATE_DIR/media 下并自动创建', () => {
    process.env.OPENCLAW_STATE_DIR = tmpStateDir;
    const dir = getQQBotMediaDir('img');
    expect(dir).toBe(path.join(tmpStateDir, 'media', 'qqbot', 'img'));
    expect(fs.existsSync(dir)).toBe(true);
  });
});
