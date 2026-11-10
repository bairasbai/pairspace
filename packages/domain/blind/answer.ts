export function normalizeAnswer(value: unknown): { ok: true; text: string } | { ok: false } {
  if (typeof value !== 'string' || value.length > 8000) return { ok: false };
  const text = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  // 1,000 valid Unicode scalars bound UTF-8 to 4,000 bytes.
  if (!text || [...text].length > 1000 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(text)) return { ok: false };
  return { ok: true, text };
}
