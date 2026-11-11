import { normalizeMessageText, type TextResult } from '../chat/text.ts';
/** Explicit shared memories are short text; never derive them from private drafts. */
export function normalizeMemoryBody(input: unknown): TextResult {
  const result = normalizeMessageText(input);
  if (!result.ok) return result;
  return Array.from(result.text).length > 2000 ? { ok: false, error: 'text_too_long' } : result;
}
