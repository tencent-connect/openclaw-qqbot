const LOG_TEXT_PREVIEW_MAX = 200;

/** Compact single-line ` text="..."` suffix for outbound debug logs. */
export function formatLogTextPreview(text: string, maxChars = LOG_TEXT_PREVIEW_MAX): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const clipped = collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}...` : collapsed;
  return ` text=${JSON.stringify(clipped)}`;
}
