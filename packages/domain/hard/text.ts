/** Independent plain authored question; no UI, storage or transport dependency. */
export function normalizeHardText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8000
    || /[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) return null;
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n');
  if (/\p{Cc}/u.test(normalized.replace(/\n/g, ''))) return null;
  const text = normalized.trim();
  return text.length > 0 && [...text].length <= 2000 ? text : null;
}
