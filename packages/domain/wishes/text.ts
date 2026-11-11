/** Optional plain shared context, never a secret surprise or automatic publication. */
export function normalizeWishExplanation(input: unknown): { ok: true; text: string } | { ok: false } {
  if (typeof input !== 'string' || input.length > 1200) return { ok: false };
  const text = input.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if ([...text].length > 600 || /[\p{Cf}\p{Cs}]/u.test(text) || /[\p{Cc}]/u.test(text.replace(/\n/g, ''))) return { ok: false };
  return { ok: true, text };
}
