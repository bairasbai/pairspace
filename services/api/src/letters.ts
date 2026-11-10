import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid } from './validation.ts';
import { normalizeMessageText } from '../../../packages/domain/chat/text.ts';
export type LetterMetadata = Readonly<{ id: string; coupleId: string; senderId: string; recipientId: string;
  clientId: string; membershipEpoch: number; createdAt: string }>;
export type Letter = LetterMetadata & Readonly<{ body: string }>;
type Failure = { ok: false; error: 'invalid_request' | 'unavailable' | 'stale_membership' | 'idempotency_conflict' };
type Result<T> = { ok: true; value: T } | Failure;
type Row = { id: string; couple_id: string; sender_id: string; recipient_id: string;
  client_letter_id: string; membership_epoch: number; created_at: string };
type BodyRow = Row & { body: string };
const columns = 'id, couple_id, sender_id, recipient_id, client_letter_id, membership_epoch, created_at::text';
const metadata = (r: Row): LetterMetadata => ({ id: r.id, coupleId: r.couple_id, senderId: r.sender_id,
  recipientId: r.recipient_id, clientId: r.client_letter_id, membershipEpoch: r.membership_epoch,
  createdAt: new Date(r.created_at).toISOString() });
const letter = (r: BodyRow): Letter => ({ ...metadata(r), body: r.body });
const fail = (error: Failure['error']): Failure => ({ ok: false, error });
type LetterScope = { coupleId: string; membershipEpoch: number; clientId?: string; body?: string; letterId?: string };
function parse(input: unknown, mode: 'send' | 'list' | 'open'): LetterScope | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const fields = input as Record<string, unknown>;
  const keys = mode === 'send' ? 'body,clientId,coupleId,membershipEpoch'
    : mode === 'open' ? 'coupleId,letterId,membershipEpoch' : 'coupleId,membershipEpoch';
  if (Object.keys(fields).sort().join(',') !== keys || !isUuid(fields.coupleId) || !isEpoch(fields.membershipEpoch)
    || (mode === 'send' && !isUuid(fields.clientId)) || (mode === 'open' && !isUuid(fields.letterId))) return null;
  // UUID spelling is not identity: canonicalize before immutable scope comparison.
  const scope = { ...fields, coupleId: fields.coupleId.toLowerCase(),
    ...(typeof fields.clientId === 'string' ? { clientId: fields.clientId.toLowerCase() } : {}),
    ...(typeof fields.letterId === 'string' ? { letterId: fields.letterId.toLowerCase() } : {}) };
  if (mode === 'send') {
    const body = normalizeMessageText(fields.body);
    if (!body.ok) return null;
    return { ...scope, body: body.text } as LetterScope;
  }
  return scope as LetterScope;
}
async function authorize(tx: SqlExecutor, principal: Principal, scope: LetterScope, write: boolean): Promise<Result<string>> {
  const pair = await tx.query<{ status: string; membership_epoch: number }>(
    `SELECT status, membership_epoch FROM couples WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`, [scope.coupleId]);
  const row = pair.rows[0];
  if (!row || row.status !== 'active') return fail('unavailable');
  const members = await tx.query<{ user_id: string }>(
    "SELECT user_id FROM couple_members WHERE couple_id=$1 AND status='active' ORDER BY user_id FOR SHARE", [scope.coupleId]);
  if (members.rows.length !== 2 || !members.rows.some(r => r.user_id === principal.userId)) return fail('unavailable');
  if (row.membership_epoch !== scope.membershipEpoch) return fail('stale_membership');
  return { ok: true, value: members.rows.find(r => r.user_id !== principal.userId)!.user_id };
}
export async function sendLetter(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ letter: Letter; replay: boolean }>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, 'send');
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    if (!await activeSession(tx, db, principal)) return fail('unavailable');
    const recipient = await authorize(tx, principal, scope, true);
    if (!recipient.ok) return recipient;
    const now = db.now();
    if (!Number.isFinite(now.getTime())) throw new Error('invalid_server_clock');
    if (!await activeSession(tx, db, principal)) return fail('unavailable');
    const previous = await tx.query<BodyRow>(`SELECT ${columns}, body FROM letters WHERE sender_id=$1 AND client_letter_id=$2`, [principal.userId, scope.clientId]);
    if (previous.rows[0]) {
      const old = previous.rows[0];
      if (old.couple_id !== scope.coupleId || old.membership_epoch !== scope.membershipEpoch
        || old.recipient_id !== recipient.value || old.body !== scope.body) return fail('idempotency_conflict');
      return { ok: true, value: { letter: letter(old), replay: true } };
    }
    const inserted = await tx.query<BodyRow>(`INSERT INTO letters(couple_id,sender_id,recipient_id,client_letter_id,membership_epoch,body,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}, body`, [scope.coupleId, principal.userId, recipient.value, scope.clientId, scope.membershipEpoch, scope.body, now]);
    return { ok: true, value: { letter: letter(inserted.rows[0]), replay: false } };
  });
}
async function read<T>(db: AuthorizedDatabase, principal: Principal, input: unknown, mode: 'list' | 'open',
  query: (tx: SqlExecutor, scope: LetterScope, partner: string) => Promise<Result<T>>): Promise<Result<T>> {
  if (!validPrincipal(principal)) return fail('unavailable');
  const scope = parse(input, mode);
  if (!scope) return fail('invalid_request');
  return db.transaction(async tx => {
    if (!await activeSession(tx, db, principal)) return fail('unavailable');
    const partner = await authorize(tx, principal, scope, false);
    if (!partner.ok) return partner;
    if (!await activeSession(tx, db, principal)) return fail('unavailable');
    return query(tx, scope, partner.value);
  });
}
export function listLetters(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ letters: LetterMetadata[] }>> {
  return read(db, principal, input, 'list', async (tx, scope, partner) => {
    const rows = await tx.query<Row>(`SELECT ${columns} FROM letters WHERE couple_id=$1 AND recipient_id=$2
      AND sender_id=$3 AND membership_epoch=$4 ORDER BY letters.created_at DESC, letters.id DESC LIMIT 30`, [scope.coupleId, principal.userId, partner, scope.membershipEpoch]);
    return { ok: true, value: { letters: rows.rows.map(metadata) } };
  });
}
export function openLetter(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ letter: Letter }>> {
  return read(db, principal, input, 'open', async (tx, scope, partner) => {
    const rows = await tx.query<BodyRow>(`SELECT ${columns}, body FROM letters WHERE couple_id=$1 AND recipient_id=$2
      AND sender_id=$3 AND membership_epoch=$4 AND id=$5`, [scope.coupleId, principal.userId, partner, scope.membershipEpoch, scope.letterId]);
    return rows.rows[0] ? { ok: true, value: { letter: letter(rows.rows[0]) } } : fail('unavailable');
  });
}
