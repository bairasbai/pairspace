import { normalizeSongLink } from '../../../packages/domain/songs/link.ts';
import { lockPair } from './pair-close.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { normalizeTaskTitle } from '../../../packages/domain/tasks/title.ts';
import { normalizeSongExplanation } from '../../../packages/domain/songs/text.ts';
export type SharedSong = Readonly<{ id: string; coupleId: string; creatorId: string; membershipEpoch: number;
  title: string; explanation: string; musicUrl?: string; createdAt: string; version: number }>;
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' };
type Result<T> = { ok: true; value: T } | Failure;
type Scope = { songId?: string; expectedVersion?: number; coupleId: string; membershipEpoch: number; commandId?: string; title?: string; explanation?: string; musicUrl?: string };
type Row = { id: string; couple_id: string; creator_id: string; membership_epoch: number; title: string; explanation: string; music_url: string | null; created_at: string; version: number };
type Receipt = { operation: 'create' | 'edit'; expected_version: number | null; song_id: string; couple_id: string; membership_epoch: number; title: string; explanation: string; music_url: string | null };
const columns = 'id,couple_id,creator_id,membership_epoch,title,explanation,music_url,created_at::text,version';
const song = (r: Row): SharedSong => ({ id: r.id, coupleId: r.couple_id, creatorId: r.creator_id,
  membershipEpoch: r.membership_epoch, version: r.version, title: r.title, explanation: r.explanation, ...(r.music_url === null ? {} : { musicUrl: r.music_url }), createdAt: new Date(r.created_at).toISOString() });
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function parse(input: unknown, mode: 'create' | 'edit' | 'list'): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  const keys = Object.keys(f).filter(key => key !== 'musicUrl').sort().join(',');
  const expected = mode === 'list' ? 'coupleId,membershipEpoch' : mode === 'edit'
    ? 'commandId,coupleId,expectedVersion,explanation,membershipEpoch,songId,title'
    : 'commandId,coupleId,explanation,membershipEpoch,title';
  if (keys !== expected || (mode === 'list' && 'musicUrl' in f)
    || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode === 'list') return scope;
  if (mode === 'edit') {
    if (!isUuid(f.songId) || !Number.isSafeInteger(f.expectedVersion) || (f.expectedVersion as number) < 1 || (f.expectedVersion as number) > 2147483646) return null;
    scope.songId = f.songId.toLowerCase(); scope.expectedVersion = f.expectedVersion as number;
  }
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
export const createSharedSong = (db: AuthorizedDatabase, principal: Principal, input: unknown) => mutateSharedSong(db, principal, input, 'create');
export const editSharedSong = (db: AuthorizedDatabase, principal: Principal, input: unknown) => mutateSharedSong(db, principal, input, 'edit');
async function mutateSharedSong(db: AuthorizedDatabase, principal: Principal, input: unknown, mode: 'create' | 'edit'): Promise<Result<{ song: SharedSong; commandId: string; replay: boolean }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    // The actor user lock serializes command IDs even across pairs; authorize before replay.
    const previous = (await tx.query<Receipt>(`SELECT operation,expected_version,song_id,couple_id,membership_epoch,title,explanation,music_url
      FROM shared_song_commands WHERE actor_user_id=$1 AND command_id=$2`, [principal.userId, scope.commandId])).rows[0];
    if (previous) {
      if (previous.operation !== mode || previous.expected_version !== (scope.expectedVersion ?? null)
        || (mode === 'edit' && previous.song_id !== scope.songId)
        || previous.couple_id !== scope.coupleId || previous.membership_epoch !== scope.membershipEpoch || previous.title !== scope.title
        || previous.explanation !== scope.explanation || (previous.music_url ?? undefined) !== scope.musicUrl) return fail('idempotency_conflict');
      const current = (await tx.query<Row>(`SELECT ${columns} FROM shared_songs WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3`,
        [scope.coupleId, scope.membershipEpoch, previous.song_id])).rows[0];
      return current ? { ok: true, value: { song: song(current), commandId: scope.commandId!, replay: true } } : fail('unavailable');
    }
    const now = db.now();
    if (!Number.isFinite(now.getTime())) throw new Error('invalid_server_clock');
    let row: Row;
    if (mode === 'edit') {
      const existing = (await tx.query<Row>(`SELECT ${columns} FROM shared_songs WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`,
        [scope.coupleId, scope.membershipEpoch, scope.songId])).rows[0];
      if (!existing || existing.creator_id !== principal.userId) return fail('unavailable');
      if (existing.version !== scope.expectedVersion) return fail('version_conflict');
      row = (await tx.query<Row>(`UPDATE shared_songs SET title=$4,explanation=$5,music_url=$6,version=version+1
        WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 AND version=$7 RETURNING ${columns}`,
        [scope.coupleId, scope.membershipEpoch, scope.songId, scope.title, scope.explanation, scope.musicUrl ?? null, scope.expectedVersion])).rows[0];
    } else row = (await tx.query<Row>(`INSERT INTO shared_songs(couple_id,creator_id,membership_epoch,command_id,title,explanation,created_at,music_url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,
      [scope.coupleId, principal.userId, scope.membershipEpoch, scope.commandId, scope.title, scope.explanation, now, scope.musicUrl ?? null])).rows[0];
    await tx.query(`INSERT INTO shared_song_commands(actor_user_id,command_id,couple_id,membership_epoch,song_id,title,explanation,music_url,operation,expected_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [principal.userId, scope.commandId, scope.coupleId, scope.membershipEpoch,
      row.id, scope.title, scope.explanation, scope.musicUrl ?? null, mode, scope.expectedVersion ?? null]);
    return { ok: true, value: { song: song(row), commandId: scope.commandId!, replay: false } };
  });
}
export async function listSharedSongs(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ songs: SharedSong[]; limit: 50 }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, 'list');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, principal, scope);
    if (denied) return denied;
    const rows = await tx.query<Row>(`SELECT ${columns} FROM shared_songs WHERE couple_id=$1 AND membership_epoch=$2
      ORDER BY created_at DESC,id DESC LIMIT 50`, [scope.coupleId, scope.membershipEpoch]);
    return { ok: true, value: { songs: rows.rows.map(song), limit: 50 } };
  });
}
