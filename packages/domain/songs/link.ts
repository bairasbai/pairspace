/** Exact HTTPS public hosts, ASCII paths only. No URL parsing, fetching or safety promise.
 * Query/fragment/tracking links must be removed by the user, never silently rewritten. */
export function normalizeSongLink(input: unknown):
  { ok: true; url: string | undefined } | { ok: false } {
  if (input === undefined) return { ok: true, url: undefined };
  if (typeof input !== 'string' || input.length > 512) return { ok: false };
  const match = /^https:\/\/(open\.spotify\.com|music\.apple\.com|www\.youtube\.com|youtu\.be|music\.yandex\.ru)\/[A-Za-z0-9/_-]+$/.exec(input);
  return match?.[0] === input ? { ok: true, url: input } : { ok: false };
}
