export type TextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: 'invalid_text' | 'empty_text' | 'text_too_long' };

function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return false;
  }
  return true;
}

/** No trimming of meaningful whitespace; canonical line endings and NFC before counting. */
export function normalizeMessageText(input: unknown): TextResult {
  if (typeof input !== 'string' || input.includes('\u0000') || !wellFormed(input)) return { ok: false, error: 'invalid_text' };
  const text = input.replace(/\r\n?/g, '\n').normalize('NFC');
  if (!text.trim()) return { ok: false, error: 'empty_text' };
  if (Array.from(text).length > 8000) return { ok: false, error: 'text_too_long' };
  return { ok: true, text };
}
