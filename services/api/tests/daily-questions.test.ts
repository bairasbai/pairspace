import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { AuthorizedDatabase } from '../src/contracts.ts';
import { createDailyAnswer as create, rewriteDailyAnswer as rewrite, removeDailyAnswer as remove,
  readDailyAnswer as read, listDailyQuestions as list } from '../src/daily-questions.ts';
import { adapter, createFixture, id, principal, identityPrincipal, u2, u3, u4, outsider, c1, c2, waiting } from './fixtures.ts';
let pg: PGlite, seq = 200000, day = 0;
const scope = { coupleId: c1, membershipEpoch: 1 }, recipient = identityPrincipal(u2);
const clock = (at: string) => () => new Date(at), db = () => adapter(pg);
const command = () => ({ ...scope, commandId: id(++seq), confirm: true });
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/046_daily_questions.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
async function make() {
  const expectedDay = '2026-12-' + String(++day).padStart(2, '0'), at = expectedDay + 'T10:00:00.000Z';
  const input = { ...command(), expectedDay, text: 'Synthetic daily answer' };
  const result = await create(db(), principal, input, clock(at));
  if (!result.ok) throw Error('fixture:' + result.error);
  return { input, at, answer: result.value.answer, slot: result.value.slot,
    action: { ...command(), answerId: result.value.answer.id, expectedVersion: 1 }, detail: { ...scope, answerId: result.value.answer.id } };
}
function observe(base: AuthorizedDatabase, hook: (sql: string, args?: unknown[]) => void): AuthorizedDatabase {
  return { ...base, transaction: work => base.transaction(tx => work({ query: async <T>(sql: string, args?: unknown[]) => {
    const result = await tx.query<T>(sql, args); hook(sql, args); return result;
  } })) };
}
function distort(base: AuthorizedDatabase, prefix: string, change: (rows: unknown[]) => unknown[]): AuthorizedDatabase {
  return { ...base, transaction: work => base.transaction(tx => work({ query: async <T>(sql: string, args?: unknown[]) => {
    const result = await tx.query<T>(sql, args); return sql.startsWith(prefix) ? { rows: change(result.rows) as T[] } : result;
  } })) };
}
it('nonpersisted descriptor, first POST zone pin, immutable resolver, metadata-only paths', async () => {
  const at = '2026-12-01T10:00:00.000Z';
  expect(await list(db(), principal, { ...scope, beforeDay: null }, clock(at))).toMatchObject({ value: { slots: [], hasMore: false, nextBeforeDay: null } });
  expect((await pg.query('SELECT * FROM daily_question_zones')).rows).toHaveLength(0);
  const f = await make(), resolver = () => { throw Error('must not run'); };
  expect(await list(db(), principal, { ...scope, beforeDay: null }, clock(at), resolver)).toMatchObject({ value: { today: { timezone: 'UTC' } } });
  expect(await create(db(), recipient, { ...command(), expectedDay: f.slot.day, text: 'Second' }, clock(at), resolver)).toMatchObject({ ok: true });
  let bodies = 0; const tracked = observe(db(), sql => { if (sql.startsWith('SELECT text ')) bodies++; });
  for (const result of [await list(tracked, principal, { ...scope, beforeDay: null }, clock(at)), await create(tracked, principal, f.input, clock(at))]) {
    expect(JSON.stringify(result)).not.toContain('"text":');
  }
  expect(bodies).toBe(0);
});
it('today partner requires real own body; removal relocks until past; body SELECT order', async () => {
  const f = await make(); let bodies: unknown[][] = [];
  const tracked = observe(db(), (sql, args) => { if (sql.startsWith('SELECT text ')) bodies.push(args!); });
  expect(await read(tracked, recipient, f.detail, clock(f.at))).not.toHaveProperty('value.text'); expect(bodies).toHaveLength(0);
  expect(await read(tracked, principal, f.detail, clock(f.at))).toHaveProperty('value.text', f.input.text);
  const own = await create(db(), recipient, { ...command(), expectedDay: f.slot.day, text: 'Own witness' }, clock(f.at));
  if (!own.ok) throw Error('fixture'); bodies = [];
  expect(await read(tracked, recipient, f.detail, clock(f.at))).toHaveProperty('value.text', f.input.text);
  expect(bodies.map(args => args[3])).toEqual([recipient.userId, principal.userId]);
  await expect(read(distort(db(), 'SELECT text ', () => [{ text: ' noncanonical ' }]), recipient, f.detail, clock(f.at))).rejects.toThrow('invalid_daily_question_body');
  await remove(db(), recipient, { ...command(), answerId: own.value.answer.id, expectedVersion: 1 }, clock(f.at));
  bodies = []; expect(await read(tracked, recipient, f.detail, clock(f.at))).not.toHaveProperty('value.text'); expect(bodies).toHaveLength(0);
  expect(await read(tracked, recipient, f.detail, clock('2026-12-30T10:00:00.000Z'))).toHaveProperty('value.text');
});
it('CAS rewrite, terminal bodywipe, immutable replay after midnight, no re-create', async () => {
  const f = await make(), update = { ...f.action, text: 'Revised' }, later = clock('2026-12-30T10:00:00.000Z');
  expect(await rewrite(db(), recipient, update, clock(f.at))).toEqual({ ok: false, error: 'unavailable' });
  expect(await rewrite(db(), principal, update, clock(f.at))).toMatchObject({ value: { answer: { version: 2 } } });
  const deletion = { ...command(), answerId: f.answer.id, expectedVersion: 2 };
  expect(await remove(db(), principal, deletion, later)).toMatchObject({ value: { answer: { contentState: 'removed' } } });
  for (const [operation, input] of [[create, f.input], [rewrite, update], [remove, deletion]] as const) {
    expect(await operation(db(), principal, input, later)).toMatchObject({ value: { slot: { id: f.slot.id }, answer: { contentState: 'removed' }, replay: true } });
  }
  expect((await pg.query('SELECT text FROM daily_question_answers WHERE id=$1', [f.answer.id])).rows).toEqual([{ text: null }]);
  expect(await read(db(), principal, f.detail, later)).not.toHaveProperty('value.text');
  expect(await create(db(), principal, { ...f.input, commandId: id(++seq) }, clock(f.at))).toEqual({ ok: false, error: 'version_conflict' });
  expect(await create(db(), principal, { ...f.input, text: 'different' }, later)).toEqual({ ok: false, error: 'idempotency_conflict' });
});
it('strict request, actor, pair, epoch, expectedDay and CAS gates', async () => {
  const f = await make(), update = { ...f.action, text: 'New' }, listInput = { ...scope, beforeDay: null };
  for (const [operation, input] of [[create, f.input], [rewrite, update], [remove, f.action], [read, f.detail], [list, listInput]] as const) {
    for (const bad of [null, [], {}, { ...input, extra: true }, { ...input, coupleId: 'bad' }, { ...input, membershipEpoch: 0 }]) expect(await operation(db(), principal, bad, clock(f.at))).toEqual({ ok: false, error: 'invalid_request' });
    for (const actor of [identityPrincipal(outsider), { ...principal, userId: 'bad' }]) expect(await operation(db(), actor, input, clock(f.at))).toEqual({ ok: false, error: 'unavailable' });
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...input, coupleId }, clock(f.at))).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...input, membershipEpoch: 2 }, clock(f.at))).toEqual({ ok: false, error: 'stale_membership' });
  }
  for (const patch of [{ text: '' }, { text: 'a\rb' }, { expectedDay: 'bad' }, { confirm: false }, { commandId: 'bad' }]) expect(await create(db(), principal, { ...f.input, ...patch }, clock(f.at))).toEqual({ ok: false, error: 'invalid_request' });
  for (const patch of [{ expectedVersion: 0 }, { expectedVersion: '1' }, { expectedVersion: 2147483647 }, { answerId: 'bad' }]) expect(await rewrite(db(), principal, { ...update, ...patch }, clock(f.at))).toEqual({ ok: false, error: 'invalid_request' });
  expect(await list(db(), principal, { ...listInput, beforeDay: 'bad' }, clock(f.at))).toEqual({ ok: false, error: 'invalid_request' });
  expect(await create(db(), principal, { ...f.input, commandId: id(++seq) }, clock('2026-12-30T10:00:00.000Z'))).toEqual({ ok: false, error: 'day_changed' });
  expect(await rewrite(db(), principal, update, clock('2026-12-30T10:00:00.000Z'))).toEqual({ ok: false, error: 'version_conflict' });
  expect(await remove(db(), principal, { ...f.action, answerId: id(999) }, clock(f.at))).toEqual({ ok: false, error: 'unavailable' });
});
it('late midnight write throws rollback; clocks and malformed receipts fail closed', async () => {
  const f = await make(); let at = f.at;
  const late = observe(db(), sql => { if (sql.startsWith('INSERT INTO daily_question_commands')) at = '2026-12-30T10:00:00.000Z'; });
  const input = { ...f.action, text: 'Must rollback' };
  expect(await rewrite(late, principal, input, () => new Date(at))).toEqual({ ok: false, error: 'unavailable' });
  expect((await pg.query('SELECT version,text FROM daily_question_answers WHERE id=$1', [f.answer.id])).rows).toEqual([{ version: 1, text: f.input.text }]);
  expect((await pg.query('SELECT * FROM daily_question_commands WHERE command_id=$1', [input.commandId])).rows).toHaveLength(0);
  at = f.at;
  expect(await read(observe(db(), sql => { if (sql.startsWith('SELECT text ')) at = '2026-01-01T00:00:00.000Z'; }), principal, f.detail, () => new Date(at))).toEqual({ ok: false, error: 'unavailable' });
  expect(await list(db(), principal, { ...scope, beforeDay: null }, clock('2026-01-01T00:00:00.000Z'))).toEqual({ ok: false, error: 'unavailable' });
  await expect(read(db(), principal, f.detail, () => new Date('bad'))).rejects.toThrow('invalid_daily_question_clock');
  for (const patch of [{ operation: 'remove' }, { applied: {} }, { slot: {} }, { applied: { ...f.answer, text: 'leak' } }, { applied: { ...f.answer, authorId: recipient.userId } }]) {
    await expect(create(distort(db(), 'SELECT fingerprint,answer_id,operation,applied,slot', rows => [{ ...(rows[0] as object), ...patch }]), principal, f.input, clock(f.at))).rejects.toThrow('invalid_daily_question_replay');
  }
  expect(await read(db(), principal, { ...scope, answerId: id(999) }, clock(f.at))).toEqual({ ok: false, error: 'unavailable' });
  expect(await list(db(), principal, { ...scope, beforeDay: '2026-12-02' }, clock('2026-12-30T10:00:00.000Z'))).toMatchObject({ value: { slots: [{ slot: { day: '2026-12-01' } }] } });
});
it('malformed rows, missing targets and invalid timezone configuration fail closed', async () => {
  const f = await make(), detail = f.detail, listInput = { ...scope, beforeDay: null };
  for (const [prefix, patch, error] of [
    ['SELECT id,slot_id', { content_state: ['active'] }, 'invalid_daily_question_answer'],
    ['SELECT id,couple_id', { prompt_id: 'bad' }, 'invalid_daily_question_slot'],
  ] as const) {
    await expect(read(distort(db(), prefix, rows => [{ ...(rows[0] as object), ...patch }]), principal, detail, clock(f.at))).rejects.toThrow(error);
  }
  for (const prefix of ['SELECT id,slot_id', 'SELECT id,couple_id']) {
    expect(await create(distort(db(), prefix, () => []), principal, f.input, clock(f.at))).toEqual({ ok: false, error: 'unavailable' });
    expect(await read(distort(db(), prefix, () => []), principal, detail, clock(f.at))).toEqual({ ok: false, error: 'unavailable' });
  }
  for (const rows of [[{ timezone: 'UTC' }, { timezone: 'UTC' }], [{ timezone: 'US/Eastern' }], [{ timezone: 3 }], [{ timezone: 'Invalid/Zone' }]]) {
    await expect(list(distort(db(), 'SELECT timezone ', () => rows), principal, listInput, clock(f.at))).rejects.toThrow('invalid_daily_question_zone');
  }
  await expect(list(db(), principal, { ...listInput, beforeDay: '0001-01-01' }, clock('0000-01-01T00:00:00.000Z'))).rejects.toThrow('invalid_daily_question_day');
  expect(await read(db(), principal, detail, clock('2026-01-01T00:00:00.000Z'))).toEqual({ ok: false, error: 'unavailable' });
  expect(await create(db(), principal, f.input, clock('2026-01-01T00:00:00.000Z'))).toEqual({ ok: false, error: 'unavailable' });
  expect(await remove(db(), principal, f.action, clock('2026-01-01T00:00:00.000Z'))).toEqual({ ok: false, error: 'unavailable' });
  expect(await list(db(), principal, listInput)).toEqual({ ok: false, error: 'unavailable' });
});
it('session recheck after reads and writes refuses private projection and rolls back writes', async () => {
  const f = await make();
  for (const [operation, input, prefix] of [
    [read, f.detail, 'SELECT text '], [create, f.input, 'SELECT fingerprint,answer_id'],
    [rewrite, { ...f.action, commandId: id(++seq), text: 'No commit' }, 'INSERT INTO daily_question_commands'],
  ] as const) {
    const base = db(); let revoked = false;
    const secured: AuthorizedDatabase = { ...base, sessionAuthority: {
      ...base.sessionAuthority, recheck: async (...args) => !revoked && base.sessionAuthority.recheck(...args),
    } };
    expect(await operation(observe(secured, sql => { if (sql.startsWith(prefix)) revoked = true; }), principal, input, clock(f.at))).toEqual({ ok: false, error: 'unavailable' });
  }
  expect((await pg.query('SELECT version FROM daily_question_answers WHERE id=$1', [f.answer.id])).rows).toEqual([{ version: 1 }]);
});
it('late creation rollback removes lazy slot/answer/pin atomically and rejects damaged receipts', async () => {
  const expectedDay = '2026-12-25', at = expectedDay + 'T10:00:00.000Z';
  const input = { ...command(), expectedDay, text: 'Do not commit' }; let current = at;
  const late = observe(db(), sql => { if (sql.startsWith('INSERT INTO daily_question_slots')) current = '2026-12-26T00:00:00.000Z'; });
  expect(await create(late, principal, input, () => new Date(current))).toEqual({ ok: false, error: 'unavailable' });
  expect((await pg.query('SELECT id FROM daily_question_slots WHERE day=$1', [expectedDay])).rows).toHaveLength(0);
  const f = await make();
  await expect(rewrite(distort(db(), 'INSERT INTO daily_question_commands', () => []), principal, { ...f.action, text: 'No receipt' }, clock(f.at))).rejects.toThrow('invalid_daily_question_receipt');
  expect((await pg.query('SELECT version FROM daily_question_answers WHERE id=$1', [f.answer.id])).rows).toEqual([{ version: 1 }]);
  await expect(rewrite(distort(db(), 'UPDATE daily_question_answers', () => []), principal, { ...f.action, commandId: id(++seq), text: 'No result' }, clock(f.at))).rejects.toThrow('invalid_daily_question_write');
});

