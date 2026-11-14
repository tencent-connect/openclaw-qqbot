/**
 * 被动回复 msg_id 失效判定。
 *
 * QQ 的被动回复 msg_id 只在 5 分钟内有效，超时或额度用尽后平台会返回
 * “请求参数msg_id无效或越权”。这种失败一定发生在消息发出之前，可以安全地
 * 去掉 msgId 重发一次（主动消息）。
 */

const INVALID_MSG_ID_RE =
  /(msg[_-]?id[^\n]{0,40}(无效|越权|过期|失效)|(无效|越权|过期|失效)[^\n]{0,20}msg[_-]?id|invalid[^\n]{0,40}msg[_-]?id|msg[_-]?id[^\n]{0,40}invalid)/i;

export function isInvalidMsgIdError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return INVALID_MSG_ID_RE.test(text);
}
