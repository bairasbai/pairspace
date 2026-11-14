/** Plain, explicitly published narrative text. No transport/storage dependencies. */
function normalize(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || value.length > limit * 4
    || /[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) return null;
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n');
  if (/\p{Cc}/u.test(text.replace(/\n/g, ''))) return null;
  const trimmed = text.trim();
  return trimmed.length > 0 && [...trimmed].length <= limit ? trimmed : null;
}
export const normalizeStoryTopic = (value: unknown) => normalize(value, 300);
export const normalizeStoryBody = (value: unknown) => normalize(value, 8000);