it('Goose Bay calendar rollback fails future metadata and re-locks a past partner read at the tail', async () => {
  const pair = { coupleId: c2, membershipEpoch: 1 }, author = identityPrincipal(u3), reader = identityPrincipal(u4);
  const resolver = () => 'America/Goose_Bay';
  const old = await create(db(), author, { ...pair, commandId: id(++seq), confirm: true, expectedDay: '1988-10-29', text: 'Past then today' },
    clock('1988-10-29T12:00:00.000Z'), resolver);
  if (!old.ok) throw Error('fixture');
  let at = '1988-10-30T02:00:00.000Z';
  const changing = observe(db(), sql => { if (sql.startsWith('SELECT text ')) at = '1988-10-30T02:01:00.000Z'; });
  expect(await read(changing, reader, { ...pair, answerId: old.value.answer.id }, () => new Date(at))).toEqual({ ok: false, error: 'unavailable' });
  const input = { ...pair, commandId: id(++seq), confirm: true, expectedDay: '1988-10-30', text: 'Brief midnight' };
  const made = await create(db(), author, input, clock('1988-10-30T02:00:00.000Z'), resolver);
  if (!made.ok) throw Error('fixture');
  const rollback = clock('1988-10-30T02:01:00.000Z');
  expect(await read(db(), author, { ...pair, answerId: made.value.answer.id }, rollback)).toEqual({ ok: false, error: 'unavailable' });
  expect(await list(db(), author, { ...pair, beforeDay: null }, rollback)).toEqual({ ok: false, error: 'unavailable' });
  expect(await create(db(), author, input, rollback)).toEqual({ ok: false, error: 'unavailable' });
});
