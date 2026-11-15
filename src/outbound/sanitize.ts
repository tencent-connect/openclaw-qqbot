/**
 * QQBot 文本消毒
 *
 * 剥离框架内部脚手架标签（system-reminder、thinking、reasoning 等），
 * 保留 Markdown/HTML 用于 QQ Bot Markdown 渲染。
 */

const INTERNAL_TAGS = [
  // 框架脚手架标签
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<previous_response\b[^>]*>[\s\S]*?<\/previous_response>/gi,
  /<\s*\/?\s*(?:system-reminder|previous_response)\b[^>]*\/?\s*>/gi,
  // 模型推理/思考内容
  // deepseek: `think`...`/think` — 匹配完整标签块，标签名 think 必须完整
  // 格式说明：deepseek 用 `` ` `` (反引号) 替代 XML 的 `<` `>` 作为标签定界符
  //   `think`  ≡ <think>  开标签
  //   `/think` ≡ </think> 闭标签
  /`think`[\s\S]*?`\/think`/gi,
  /<\s*\/?\s*think\b[^>]*\/?\s*>/gi,
  // claude: <thinking>...</thinking>
  /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi,
  /<\s*\/?\s*thinking\b[^>]*\/?\s*>/gi,
];

/** 剥离内部运行时脚手架块 + 模型推理内容 */
export function sanitizeQQBotText(text: string): string {
  let result = text;
  for (const re of INTERNAL_TAGS) {
    result = result.replace(re, '');
  }
  return result.trim();
}
