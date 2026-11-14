import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { proposeSharedDoing, listSharedDoings, joinSharedDoing, advanceSharedDoing, declineSharedDoing, removeSharedDoing } from '../src/shared-doings.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, u3, u4, waiting } from './fixtures.ts';
let pg: PGlite, number = 121000;
const scope = { coupleId: c1, membershipEpoch: 1 }, recipient = identityPrincipal(u2);
const command = () => ({ ...scope, commandId: id(++number), confirm: true });
const db = () => adapter(pg);
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/042_shared_doings.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
async function propose(parts = 2) {
  const input = { ...command(), title: 'Synthetic course', kind: 'course', parts }, result = await proposeSharedDoing(db(), principal, input);
  if (!result.ok) throw Error('fixture');
  return { input, doing: result.value.doing };
}
const target = (doingId: string, expectedVersion: number) => ({ ...command(), doingId, expectedVersion });
it('keeps two voluntary positions, derives both-complete, permits withdrawal after completion and returns current tombstones on retry', async () => {
  expect(await listSharedDoings(db(), principal, scope)).toMatchObject({ ok: true, value: { doings: [], used: 0, capacity: 100 } });
  const { input, doing } = await propose(), creation = doing.id;
  expect(doing).toMatchObject({ title: input.title, authorAt: 0, decisionState: 'invited', version: 1 }); expect(doing).not.toHaveProperty('recipientAt');
  expect(await advanceSharedDoing(db(), recipient, { ...target(creation, 1), part: 1 })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await joinSharedDoing(db(), principal, target(creation, 1))).toEqual({ ok: false, error: 'unavailable' });
  const authorAdvance = { ...target(creation, 1), part: 2 };
  expect(await advanceSharedDoing(db(), principal, authorAdvance)).toMatchObject({ ok: true, value: { doing: { authorAt: 2, decisionState: 'invited', version: 2 } } });
  expect(await joinSharedDoing(db(), recipient, target(creation, 1))).toEqual({ ok: false, error: 'version_conflict' });
  const joining = target(creation, 2);
  expect(await joinSharedDoing(db(), recipient, joining)).toMatchObject({ ok: true, value: { doing: { recipientAt: 0, authorAt: 2, decisionState: 'joined', version: 3 } } });
  expect(await joinSharedDoing(db(), recipient, joining)).toMatchObject({ ok: true, value: { replay: true } });
  const advance = { ...target(creation, 3), part: 2 };
  expect(await advanceSharedDoing(db(), recipient, advance)).toMatchObject({ ok: true, value: { doing: { authorAt: 2, recipientAt: 2, version: 4 } } });
  expect(await advanceSharedDoing(db(), recipient, { ...target(creation, 4), part: 2 })).toEqual({ ok: false, error: 'version_conflict' });
  const withdraw = target(creation, 4);
  expect(await declineSharedDoing(db(), recipient, withdraw)).toMatchObject({ ok: true, value: { doing: { decisionState: 'declined', authorAt: 2, version: 5 } } });
  expect(await declineSharedDoing(db(), recipient, withdraw)).not.toHaveProperty('value.doing.recipientAt');
  expect(await advanceSharedDoing(db(), principal, { ...target(creation, 5), part: 2 })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await joinSharedDoing(db(), recipient, target(creation, 5))).toEqual({ ok: false, error: 'version_conflict' });
  expect(await removeSharedDoing(db(), recipient, target(creation, 5))).toEqual({ ok: false, error: 'unavailable' });
  expect(await removeSharedDoing(db(), principal, target(creation, 5))).toMatchObject({ ok: true, value: { doing: { contentState: 'removed', decisionState: 'declined', version: 6 } } });
  for (const result of [await advanceSharedDoing(db(), recipient, advance), await joinSharedDoing(db(), recipient, joining), await proposeSharedDoing(db(), principal, input), await advanceSharedDoing(db(), principal, authorAdvance)]) {
    expect(result).toMatchObject({ ok: true, value: { replay: true, doing: { contentState: 'removed' } } });
    for (const field of ['title', 'kind', 'parts', 'authorAt', 'recipientAt']) expect(result).not.toHaveProperty('value.doing.' + field);
  }
  expect(await proposeSharedDoing(db(), principal, { ...input, title: 'changed' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  expect((await pg.query('SELECT title,kind,parts,author_at,recipient_at FROM shared_doings WHERE id=$1', [creation])).rows[0]).toEqual({ title: null, kind: null, parts: null, author_at: null, recipient_at: null });
});
it('distinguishes declined invitations and author withdrawal; strict range, own-only positions, no-op and backwards steps', async () => {
  const a = (await propose(3)).doing, t = target(a.id, 1);
  expect(await declineSharedDoing(db(), principal, t)).toEqual({ ok: false, error: 'unavailable' });
  expect(await declineSharedDoing(db(), recipient, t)).toMatchObject({ ok: true, value: { doing: { decisionState: 'declined', version: 2 } } });
  const b = (await propose(3)).doing, removal = target(b.id, 1);
  expect(await removeSharedDoing(db(), principal, removal)).toMatchObject({ ok: true, value: { doing: { decisionState: 'withdrawn', contentState: 'removed', version: 2 } } });
  expect(await removeSharedDoing(db(), principal, removal)).toMatchObject({ ok: true, value: { replay: true } });
  expect(await joinSharedDoing(db(), recipient, target(b.id, 2))).toEqual({ ok: false, error: 'version_conflict' });
  const c = (await propose(3)).doing;
  for (const part of [0, 4]) expect(await advanceSharedDoing(db(), principal, { ...target(c.id, 1), part })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await joinSharedDoing(db(), recipient, target(c.id, 1))).toMatchObject({ ok: true });
  expect(await advanceSharedDoing(db(), recipient, { ...target(c.id, 2), part: 2 })).toMatchObject({ ok: true, value: { doing: { authorAt: 0, recipientAt: 2 } } });
  expect(await advanceSharedDoing(db(), recipient, { ...target(c.id, 3), part: 1 })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await advanceSharedDoing(db(), principal, { ...target(c.id, 3), part: 3 })).toMatchObject({ ok: true, value: { doing: { authorAt: 3, recipientAt: 2 } } });
  expect(await removeSharedDoing(db(), principal, target(c.id, 4))).toMatchObject({ ok: true, value: { doing: { decisionState: 'joined', contentState: 'removed' } } });
});
it('rejects wrong scopes, roles, principals, unconfirmed commands and malformed exact fields', async () => {
  const input = { ...command(), title: 'Synthetic bounds', kind: 'book', parts: 1 };
  for (const [operation, value] of [[proposeSharedDoing, input], [listSharedDoings, scope]] as const) {
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...value, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    for (const p of [identityPrincipal(outsider), { ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }]) expect(await operation(db(), p, value)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...value, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    for (const bad of [null, [], {}, { ...value, extra: 1 }, { ...value, coupleId: 'bad' }, { ...value, membershipEpoch: 0 }]) expect(await operation(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  for (const bad of [{ ...input, confirm: false }, { ...input, commandId: 'bad' }, { ...input, title: '' }, { ...input, kind: 'x' }, { ...input, parts: 1001 }]) expect(await proposeSharedDoing(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  const d = (await propose()).doing, t = target(d.id, 1);
  for (const bad of [{ ...t, doingId: 'bad' }, { ...t, expectedVersion: 0 }, { ...t, expectedVersion: 2005 }, { ...t, confirm: false }, { ...t, commandId: 'bad' }]) expect(await joinSharedDoing(db(), recipient, bad)).toEqual({ ok: false, error: 'invalid_request' });
  for (const part of [-1, 1001, 1.5, '1']) expect(await advanceSharedDoing(db(), principal, { ...t, part })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await joinSharedDoing(db(), recipient, { ...t, doingId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
});
it('SQL forbids title/identity edits, no-ops, corrupt progress, resurrection, physical deletion and mutable receipts', async () => {
  const d = (await propose()).doing;
  for (const sql of ["UPDATE shared_doings SET title='changed',version=version+1 WHERE id=$1", 'UPDATE shared_doings SET version=version+1 WHERE id=$1',
    "UPDATE shared_doings SET author_id='00000000-0000-4000-8000-000000000099',version=version+1 WHERE id=$1", 'UPDATE shared_doings SET author_at=3,version=version+1 WHERE id=$1', 'DELETE FROM shared_doings WHERE id=$1']) await expect(pg.query(sql, [d.id])).rejects.toMatchObject({ code: '23514' });
  await expect(pg.exec('UPDATE shared_doing_commands SET fingerprint=repeat(\'a\',64)')).rejects.toMatchObject({ code: '23514' });
  await expect(pg.exec('DELETE FROM shared_doing_commands')).rejects.toMatchObject({ code: '23514' });
  await removeSharedDoing(db(), principal, target(d.id, 1));
  await expect(pg.query("UPDATE shared_doings SET content_state='active',decision_state='invited',title='revive',kind='book',parts=2,author_at=0,version=version+1 WHERE id=$1", [d.id])).rejects.toMatchObject({ code: '23514' });
});
it('fails closed after held-boundary authority loss and rolls back fresh state and receipt; rejects malformed DB evidence', async () => {
  const base = db(), author = { ...identityPrincipal(u3), tokenExpiresAt: Date.parse('2027-01-01Z') / 1000 }, other = { ...identityPrincipal(u4), tokenExpiresAt: author.tokenExpiresAt };
  const input = { coupleId: c2, membershipEpoch: 1, commandId: id(++number), confirm: true, title: 'Synthetic authority', kind: 'book', parts: 2 };
  const saved = await proposeSharedDoing(base, author, input); if (!saved.ok) throw Error('fixture');
  const action = { coupleId: c2, membershipEpoch: 1, commandId: id(++number), doingId: saved.value.doing.id, expectedVersion: 1, confirm: true };
  function intercept(fragment: string, behavior = 'expire') {
    let expired = false;
    return { ...base, now: () => expired ? new Date('2031-01-01Z') : base.now(), transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({ query: async <R>(sql: string, args?: unknown[]) => {
      const r = await tx.query<R>(sql, args);
      if (sql.includes(fragment)) {
        if (behavior === 'expire') expired = true;
        if (behavior === 'empty') return { rows: [] as R[] };
      }
      return r;
    } })) };
  }
  for (const fragment of ['AND id=$3 FOR UPDATE', 'UPDATE shared_doings', 'INSERT INTO shared_doing_commands', 'SELECT title,kind,parts']) {
    expect(await joinSharedDoing(intercept(fragment), other, action)).toEqual({ ok: false, error: 'unavailable' });
    expect((await pg.query('SELECT decision_state,version,recipient_at FROM shared_doings WHERE id=$1', [action.doingId])).rows[0]).toEqual({ decision_state: 'invited', version: 1, recipient_at: null });
    expect((await pg.query('SELECT command_id FROM shared_doing_commands WHERE command_id=$1', [action.commandId])).rows).toEqual([]);
  }
  expect(await listSharedDoings(intercept('ORDER BY sequence'), author, { coupleId: c2, membershipEpoch: 1 })).toEqual({ ok: false, error: 'unavailable' });
  for (const fragment of ['UPDATE shared_doings', 'INSERT INTO shared_doing_commands', 'SELECT title,kind,parts']) await expect(joinSharedDoing(intercept(fragment, 'empty'), other, action)).rejects.toThrow();
  expect(await proposeSharedDoing(intercept('AS used'), author, { ...input, commandId: id(++number) })).toEqual({ ok: false, error: 'unavailable' });
  await expect(proposeSharedDoing(intercept('INSERT INTO shared_doings', 'empty'), author, { ...input, commandId: id(++number) })).rejects.toThrow('invalid_shared_doing_write');
  expect(await joinSharedDoing(base, other, action)).toMatchObject({ ok: true });
  await expect(listSharedDoings({ ...base, now: () => new Date('bad') }, author, { coupleId: c2, membershipEpoch: 1 })).rejects.toThrow();
});
it('retains the complete bounded100 history including tombstones and permits existing actions at capacity', async () => {
  const used = Number((await pg.query<{ n: number }>('SELECT count(*)::int n FROM shared_doings WHERE couple_id=$1', [c1])).rows[0].n), last: string[] = [];
  for (let n = used; n < 100; n++) last.push((await propose()).doing.id);
  expect(await proposeSharedDoing(db(), principal, { ...command(), title: 'over', kind: 'other', parts: 1 })).toEqual({ ok: false, error: 'capacity_reached' });
  expect(await joinSharedDoing(db(), recipient, target(last[0], 1))).toMatchObject({ ok: true });
  expect(await advanceSharedDoing(db(), recipient, { ...target(last[0], 2), part: 1 })).toMatchObject({ ok: true });
  expect(await declineSharedDoing(db(), recipient, target(last[1], 1))).toMatchObject({ ok: true });
  expect(await removeSharedDoing(db(), principal, target(last[2], 1))).toMatchObject({ ok: true });
  const list = await listSharedDoings(db(), recipient, scope); expect(list).toMatchObject({ ok: true, value: { used: 100, capacity: 100 } });
  if (list.ok) expect(list.value.doings).toHaveLength(100);
});
