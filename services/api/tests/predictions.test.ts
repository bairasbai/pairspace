import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createPrediction, openPrediction, declinePrediction, removePrediction, listPredictions, readPrediction } from '../src/predictions.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
import type { AuthorizedDatabase } from '../src/contracts.ts';
let pg: PGlite, number = 131000;
const scope = { coupleId: c1, membershipEpoch: 1 }, recipient = identityPrincipal(u2);
const createdAt = '2026-11-10T00:00:00.000Z', due = '2026-11-11T06:00:00.000Z';
const schedule = { localDate: '2026-11-11', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00' };
const clock = (value: string) => () => new Date(value);
const command = () => ({ ...scope, commandId: id(++number), confirm: true });
const creation = (text = 'Synthetic private prediction') => ({ ...command(), text, schedule });
const db = () => adapter(pg);
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/043_predictions.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
async function make() {
  const input = creation(), result = await createPrediction(db(), principal, input, clock(createdAt));
  if (!result.ok) throw Error('fixture');
  return { input, prediction: result.value.prediction };
}
function observe(base: AuthorizedDatabase, action: (sql: string) => void): AuthorizedDatabase {
  return { ...base, transaction: work => base.transaction(tx => work({ query: async <T>(sql: string, args?: unknown[]) => {
    const result = await tx.query<T>(sql, args); action(sql); return result;
  } })) };
}
it('receipt trigger selects explicit metadata and never a body-bearing wildcard row', async () => {
  const sql = await readFile(new URL('../migrations/043_predictions.sql', import.meta.url), 'utf8');
  const trigger = sql.slice(sql.indexOf('CREATE FUNCTION guard_prediction_command()'));
  const projection = trigger.match(/SELECT ([\s\S]+?)INTO p FROM predictions/);
  expect(projection).not.toBeNull();
  expect(projection![1].replace(/\s/g, '').split(',')).toEqual([
    'id', 'couple_id', 'author_id', 'recipient_id', 'membership_epoch', 'version', 'created_at', 'release_at',
    'timezone', 'local_date', 'local_time', 'utc_offset', 'content_state', 'opened_at', 'declined_at',
  ]);
  expect(trigger).not.toMatch(/SELECT\s+\*/i);
});
it('keeps all lists and command ACKs body-free; explicit recipient opening is due-only and permits later reads', async () => {
  expect(await listPredictions(db(), principal, scope)).toMatchObject({ ok: true, value: { predictions: [], used: 0, capacity: 100 } });
  const { input, prediction } = await make(), detail = { ...scope, predictionId: prediction.id };
  let bodyQueries = 0;
  const observed = observe(db(), sql => { if (sql.startsWith('SELECT body FROM predictions')) bodyQueries++; });
  expect(JSON.stringify(await listPredictions(observed, recipient, scope))).not.toContain(input.text);
  expect(await readPrediction(observed, recipient, detail, clock(due))).not.toHaveProperty('value.text');
  expect(bodyQueries).toBe(0);
  expect(await readPrediction(observed, principal, detail)).toHaveProperty('value.text', input.text);
  expect(bodyQueries).toBe(1);
  const opening = { ...command(), predictionId: prediction.id, expectedVersion: 1 };
  expect(await openPrediction(observed, recipient, opening, clock('2026-11-11T05:59:59.999Z'))).toEqual({ ok: false, error: 'not_due' });
  expect(await openPrediction(observed, principal, opening, clock(due))).toEqual({ ok: false, error: 'unavailable' });
  const opened = await openPrediction(observed, recipient, opening, clock(due));
  expect(opened).toMatchObject({ ok: true, value: { replay: false, prediction: { version: 2, openedAt: due } } });
  expect(opened).not.toHaveProperty('value.text'); expect(bodyQueries).toBe(1);
  expect(await readPrediction(observed, recipient, detail, clock(due))).toHaveProperty('value.text', input.text);
  expect(bodyQueries).toBe(2);
  expect(await readPrediction(observed, recipient, detail, clock(createdAt))).not.toHaveProperty('value.text'); expect(bodyQueries).toBe(2);
  expect(await openPrediction(observed, recipient, opening, clock(createdAt))).toMatchObject({ ok: true, value: { replay: true } });
  expect(bodyQueries).toBe(2);
  expect(await openPrediction(db(), recipient, { ...opening, commandId: id(++number), expectedVersion: 2 }, clock(due))).toEqual({ ok: false, error: 'version_conflict' });
  expect(await declinePrediction(db(), recipient, { ...opening, commandId: id(++number), expectedVersion: 2 }, clock(due))).toEqual({ ok: false, error: 'version_conflict' });
  const removal = { ...command(), predictionId: prediction.id, expectedVersion: 2 };
  expect(await removePrediction(db(), recipient, removal, clock(due))).toEqual({ ok: false, error: 'unavailable' });
  expect(await removePrediction(db(), principal, removal, clock(due))).toMatchObject({ ok: true, value: { prediction: { version: 3, contentState: 'removed' } } });
  expect(await readPrediction(observed, principal, detail, clock(due))).not.toHaveProperty('value.text'); expect(bodyQueries).toBe(2);
  expect(await openPrediction(observed, recipient, opening, clock(due))).toMatchObject({ ok: true, value: { replay: true, prediction: { contentState: 'removed' } } });
  expect(await createPrediction(db(), principal, input, clock('2026-11-12T00:00:00.000Z'))).toMatchObject({ ok: true, value: { replay: true } });
  expect(await createPrediction(db(), principal, { ...input, text: 'different' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect((await pg.query('SELECT body FROM predictions WHERE id=$1', [prediction.id])).rows).toEqual([{ body: null }]);
});
it('refusal while sealed is terminal; own author reading remains until removal, replay preserves current metadata', async () => {
  const { prediction } = await make(), action = { ...command(), predictionId: prediction.id, expectedVersion: 1 };
  expect(await declinePrediction(db(), principal, action)).toEqual({ ok: false, error: 'unavailable' });
  expect(await declinePrediction(db(), recipient, action)).toMatchObject({ ok: true, value: { prediction: { declinedAt: createdAt, version: 2 } } });
  expect(await openPrediction(db(), recipient, { ...action, commandId: id(++number), expectedVersion: 2 }, clock(due))).toEqual({ ok: false, error: 'version_conflict' });
  const detail = { ...scope, predictionId: prediction.id };
  expect(await readPrediction(db(), recipient, detail, clock(due))).not.toHaveProperty('value.text');
  expect(await readPrediction(db(), principal, detail)).toHaveProperty('value.text');
  const removal = { ...command(), predictionId: prediction.id, expectedVersion: 2 };
  expect(await removePrediction(db(), principal, removal)).toMatchObject({ ok: true, value: { prediction: { version: 3, contentState: 'removed' } } });
  expect(await declinePrediction(db(), recipient, action)).toMatchObject({ ok: true, value: { replay: true, prediction: { contentState: 'removed' } } });
  expect(await removePrediction(db(), principal, removal)).toMatchObject({ ok: true, value: { replay: true } });
  const sealed = (await make()).prediction, withdraw = { ...command(), predictionId: sealed.id, expectedVersion: 1 };
  expect(await removePrediction(db(), principal, withdraw)).toMatchObject({ ok: true, value: { prediction: { version: 2, openedAt: null, declinedAt: null } } });
});
it('validates roles, all exact input keys and runtime values; current membership gates every operation', async () => {
  const input = creation(), { prediction } = await make(), action = { ...command(), predictionId: prediction.id, expectedVersion: 1 };
  for (const operation of [createPrediction, listPredictions]) {
    const request = operation === createPrediction ? input : scope;
    for (const actor of [identityPrincipal(outsider), { ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }]) expect(await operation(db(), actor, request)).toEqual({ ok: false, error: 'unavailable' });
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...request, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...request, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    for (const bad of [null, [], {}, { ...request, extra: true }, { ...request, coupleId: 'bad' }, { ...request, membershipEpoch: 0 }]) expect(await operation(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  for (const bad of [{ ...input, text: '' }, { ...input, text: 'a\rb' }, { ...input, schedule: {} }, { ...input, confirm: false }, { ...input, commandId: 'bad' }, { ...input, schedule: { ...schedule, localDate: '2026-11-10' } }]) expect(await createPrediction(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  for (const operation of [openPrediction, declinePrediction, removePrediction]) {
    for (const bad of [null, { ...action, confirm: 'false' }, { ...action, expectedVersion: 0 }, { ...action, expectedVersion: 4 }, { ...action, expectedVersion: '1' }, { ...action, predictionId: 'bad' }]) expect(await operation(db(), recipient, bad)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await operation(db(), principal, { ...action, predictionId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), { ...principal, tokenExpiresAt: 1 }, action)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...action, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
  }
  expect(await readPrediction(db(), principal, { ...scope, predictionId: 'bad' })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await readPrediction(db(), principal, { ...scope, predictionId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
  expect(await readPrediction(db(), { ...principal, tokenExpiresAt: 1 }, { ...scope, predictionId: prediction.id })).toEqual({ ok: false, error: 'unavailable' });
  expect(await readPrediction(db(), principal, { ...scope, predictionId: prediction.id, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
  expect(await openPrediction(db(), recipient, { ...action, expectedVersion: 2 }, clock(due))).toEqual({ ok: false, error: 'version_conflict' });
  expect(await removePrediction(db(), principal, action, clock('2026-11-09T00:00:00.000Z'))).toEqual({ ok: false, error: 'unavailable' });
  await expect(listPredictions(db(), principal, scope, () => new Date('bad'))).rejects.toThrow('invalid_prediction_clock');
});
it('late feature clock rollback and creation midnight crossing roll back both record and receipt', async () => {
  const { prediction } = await make(), action = { ...command(), predictionId: prediction.id, expectedVersion: 1 };
  let instant = due;
  const observed = observe(db(), sql => { if (sql.startsWith('INSERT INTO prediction_commands')) instant = createdAt; });
  expect(await openPrediction(observed, recipient, action, () => new Date(instant))).toEqual({ ok: false, error: 'unavailable' });
  expect((await pg.query('SELECT version,opened_at FROM predictions WHERE id=$1', [prediction.id])).rows).toEqual([{ version: 1, opened_at: null }]);
  expect((await pg.query('SELECT * FROM prediction_commands WHERE command_id=$1', [action.commandId])).rows).toEqual([]);
  instant = createdAt; const input = creation();
  const crossing = observe(db(), sql => { if (sql.startsWith('INSERT INTO prediction_commands')) instant = due; });
  expect(await createPrediction(crossing, principal, input, () => new Date(instant))).toEqual({ ok: false, error: 'unavailable' });
  expect((await pg.query('SELECT * FROM prediction_commands WHERE command_id=$1', [input.commandId])).rows).toEqual([]);
});
it('rechecks clock after body selection and never releases text if clock went back', async () => {
  const { prediction } = await make();
  await openPrediction(db(), recipient, { ...command(), predictionId: prediction.id, expectedVersion: 1 }, clock(due));
  let instant = due;
  const observed = observe(db(), sql => { if (sql.startsWith('SELECT body FROM predictions')) instant = createdAt; });
  expect(await readPrediction(observed, recipient, { ...scope, predictionId: prediction.id }, () => new Date(instant))).toEqual({ ok: false, error: 'unavailable' });
});
it('database rejects identity/body rewrites, resurrection, invalid receipts and deletion', async () => {
  const { prediction } = await make();
  for (const sql of ["UPDATE predictions SET body='rewritten',version=2 WHERE id=$1", "UPDATE predictions SET release_at=release_at+interval '1 hour',version=2 WHERE id=$1", 'DELETE FROM predictions WHERE id=$1']) await expect(pg.query(sql, [prediction.id])).rejects.toMatchObject({ code: '23514' });
  const receipt = (await pg.query<{ command_id: string }>('SELECT command_id FROM prediction_commands WHERE prediction_id=$1', [prediction.id])).rows[0];
  await expect(pg.query("UPDATE prediction_commands SET fingerprint=repeat('a',64) WHERE command_id=$1", [receipt.command_id])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query('DELETE FROM prediction_commands WHERE command_id=$1', [receipt.command_id])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.query(`INSERT INTO prediction_commands(actor_user_id,command_id,couple_id,membership_epoch,prediction_id,fingerprint,operation,applied)
    VALUES($1,$2,$3,1,$4,repeat('a',64),'open','{}')`, [recipient.userId,id(++number),c1,prediction.id])).rejects.toMatchObject({ code: '23514' });
  await removePrediction(db(), principal, { ...command(), predictionId: prediction.id, expectedVersion: 1 });
  await expect(pg.query("UPDATE predictions SET content_state='active',body='resurrected',version=3 WHERE id=$1", [prediction.id])).rejects.toMatchObject({ code: '23514' });
});
function distort(base: AuthorizedDatabase, prefix: string, change: (rows: unknown[]) => unknown[]): AuthorizedDatabase {
  return { ...base, transaction: work => base.transaction(tx => work({ query: async <T>(sql: string, args?: unknown[]) => {
    const result = await tx.query<T>(sql, args);
    return sql.startsWith(prefix) ? { rows: change(result.rows) as T[] } : result;
  } })) };
}
it('does not trust a matching fingerprint alone: replay requires original operation and monotone applied-state proof', async () => {
  const { input, prediction } = await make();
  const prefix = 'SELECT fingerprint,prediction_id,operation,applied FROM prediction_commands';
  for (const patch of [{ operation: 'open' }, { applied: { ...prediction, id: id(999) } },
    { applied: { ...prediction, body: 'smuggled' } }, { applied: { ...prediction, version: 2, contentState: 'removed' } }]) {
    const broken = distort(db(), prefix, rows => [{ ...(rows[0] as object), ...patch }]);
    await expect(createPrediction(broken, principal, input)).rejects.toThrow('invalid_prediction_replay');
  }
  const missing = distort(db(), 'SELECT id,couple_id', () => []);
  expect(await createPrediction(missing, principal, input)).toEqual({ ok: false, error: 'unavailable' });
  const opening = { ...command(), predictionId: prediction.id, expectedVersion: 1 };
  await openPrediction(db(), recipient, opening, clock(due));
  const wrongResult = distort(db(), prefix, rows => [{ ...(rows[0] as object), applied: prediction }]);
  await expect(openPrediction(wrongResult, recipient, opening, clock(due))).rejects.toThrow('invalid_prediction_replay');
  const receipt = (await pg.query<{ applied: object }>('SELECT applied FROM prediction_commands WHERE command_id=$1', [opening.commandId])).rows[0];
  await expect(pg.query(`INSERT INTO prediction_commands(actor_user_id,command_id,couple_id,membership_epoch,prediction_id,fingerprint,operation,expected_version,applied)
    VALUES($1,$2,$3,1,$4,repeat('a',64),'open',NULL,$5::jsonb)`, [recipient.userId,id(++number),c1,prediction.id,JSON.stringify(receipt.applied)])).rejects.toMatchObject({ code: '23514' });
});
it('late authority failure rolls back write and command receipt, not merely the response', async () => {
  const { prediction } = await make(), opening = { ...command(), predictionId: prediction.id, expectedVersion: 1 };
  const base = db(); let receiptWritten = false;
  const observed = observe({ ...base, sessionAuthority: { ...base.sessionAuthority,
    recheck: async (...args) => !receiptWritten && base.sessionAuthority.recheck(...args),
  } }, sql => { if (sql.startsWith('INSERT INTO prediction_commands')) receiptWritten = true; });
  expect(await openPrediction(observed, recipient, opening, clock(due))).toEqual({ ok: false, error: 'unavailable' });
  expect((await pg.query('SELECT version,opened_at FROM predictions WHERE id=$1', [prediction.id])).rows).toEqual([{ version: 1, opened_at: null }]);
  expect((await pg.query('SELECT * FROM prediction_commands WHERE command_id=$1', [opening.commandId])).rows).toEqual([]);
});
it('rejects inconsistent returned writes/receipts and rolls back their database effects', async () => {
  const input = creation();
  const badWrite = distort(db(), 'INSERT INTO predictions(', () => []);
  await expect(createPrediction(badWrite, principal, input)).rejects.toThrow('invalid_prediction_write');
  const badReceipt = distort(db(), 'INSERT INTO prediction_commands', rows => [{ ...(rows[0] as object), applied: {} }]);
  await expect(createPrediction(badReceipt, principal, input)).rejects.toThrow('invalid_prediction_receipt');
  expect((await pg.query('SELECT * FROM prediction_commands WHERE command_id=$1', [input.commandId])).rows).toEqual([]);
});
it('lifetime limit100 includes tombstones, with commands and replay still available', async () => {
  let used = (await pg.query<{ n: number }>('SELECT count(*)::int n FROM predictions')).rows[0].n;
  let last = (await make()).prediction; used++;
  for (; used < 100; used++) last = (await make()).prediction;
  expect(await createPrediction(db(), principal, creation())).toEqual({ ok: false, error: 'capacity_reached' });
  expect(await listPredictions(db(), recipient, scope)).toMatchObject({ ok: true, value: { used: 100, capacity: 100 } });
  expect(await openPrediction(db(), recipient, { ...command(), predictionId: last.id, expectedVersion: 1 }, clock(due))).toMatchObject({ ok: true });
  expect(await removePrediction(db(), principal, { ...command(), predictionId: last.id, expectedVersion: 2 }, clock(due))).toMatchObject({ ok: true });
});
