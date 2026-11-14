import { createHash } from 'node:crypto';
import { normalizeStoryTopic, normalizeStoryBody } from '../../../packages/domain/stories/text.ts';
import type { StoryMetadata } from '../../../packages/domain/stories/metadata.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { lockPair } from './pair-close.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';

type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' | 'version_conflict' | 'capacity_reached' };
type Result<T> = { ok: true; value: T } | Failure;
type Mode = 'list' | 'read' | 'order' | 'tell' | 'decline' | 'removeTopic' | 'removeStory';
type Scope = { coupleId: string; membershipEpoch: number; storyId?: string; commandId?: string; expectedVersion?: number; topic?: string; body?: string };
type Row = {
  id: string; couple_id: string; topic_author_id: string; story_author_id: string;
  membership_epoch: number; sequence: number; version: number; created_at: string;
  topic_state: StoryMetadata['topicState']; story_state: StoryMetadata['storyState'];
  topic: string | null; told_at: string | null; body?: string | null;
};
// Metadata queries deliberately do not select the narrative body.
const columns = 'id,couple_id,topic_author_id,story_author_id,membership_epoch,sequence,version,created_at::text,topic_state,story_state,topic,told_at::text';
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function now(db: AuthorizedDatabase): Date {
  const value = db.now();
  if (!Number.isFinite(value.getTime())) throw Error('invalid_story_clock');
  return value;
}
function metadata(row: Row): StoryMetadata {
  return { id: row.id, coupleId: row.couple_id, topicAuthorId: row.topic_author_id, storyAuthorId: row.story_author_id,
    membershipEpoch: row.membership_epoch, sequence: row.sequence, version: row.version,
    createdAt: new Date(row.created_at).toISOString(), topicState: row.topic_state, storyState: row.story_state,
    ...(row.topic_state === 'active' ? { topic: row.topic! } : {}),
    ...(row.told_at !== null ? { toldAt: new Date(row.told_at).toISOString() } : {}) };
}
function parse(input: unknown, mode: Mode): Scope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>, read = mode === 'list' || mode === 'read';
  const keys = ['coupleId', 'membershipEpoch', ...(mode !== 'list' && mode !== 'order' ? ['storyId'] : []),
    ...(!read ? ['commandId'] : []), ...(!read && mode !== 'order' ? ['expectedVersion'] : []),
    ...(mode === 'order' ? ['topic'] : mode === 'tell' ? ['body'] : [])];
  if (Object.keys(f).sort().join() !== keys.sort().join() || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope: Scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (mode !== 'list' && mode !== 'order') {
    if (!isUuid(f.storyId)) return null;
    scope.storyId = f.storyId.toLowerCase();
  }
  if (!read) {
    if (!isUuid(f.commandId)) return null;
    scope.commandId = f.commandId.toLowerCase();
    if (mode !== 'order') {
      if (!Number.isInteger(f.expectedVersion) || Number(f.expectedVersion) < 1 || Number(f.expectedVersion) > 2147483646) return null;
      scope.expectedVersion = Number(f.expectedVersion);
    }
  }
  if (mode === 'order') {
    const topic = normalizeStoryTopic(f.topic);
    if (topic === null) return null;
    scope.topic = topic;
  }
  if (mode === 'tell') {
    const body = normalizeStoryBody(f.body);
    if (body === null) return null;
    scope.body = body;
  }
  return scope;
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, scope: Scope): Promise<Failure | { otherId: string }> {
  const pair = await lockPair(tx, db, p, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const active = pair.members.filter(member => member.status === 'active');
  if (pair.status !== 'active' || active.length !== 2 || !active.some(member => member.user_id === p.userId)) return fail('unavailable');
  return pair.epoch !== scope.membershipEpoch ? fail('stale_membership') : { otherId: active.find(member => member.user_id !== p.userId)!.user_id };
}
const select = async (tx: SqlExecutor, scope: Scope, id: string, body = false) =>
  (await tx.query<Row>(`SELECT ${columns}${body ? ',body' : ''} FROM ordered_stories WHERE couple_id=$1 AND membership_epoch=$2 AND id=$3 FOR UPDATE`, [scope.coupleId, scope.membershipEpoch, id])).rows[0];

export async function listStories(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{ stories: StoryMetadata[]; checkedAt: string; capacity: 100; used: number }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'list');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope);
    if ('ok' in auth) return auth;
    const rows = (await tx.query<Row>(`SELECT ${columns} FROM ordered_stories WHERE couple_id=$1 AND membership_epoch=$2 ORDER BY (story_state='waiting') DESC,sequence DESC LIMIT 101`, [scope.coupleId, scope.membershipEpoch])).rows;
    if (rows.length > 100) throw Error('invalid_story_capacity');
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    return { ok: true, value: { stories: rows.map(metadata), checkedAt: now(db).toISOString(), capacity: 100, used: rows.length } };
  });
}
export async function readStory(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{ story: StoryMetadata; checkedAt: string; body?: string }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, 'read');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const auth = await authorize(tx, db, p, scope);
    if ('ok' in auth) return auth;
    const row = await select(tx, scope, scope.storyId!, true);
    if (!row || !await activeSession(tx, db, p)) return fail('unavailable');
    return { ok: true, value: { story: metadata(row), checkedAt: now(db).toISOString(), ...(row.story_state === 'told' ? { body: row.body! } : {}) } };
  });
}
export const orderStory = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'order');
export const tellStory = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'tell');
export const declineStory = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'decline');
export const removeStoryTopic = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'removeTopic');
export const removeStoryBody = (db: AuthorizedDatabase, p: Principal, input: unknown) => mutate(db, p, input, 'removeStory');
async function mutate(db: AuthorizedDatabase, p: Principal, input: unknown, mode: Exclude<Mode, 'list' | 'read'>): Promise<Result<{ story: StoryMetadata; commandId: string; replay: boolean }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  const fingerprint = createHash('sha256').update(JSON.stringify([mode, scope.coupleId, scope.membershipEpoch, scope.storyId ?? null,
    scope.expectedVersion ?? null, scope.topic ?? null, scope.body ?? null])).digest('hex');
  const revoked = new Error('story_session_ended');
  try {
    return await db.transaction(async tx => {
      const auth = await authorize(tx, db, p, scope);
      if ('ok' in auth) return auth;
      const previous = (await tx.query<{ fingerprint: string; story_id: string }>(
        'SELECT fingerprint,story_id FROM story_commands WHERE actor_user_id=$1 AND command_id=$2', [p.userId, scope.commandId])).rows[0];
      if (previous) {
        if (previous.fingerprint !== fingerprint) return fail('idempotency_conflict');
        const current = await select(tx, scope, previous.story_id);
        if (!current || !await activeSession(tx, db, p)) return fail('unavailable');
        return { ok: true, value: { story: metadata(current), commandId: scope.commandId!, replay: true } };
      }
      let current: Row;
      if (mode === 'order') {
        const used = Number((await tx.query<{ used: number }>('SELECT count(*)::int AS used FROM ordered_stories WHERE couple_id=$1 AND membership_epoch=$2', [scope.coupleId, scope.membershipEpoch])).rows[0].used);
        if (used >= 100) return fail('capacity_reached');
        if (!await activeSession(tx, db, p)) return fail('unavailable');
        const rows = (await tx.query<Row>(`INSERT INTO ordered_stories(couple_id,topic_author_id,story_author_id,membership_epoch,sequence,version,created_at,topic_state,story_state,topic)
          VALUES($1,$2,$3,$4,$5,1,$6,'active','waiting',$7) RETURNING ${columns}`, [scope.coupleId, p.userId, auth.otherId, scope.membershipEpoch, used + 1, now(db), scope.topic])).rows;
        if (rows.length !== 1) throw Error('invalid_story_write');
        current = rows[0];
      } else {
        const row = await select(tx, scope, scope.storyId!);
        if (!row || (mode === 'removeTopic' ? row.topic_author_id : row.story_author_id) !== p.userId) return fail('unavailable');
        const allowed = mode === 'removeTopic' ? row.topic_state === 'active' : mode === 'removeStory' ? row.story_state === 'told' : row.story_state === 'waiting';
        if (!allowed || row.version !== scope.expectedVersion) return fail('version_conflict');
        if (!await activeSession(tx, db, p)) return fail('unavailable');
        const topicState = mode === 'removeTopic' ? 'removed' : row.topic_state;
        const storyState = mode === 'tell' ? 'told' : mode === 'decline' ? 'declined' : mode === 'removeStory' ? 'story_removed'
          : row.story_state === 'waiting' ? 'withdrawn' : row.story_state;
        // The unchanged narrative is retained by SQL; it is never selected for a metadata mutation.
        const rows = (await tx.query<Row>(`UPDATE ordered_stories SET topic_state=$2,story_state=$3,topic=$4,
          body=CASE WHEN $5::boolean THEN $6::text WHEN $7::boolean THEN NULL ELSE body END,told_at=$8,version=version+1 WHERE id=$1 RETURNING ${columns}`,
        [row.id, topicState, storyState, mode === 'removeTopic' ? null : row.topic, mode === 'tell', scope.body ?? null, mode === 'removeStory',
          mode === 'tell' ? new Date(Math.max(now(db).getTime(), Date.parse(row.created_at))) : row.told_at])).rows;
        if (rows.length !== 1) throw Error('invalid_story_write');
        current = rows[0];
      }
      const receipt = await tx.query<{ story_id: string; fingerprint: string }>(
        'INSERT INTO story_commands(actor_user_id,command_id,couple_id,membership_epoch,story_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6) RETURNING story_id,fingerprint',
        [p.userId, scope.commandId, scope.coupleId, scope.membershipEpoch, current.id, fingerprint]);
      if (receipt.rows.length !== 1 || receipt.rows[0].story_id !== current.id || receipt.rows[0].fingerprint !== fingerprint) throw Error('invalid_story_receipt');
      if (!await activeSession(tx, db, p)) throw revoked;
      return { ok: true, value: { story: metadata(current), commandId: scope.commandId!, replay: false } };
    });
  } catch (error) {
    if (error === revoked) return fail('unavailable');
    throw error;
  }
}
