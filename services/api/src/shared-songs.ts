import { normalizeSongLink } from '../../../packages/domain/songs/link.ts';
import { lockPair } from './pair-close.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { normalizeTaskTitle } from '../../../packages/domain/tasks/title.ts';
import { normalizeSongExplanation } from '../../../packages/domain/songs/text.ts';
export type SharedSong = Readonly<{ id: string; coupleId: string; creatorId: string; membershipEpoch: number;
  title: string; explanation: string; musicUrl?: string; createdAt: string }>;
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' };
type Result<T> = { ok: true; value: T } | Failure;
type Scope = { coupleId: string; membershipEpoch: number; commandId?: string; title?: string; explanation?: string; musicUrl?: string };
type Row = { id: string; couple_id: string; creator_id: string; membership_epoch: number; title: string; explanation: string; music_url: string | null; created_at: string };
type Receipt = Row & { command_id: string };
const columns = 'id,couple_id,creator_id,membership_epoch,title,explanation,music_url,created_at::text';
const song = (r: Row): SharedSong => ({ id: r.id, coupleId: r.couple_id, creatorId: r.creator_id,
  membershipEpoch: r.membership_epoch, title: r.title, explanation: r.explanation, ...(r.music_url === null ? {} : { musicUrl: r.music_url }), createdAt: new Date(r.created_at).toISOString() });
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function parse(input: unknown, write: boolean): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  const keys = Object.keys(f).sort().join(',');
  if (!(write ? ['commandId,coupleId,explanation,membershipEpoch,title', 'commandId,coupleId,explanation,membershipEpoch,musicUrl,title'].includes(keys) : keys === 'coupleId,membershipEpoch')
    || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (!write) return scope;
  if (!isUuid(f.commandId)) return null;
  const title = normalizeTaskTitle(f.title), explanation = normalizeSongExplanation(f.explanation);
  const link = normalizeSongLink(f.musicUrl);
  if (!link.ok) return null;
  return title.ok && explanation.ok ? { ...scope, commandId: f.commandId.toLowerCase(), title: title.text, explanation: explanation.text, ...(link.url === undefined ? {} : { musicUrl: link.url }) } : null;
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, principal: Principal, scope: Scope): Promise<Failure | null> {
  const pair = await lockPair(tx, db, principal, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const active = pair.members.filter(row => row.status === 'active');
  if (pair.status !== 'active' || active.length !== 2 || !active.some(row => row.user_id === principal.userId)) return fail('unavailable');
  return pair.epoch === scope.membershipEpoch ? null : fail('stale_membership');
}
export async function createSharedSong(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ song: SharedSong; commandId: string; replay: boolean }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, true);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    // The actor user lock serializes command IDs even across pairs; authorize before replay.
    const previous = (await tx.query<Receipt>(`SELECT ${columns},command_id FROM shared_songs WHERE creator_id=$1 AND command_id=$2`, [principal.userId, scope.commandId])).rows[0];
    if (previous) {
      if (previous.couple_id !== scope.coupleId || previous.membership_epoch !== scope.membershipEpoch || previous.title !== scope.title
        || previous.explanation !== scope.explanation || (previous.music_url ?? undefined) !== scope.musicUrl) return fail('idempotency_conflict');
      return { ok: true, value: { song: song(previous), commandId: scope.commandId!, replay: true } };
    }
    const now = db.now();
    if (!Number.isFinite(now.getTime())) throw new Error('invalid_server_clock');
    const row = (await tx.query<Row>(`INSERT INTO shared_songs(couple_id,creator_id,membership_epoch,command_id,title,explanation,created_at,music_url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,
      [scope.coupleId, principal.userId, scope.membershipEpoch, scope.commandId, scope.title, scope.explanation, now, scope.musicUrl ?? null])).rows[0];
    return { ok: true, value: { song: song(row), commandId: scope.commandId!, replay: false } };
  });
}
export async function listSharedSongs(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ songs: SharedSong[]; limit: 50 }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, false);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    const rows = await tx.query<Row>(`SELECT ${columns} FROM shared_songs WHERE couple_id=$1 AND membership_epoch=$2
      ORDER BY created_at DESC,id DESC LIMIT 50`, [scope.coupleId, scope.membershipEpoch]);
    return { ok: true, value: { songs: rows.rows.map(song), limit: 50 } };
  });
}
