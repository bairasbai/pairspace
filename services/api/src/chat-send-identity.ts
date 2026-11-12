import { createHash } from 'node:crypto';

type OriginalBody = { body: string | null; has_original_body_hash?: boolean; original_body_hash?: string | null };
/** Identity v1 = immutable (pair, author, client ID, plain/reply kind, parent) + SHA256(original normalized body).
 * Callers match the immutable tuple before accepting a replay. Hash is not encryption or erasure.
 * Pre-022 schemas are supported only for legacy fixture/contracts with no mutable-body edits.
 */
export function originalChatBodyMatches(row: OriginalBody, normalizedBody: string): boolean {
  if (!row.has_original_body_hash) return row.body === normalizedBody;
  return row.original_body_hash === '\\x' + createHash('sha256').update(normalizedBody).digest('hex');
}
