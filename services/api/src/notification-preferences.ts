import { lockPair } from './pair-close.ts';
import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { defaultNotificationFields, evaluateNotificationPolicy, isNotificationCategory, parseNotificationFields,
  type NotificationFields, type NotificationCategory, type NotificationDecision } from '../../../packages/domain/notifications/preferences.ts';
export type NotificationPreferences = NotificationFields & Readonly<{ coupleId: string; userId: string; membershipEpoch: number; version: number; preview: 'generic' }>;
type Scope = { coupleId: string; membershipEpoch: number };
type Command = Scope & NotificationFields & { commandId: string; expectedVersion: number };
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'version_conflict' | 'idempotency_conflict' };
type Result<T> = { ok: true; value: T } | Failure;
type Row = { couple_id: string; user_id: string; membership_epoch: number; version: number;
  care: boolean; chat: boolean; letter: boolean; quiet_start: string | null; quiet_end: string | null; timezone: string | null };
type Receipt = { couple_id: string; membership_epoch: number; expected_version: number; fingerprint: string };
const columns = 'couple_id,user_id,membership_epoch,version,care,chat,letter,quiet_start,quiet_end,timezone';
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
function parse(input: unknown, save: boolean): Scope | Command | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const f = input as Record<string, unknown>;
  if (Object.keys(f).sort().join(',') !== (save ? 'care,chat,commandId,coupleId,expectedVersion,letter,membershipEpoch,quiet' : 'coupleId,membershipEpoch')
    || !isUuid(f.coupleId) || !isEpoch(f.membershipEpoch)) return null;
  const scope = { coupleId: f.coupleId.toLowerCase(), membershipEpoch: f.membershipEpoch };
  if (!save) return scope;
  const fields = parseNotificationFields({ care: f.care, chat: f.chat, letter: f.letter, quiet: f.quiet });
  if (!fields || !isUuid(f.commandId) || !Number.isSafeInteger(f.expectedVersion)
    || (f.expectedVersion as number) < 0 || (f.expectedVersion as number) > 2147483646) return null;
  return { ...scope, ...fields, commandId: f.commandId.toLowerCase(), expectedVersion: f.expectedVersion as number };
}
function resource(row: Row | undefined, scope: Scope, userId: string): NotificationPreferences {
  return { coupleId: scope.coupleId, userId, membershipEpoch: scope.membershipEpoch, version: row?.version ?? 0, preview: 'generic',
    ...(row ? { care: row.care, chat: row.chat, letter: row.letter,
      quiet: row.quiet_start === null ? null : { start: row.quiet_start, end: row.quiet_end!, timezone: row.timezone! } } : defaultNotificationFields) };
}
function now(db: AuthorizedDatabase): Date {
  const date = db.now();
  if (!Number.isFinite(date.getTime())) throw Error('invalid_server_clock');
  return date;
}
async function authorize(tx: SqlExecutor, db: AuthorizedDatabase, p: Principal, scope: Scope): Promise<Failure | null> {
  const pair = await lockPair(tx, db, p, scope.coupleId);
  if (typeof pair === 'string') return fail('unavailable');
  const active = pair.members.filter(m => m.status === 'active');
  if (pair.status !== 'active' || active.length !== 2 || !active.some(m => m.user_id === p.userId)) return fail('unavailable');
  return pair.epoch === scope.membershipEpoch ? null : fail('stale_membership');
}
async function read(tx: SqlExecutor, scope: Scope, userId: string): Promise<Row | undefined> {
  return (await tx.query<Row>(`SELECT ${columns} FROM notification_preferences WHERE couple_id=$1 AND membership_epoch=$2 AND user_id=$3`, [scope.coupleId, scope.membershipEpoch, userId])).rows[0];
}
export async function getNotificationPreferences(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{ preferences: NotificationPreferences; asOf: string }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const scope = parse(input, false);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, p, scope);
    if (denied) return denied;
    return { ok: true, value: { preferences: resource(await read(tx, scope, p.userId), scope, p.userId), asOf: now(db).toISOString() } };
  });
}
export async function previewNotificationPreferences(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<NotificationDecision & { category: NotificationCategory; asOf: string; preferenceVersion: number; simulationOnly: true }>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_request');
  const f = input as Record<string, unknown>;
  if (Object.keys(f).sort().join(',') !== 'category,coupleId,membershipEpoch' || !isNotificationCategory(f.category)) return fail('invalid_request');
  const category = f.category, scope = parse({ coupleId: f.coupleId, membershipEpoch: f.membershipEpoch }, false);
  if (!scope) return fail('invalid_request');
  if (!validPrincipal(p)) return fail('unavailable');
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, p, scope);
    if (denied) return denied;
    const preferences = resource(await read(tx, scope, p.userId), scope, p.userId), checked = now(db);
    return { ok: true, value: { ...evaluateNotificationPolicy(preferences, category, checked), category,
      asOf: checked.toISOString(), preferenceVersion: preferences.version, simulationOnly: true } };
  });
}
export async function saveNotificationPreferences(db: AuthorizedDatabase, p: Principal, input: unknown): Promise<Result<{ preferences: NotificationPreferences; asOf: string; commandId: string; replay: boolean }>> {
  if (!validPrincipal(p)) return fail('unavailable');
  const parsed = parse(input, true);
  if (!parsed) return fail('invalid_request');
  const c = parsed as Command;
  const fingerprint = JSON.stringify({ care: c.care, chat: c.chat, letter: c.letter, quiet: c.quiet });
  return db.transaction(async tx => {
    const denied = await authorize(tx, db, p, c);
    if (denied) return denied;
    await tx.query('SELECT user_id FROM notification_preferences WHERE couple_id=$1 AND membership_epoch=$2 AND user_id=$3 FOR UPDATE', [c.coupleId, c.membershipEpoch, p.userId]);
    if (!await activeSession(tx, db, p)) return fail('unavailable');
    if (c.quiet && !(await tx.query('SELECT name FROM pg_timezone_names WHERE name=$1', [c.quiet.timezone])).rows.length) return fail('invalid_request');
    const previous = (await tx.query<Receipt>('SELECT couple_id,membership_epoch,expected_version,fingerprint FROM notification_preference_commands WHERE actor_user_id=$1 AND command_id=$2', [p.userId, c.commandId])).rows[0];
    const current = await read(tx, c, p.userId);
    if (previous) {
      if (previous.couple_id !== c.coupleId || previous.membership_epoch !== c.membershipEpoch || previous.expected_version !== c.expectedVersion || previous.fingerprint !== fingerprint) return fail('idempotency_conflict');
      return current ? { ok: true, value: { preferences: resource(current,c,p.userId), asOf: now(db).toISOString(), commandId: c.commandId, replay: true } } : fail('unavailable');
    }
    if ((current?.version ?? 0) !== c.expectedVersion) return fail('version_conflict');
    const old = resource(current,c,p.userId);
    const unchanged = current && old.care === c.care && old.chat === c.chat && old.letter === c.letter && JSON.stringify(old.quiet) === JSON.stringify(c.quiet);
    const args = [c.coupleId, c.membershipEpoch, p.userId, c.care, c.chat, c.letter, c.quiet?.start ?? null, c.quiet?.end ?? null, c.quiet?.timezone ?? null];
    const row = unchanged ? current : current
      ? (await tx.query<Row>(`UPDATE notification_preferences SET care=$4,chat=$5,letter=$6,quiet_start=$7,quiet_end=$8,timezone=$9,version=version+1 WHERE couple_id=$1 AND membership_epoch=$2 AND user_id=$3 RETURNING ${columns}`, args)).rows[0]
      : (await tx.query<Row>(`INSERT INTO notification_preferences(couple_id,membership_epoch,user_id,care,chat,letter,quiet_start,quiet_end,timezone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${columns}`, args)).rows[0];
    await tx.query('INSERT INTO notification_preference_commands(actor_user_id,command_id,couple_id,membership_epoch,expected_version,fingerprint) VALUES($1,$2,$3,$4,$5,$6)', [p.userId,c.commandId,c.coupleId,c.membershipEpoch,c.expectedVersion,fingerprint]);
    return { ok: true, value: { preferences: resource(row,c,p.userId), asOf: now(db).toISOString(), commandId: c.commandId, replay: false } };
  });
}
