import { normalizeMessageText, type TextResult } from '../chat/text.ts';
/** Explicit reasons for sharing a song, never imported playlists or lyrics. */
export function normalizeSongExplanation(input: unknown): TextResult {
  const result = normalizeMessageText(input);
  if (!result.ok) return result;
  return Array.from(result.text).length > 2000 ? { ok: false, error: 'text_too_long' } : result;
}
