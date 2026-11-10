/** Shared task titles are plain text, never markup or analytics metadata. */
export function normalizeTaskTitle(value: unknown): { ok: true; text: string } | { ok: false } {
  if (typeof value !== 'string' || value.length > 1600) return { ok: false };
  // At most 200 valid Unicode scalars also bounds UTF-8 to 800 bytes.
  const text = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!text || [...text].length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(text)) return { ok: false };
  return { ok: true, text };
}
