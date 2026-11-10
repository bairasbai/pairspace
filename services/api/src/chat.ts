import { canClose, lockPair, mutateClosedPair } from './pair-close.ts';
import type { ApiError, AuthorizedDatabase, Message, Principal, Result, SqlExecutor } from './contracts.ts';
import { activeSession, validPrincipal } from './session.ts';
import { isEpoch, isUuid, parseHistory, parseSend } from './validation.ts';

const columns = `id, couple_id, sender_id, client_message_id, seq::text AS seq, body, version, created_at::text AS created_at`;
type Row = { id: string; couple_id: string; sender_id: string; client_message_id: string; seq: string; body: string; version: number; created_at: string };
const message = (row: Row): Message => ({ id: row.id, coupleId: row.couple_id, senderId: row.sender_id,
  clientId: row.client_message_id, seq: Number(row.seq), body: row.body, version: row.version, createdAt: row.created_at });
const denied = <T>(error: ApiError): Result<T> => ({ ok: false, error });

/** Same couple lock is used by send and close. Do not replace it with a client-side membership check. */
async function authorize(tx: SqlExecutor, principal: Principal, coupleId: string, epoch: number, write: boolean): Promise<ApiError | null> {
  const result = await tx.query<{ status: string; membership_epoch: number }>(`
    SELECT status, membership_epoch FROM couples WHERE id = $1
    FOR ${write ? 'UPDATE' : 'SHARE'}`, [coupleId]);
  const row = result.rows[0];
  if (!row || row.status !== 'active') return 'unavailable';
  // Separate statement after acquiring the lock: READ COMMITTED gets a fresh membership snapshot.
  const membership = await tx.query<{ status: string }>(`
    SELECT status FROM couple_members WHERE couple_id = $1 AND user_id = $2`, [coupleId, principal.userId]);
  if (membership.rows[0]?.status !== 'active') return 'unavailable';
  if (row.membership_epoch !== epoch) return 'stale_membership';
  return null;
}

export async function sendMessage(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ message: Message; replay: boolean }>> {
  if (!validPrincipal(principal)) return denied('unavailable');
  const command = parseSend(input);
  if (!command.ok) return command;
  const { coupleId, clientId, membershipEpoch, body } = command.value;
  return db.transaction(async tx => {
    if (!await activeSession(tx, db, principal)) return denied('unavailable');
    const authorization = await authorize(tx, principal, coupleId, membershipEpoch, true);
    if (authorization) return denied(authorization);
    if (!await activeSession(tx, db, principal)) return denied('unavailable');
    const existing = await tx.query<Row>(`SELECT ${columns} FROM chat_messages
      WHERE couple_id = $1 AND sender_id = $2 AND client_message_id = $3`, [coupleId, principal.userId, clientId]);
    if (existing.rows.length) {
      if (existing.rows[0].body !== body) return denied('idempotency_conflict');
      return { ok: true, value: { message: message(existing.rows[0]), replay: true } };
    }
    const sequence = await tx.query<{ seq: string }>(`UPDATE couples SET next_chat_seq = next_chat_seq + 1
      WHERE id = $1 RETURNING (next_chat_seq - 1)::text AS seq`, [coupleId]);
    const inserted = await tx.query<Row>(`INSERT INTO chat_messages(couple_id, sender_id, client_message_id, seq, body)
      VALUES ($1, $2, $3, $4, $5) RETURNING ${columns}`, [coupleId, principal.userId, clientId, sequence.rows[0].seq, body]);
    const created = inserted.rows[0];
    await tx.query(`INSERT INTO outbox_events(couple_id, type, message_id) VALUES ($1, 'chat.message_created', $2)`, [coupleId, created.id]);
    return { ok: true, value: { message: message(created), replay: false } };
  });
}

export async function readHistory(db: AuthorizedDatabase, principal: Principal, input: unknown): Promise<Result<{ messages: Message[]; nextBeforeSeq: number | null }>> {
  if (!validPrincipal(principal)) return denied('unavailable');
  const command = parseHistory(input);
  if (!command.ok) return command;
  const { coupleId, membershipEpoch, beforeSeq, limit } = command.value;
  return db.transaction(async tx => {
    if (!await activeSession(tx, db, principal)) return denied('unavailable');
    const authorization = await authorize(tx, principal, coupleId, membershipEpoch, false);
    if (authorization) return denied(authorization);
    if (!await activeSession(tx, db, principal)) return denied('unavailable');
    const result = await tx.query<Row>(`SELECT ${columns} FROM chat_messages WHERE couple_id = $1
      AND ($2::bigint IS NULL OR seq < $2) ORDER BY chat_messages.seq DESC LIMIT $3`, [coupleId, beforeSeq ?? null, limit + 1]);
    const page = result.rows.slice(0, limit).map(message);
    const nextBeforeSeq = result.rows.length > limit ? page[page.length - 1].seq : null;
    return { ok: true, value: { messages: page.reverse(), nextBeforeSeq } };
  });
}

/** Stops future interaction only; never deletes the archive or implements a retention policy. */
export async function closeCouple(db: AuthorizedDatabase, principal: Principal, coupleId: unknown, membershipEpoch: unknown): Promise<Result<null>> {
  if (!validPrincipal(principal)) return denied('unavailable');
  if (!isUuid(coupleId) || !isEpoch(membershipEpoch)) return denied('invalid_request');
  return db.transaction(async tx => {
    const pair = await lockPair(tx, db, principal, coupleId.toLowerCase());
    if (typeof pair === 'string') return denied('unavailable');
    const authorization = canClose(pair, principal.userId, membershipEpoch);
    if (authorization) return denied(authorization);
    await mutateClosedPair(tx, coupleId.toLowerCase());
    return { ok: true, value: null };
  });
}
