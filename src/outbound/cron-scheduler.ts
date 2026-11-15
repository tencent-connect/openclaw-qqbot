/**
 * Cron 定时消息
 *
 * 当 AI 输出 `QQBOT_PAYLOAD: { "type": "cron_reminder", "cron": "...", "text": "..." }`
 * 时，注册一个定时任务在指定时间向用户发送提醒消息。
 *
 * 使用 setTimeout 实现（适合单次/短期提醒），不依赖外部调度库。
 * 复杂 cron 表达式场景需要用户自行接入 node-cron 等库。
 */

export interface CronReminderPayload {
  /** 提醒文本 */
  text: string;
  /** 触发时间：ISO 8601 字符串 或 Unix ms 或 "in Xm/Xh/Xd" 相对格式 */
  at?: string | number;
  /** cron 表达式（暂不支持，仅做记录） */
  cron?: string;
  /** 发送目标 */
  target?: string;
}

export interface ScheduledReminder {
  id: string;
  text: string;
  target: string;
  triggerAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

type SendFn = (target: string, text: string) => Promise<void>;

/**
 * 定时消息调度器
 */
export class CronScheduler {
  private reminders = new Map<string, ScheduledReminder>();
  private nextId = 0;

  constructor(private readonly send: SendFn) {}

  /**
   * 注册一个定时提醒
   */
  schedule(payload: CronReminderPayload, defaultTarget: string): { id: string; triggerAt: number; confirmText: string } {
    const id = `reminder_${++this.nextId}`;
    const target = payload.target ?? defaultTarget;
    const triggerAt = resolveTriggerTime(payload.at);
    const delayMs = Math.max(0, triggerAt - Date.now());
    const text = payload.text?.trim() ?? '定时提醒';

    const reminder: ScheduledReminder = {
      id,
      text,
      target,
      triggerAt,
    };

    // 如果延迟小于 24 小时，直接 setTimeout；否则只记录不调度
    const MAX_TIMEOUT = 24 * 60 * 60 * 1000; // 24h
    if (delayMs <= MAX_TIMEOUT) {
      reminder.timer = setTimeout(async () => {
        this.reminders.delete(id);
        try {
          await this.send(target, `⏰ ${text}`);
        } catch { /* swallow */ }
      }, delayMs);
    }

    this.reminders.set(id, reminder);

    const when = new Date(triggerAt);
    const confirmText = `✅ Reminder scheduled for ${when.toLocaleString()}: "${text}"`;
    return { id, triggerAt, confirmText };
  }

  /**
   * 取消一个提醒
   */
  cancel(id: string): boolean {
    const reminder = this.reminders.get(id);
    if (!reminder) return false;
    if (reminder.timer) clearTimeout(reminder.timer);
    this.reminders.delete(id);
    return true;
  }

  /**
   * 清除所有提醒
   */
  clear(): void {
    for (const [, r] of this.reminders) {
      if (r.timer) clearTimeout(r.timer);
    }
    this.reminders.clear();
  }

  /**
   * 获取所有待触发的提醒
   */
  listPending(): ScheduledReminder[] {
    return [...this.reminders.values()];
  }
}

// ── 时间解析 ──

function resolveTriggerTime(at: string | number | undefined): number {
  if (!at) return Date.now() + 60_000; // 默认 1 分钟后

  if (typeof at === 'number') return at;

  // ISO 8601
  const dateMs = new Date(at).getTime();
  if (!Number.isNaN(dateMs)) return dateMs;

  // 相对格式: "in 5m", "in 2h", "in 1d"
  const relMatch = at.match(/^(?:in\s+)?(\d+)\s*(m|min|h|hour|d|day|s|sec)/i);
  if (relMatch) {
    const val = Number(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const multiplier =
      unit.startsWith('s') ? 1000 :
      unit.startsWith('m') ? 60_000 :
      unit.startsWith('h') ? 3600_000 :
      unit.startsWith('d') ? 86400_000 : 60_000;
    return Date.now() + val * multiplier;
  }

  return Date.now() + 60_000;
}
