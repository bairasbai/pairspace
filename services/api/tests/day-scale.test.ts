import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { validScaleValue, validScaleDate, validScaleZone, scaleDateAt } from '../../../packages/domain/scale/value.ts';
import { createScaleSlot, publishScaleSlot, removeScaleSlot, listScaleSlots } from '../src/day-scale.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
let pg: PGlite, n = 80000;
const scope = { coupleId: c1, membershipEpoch: 1 };
const command = () => ({ ...scope, commandId: id(++n) });
const db = () => adapter(pg);
const partner = identityPrincipal(u2);
beforeAll(async () => { pg = await createFixture(); for (const file of ['012_shared_dates.sql', '038_day_scale.sql'])
    await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
it('pure integer/date/IANA rules preserve zero, reject blank/fractions and define DST/local boundaries', () => {
    for (const value of [0, 50, 100])
        expect(validScaleValue(value)).toBe(true);
    for (const value of ['', null, undefined, '50', -1, 101, 0.5, NaN, Infinity])
        expect(validScaleValue(value)).toBe(false);
    for (const date of ['2000-02-29', '2100-12-31'])
        expect(validScaleDate(date)).toBe(true);
    for (const date of ['1999-12-31', '2101-01-01', '2026-02-29', '2026-13-01', '2026-1-1', null])
        expect(validScaleDate(date)).toBe(false);
    expect(validScaleZone('UTC')).toBe(true);
    expect(validScaleZone('US/Eastern')).toBe(true);
    for (const zone of ['', null, 'Bad/Zone', ' UTC', '+01:00', 'x'.repeat(101)])
        expect(validScaleZone(zone)).toBe(false);
    expect(scaleDateAt(new Date('2026-11-10T00:30:00Z'), 'America/New_York')).toBe('2026-11-09');
    expect(scaleDateAt(new Date('2026-11-10T12:30:00Z'), 'Pacific/Kiritimati')).toBe('2026-11-11');
    expect(scaleDateAt(new Date(NaN), 'UTC')).toBeNull();
    expect(scaleDateAt(new Date(), 'Bad/Zone')).toBeNull();
    expect(scaleDateAt(new Date('1999-01-01'), 'UTC')).toBeNull();
});
it('publish zero, no-op, removal and new re-share with current canonical retries', async () => {
    const input = { ...command(), expectedDate: '2026-11-10', timezone: 'UTC', value: 0 };
    expect(await listScaleSlots(db(), principal, scope)).toMatchObject({ ok: true, value: { slots: [], ownUsed: 0, capacityPerAuthor: 100 } });
    const saved = await createScaleSlot(db(), principal, input);
    if (!saved.ok)
        throw Error('fixture');
    const slotId = saved.value.slot.id;
    expect(saved.value.slot).toMatchObject({ state: 'active', value: 0, version: 1 });
    expect(await createScaleSlot(db(), principal, input)).toMatchObject({ ok: true, value: { replay: true } });
    expect(await createScaleSlot(db(), principal, { ...input, value: 1 })).toEqual({ ok: false, error: 'idempotency_conflict' });
    expect(await createScaleSlot(db(), principal, { ...input, commandId: id(++n), timezone: 'Etc/UTC' })).toMatchObject({ ok: false, error: 'version_conflict', current: saved.value.slot });
    const update = { ...command(), slotId, expectedVersion: 1, value: 0 };
    expect(await publishScaleSlot(db(), principal, update)).toMatchObject({ ok: true, value: { slot: { version: 1 } } });
    expect(await publishScaleSlot(db(), partner, update)).toEqual({ ok: false, error: 'unavailable' });
    const removed = await removeScaleSlot(db(), principal, { ...command(), slotId, expectedVersion: 1 });
    if (!removed.ok)
        throw Error('fixture');
    expect(removed.value.slot).toMatchObject({ state: 'removed', version: 2 });
    expect(removed.value.slot).not.toHaveProperty('value');
    expect(await removeScaleSlot(db(), principal, { ...command(), slotId, expectedVersion: 2 })).toMatchObject({ ok: true, value: { slot: { version: 2, state: 'removed' } } });
    expect(await createScaleSlot(db(), principal, input)).toMatchObject({ ok: true, value: { slot: { state: 'removed', version: 2 } } });
    expect(await publishScaleSlot(db(), principal, { ...command(), slotId, expectedVersion: 1, value: 99 })).toMatchObject({ ok: false, error: 'version_conflict', current: removed.value.slot });
    const historical = { ...db(), now: () => new Date('2027-01-01') };
    expect(await publishScaleSlot(historical, principal, { ...command(), slotId, expectedVersion: 2, value: 50 })).toMatchObject({ ok: true, value: { slot: { state: 'active', value: 50, version: 3, timezone: 'UTC' } } });
    expect(await createScaleSlot(historical, principal, input)).toMatchObject({ ok: true, value: { replay: true, slot: { state: 'active', value: 50, version: 3 } } });
    expect(JSON.stringify((await pg.query('SELECT * FROM day_scale_commands')).rows)).not.toContain('"value"');
    expect(await listScaleSlots(db(), partner, scope)).toMatchObject({ ok: true, value: { ownUsed: 0, slots: expect.arrayContaining([expect.objectContaining({ authorId: principal.userId, value: 50 })]) } });
});
it('new create uses checked today, distinguishes missing zero and rejects malformed/private scopes', async () => {
    const input = { ...command(), expectedDate: '2026-11-10', timezone: 'America/New_York', value: 50 };
    expect(await createScaleSlot(db(), partner, input)).toEqual({ ok: false, error: 'date_mismatch' });
    expect(await createScaleSlot(db(), partner, { ...input, expectedDate: '2026-11-09' })).toMatchObject({ ok: true, value: { slot: { localDate: '2026-11-09', timezone: 'America/New_York' } } });
    for (const bad of [null, [], {}, { ...input, value: '' }, { ...input, value: 0.5 }, { ...input, timezone: 'Bad/Zone' }, { ...input, expectedDate: '2026-02-29' }, { ...input, commandId: 'bad' }, { ...input, extra: true }, { ...input, coupleId: 'bad' }, { ...input, membershipEpoch: 0 }])
        expect(await createScaleSlot(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
    const action = { ...command(), slotId: id(90), expectedVersion: 1, value: 50 };
    for (const bad of [{ ...action, slotId: 'bad' }, { ...action, expectedVersion: 0 }, { ...action, expectedVersion: 2147483647 }])
        expect(await publishScaleSlot(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
    expect(await publishScaleSlot(db(), principal, action)).toEqual({ ok: false, error: 'unavailable' });
    for (const [op, data] of [[createScaleSlot, input], [listScaleSlots, scope]] as const) {
        for (const coupleId of [c2, waiting, id(999)])
            expect(await op(db(), principal, { ...data, coupleId })).toEqual({ ok: false, error: 'unavailable' });
        for (const p of [identityPrincipal(outsider), { ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }])
            expect(await op(db(), p, data)).toEqual({ ok: false, error: 'unavailable' });
        expect(await op(db(), principal, { ...data, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    }
    expect(await listScaleSlots(db(), principal, { ...scope, value: 1 })).toEqual({ ok: false, error: 'invalid_request' });
});
it('midnight and expiry after receipt waits roll back; old replay is not a new publication', async () => {
    const base = db(), other = identityPrincipal(id(3)), data = { coupleId: c2, membershipEpoch: 1, commandId: id(++n), expectedDate: '2026-11-10', timezone: 'UTC', value: 33 };
    const intercept = (trigger: string, action: 'revoke' | 'midnight' | 'throw') => { let changed = false; return { ...base, now: () => changed && action === 'midnight' ? new Date('2026-11-11') : base.now(), sessionAuthority: { ...base.sessionAuthority, recheck: async (...args: Parameters<typeof base.sessionAuthority.recheck>) => !(changed && action === 'revoke') && base.sessionAuthority.recheck(...args) }, transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({ query: async <R>(sql: string, params?: unknown[]) => { const result = await tx.query<R>(sql, params); if (sql.includes(trigger)) {
                if (action === 'throw')
                    throw Error('unexpected');
                changed = true;
            } return result; } })) }; };
    expect(await createScaleSlot(intercept('INSERT INTO day_scale_commands', 'midnight'), other, data)).toEqual({ ok: false, error: 'date_mismatch' });
    expect((await pg.query('SELECT id FROM day_scale WHERE couple_id=$1', [c2])).rows).toHaveLength(0);
    expect(await createScaleSlot(intercept('INSERT INTO day_scale_commands', 'revoke'), other, data)).toEqual({ ok: false, error: 'unavailable' });
    await expect(createScaleSlot(intercept('INSERT INTO day_scale_commands', 'throw'), other, data)).rejects.toThrow('unexpected');
    await expect(createScaleSlot({ ...base, now: () => new Date(NaN) }, other, data)).rejects.toThrow('invalid_server_clock');
    const saved = await createScaleSlot(base, other, data);
    if (!saved.ok)
        throw Error('fixture');
    expect(await createScaleSlot(intercept('AND id=$3 FOR UPDATE', 'revoke'), other, data)).toEqual({ ok: false, error: 'unavailable' });
    expect(await listScaleSlots(intercept('ORDER BY', 'revoke'), other, { coupleId: c2, membershipEpoch: 1 })).toEqual({ ok: false, error: 'unavailable' });
    expect(await createScaleSlot(intercept('local_date=$4 FOR UPDATE', 'revoke'), other, { ...data, commandId: id(++n) })).toEqual({ ok: false, error: 'unavailable' });
    expect(await publishScaleSlot(intercept('AND id=$3 FOR UPDATE', 'revoke'), other, { coupleId: c2, membershipEpoch: 1, commandId: id(++n), slotId: saved.value.slot.id, expectedVersion: 1, value: 44 })).toEqual({ ok: false, error: 'unavailable' });
});
it('100 lifetime allocation is per author and includes removed; complete200 history and corrections remain', async () => {
    let last = '';
    for (const p of [principal, partner])
        for (let i = 1; i <= 99; i++) {
            const date = new Date(Date.UTC(2027, 0, i));
            const data = { ...command(), expectedDate: date.toISOString().slice(0, 10), timezone: 'UTC', value: i };
            const saved = await createScaleSlot({ ...db(), now: () => date }, p, data);
            if (!saved.ok)
                throw Error(JSON.stringify(saved));
            last = saved.value.slot.id;
        }
    expect(await createScaleSlot({ ...db(), now: () => new Date('2028-01-01') }, principal, { ...command(), expectedDate: '2028-01-01', timezone: 'UTC', value: 100 })).toEqual({ ok: false, error: 'capacity_reached' });
    expect(await removeScaleSlot(db(), partner, { ...command(), slotId: last, expectedVersion: 1 })).toMatchObject({ ok: true });
    expect(await publishScaleSlot(db(), partner, { ...command(), slotId: last, expectedVersion: 2, value: 100 })).toMatchObject({ ok: true });
    const list = await listScaleSlots(db(), principal, scope);
    if (!list.ok)
        throw Error('fixture');
    expect(list.value.slots).toHaveLength(200);
    expect(list.value.ownUsed).toBe(100);
    expect(list.value.slots.map(s => s.localDate)).toEqual(list.value.slots.map(s => s.localDate).sort().reverse());
});
it('SQL identity and value constraints protect slot metadata and receipts', async () => {
    for (const sql of ['DELETE FROM day_scale', 'UPDATE day_scale SET version=version', "UPDATE day_scale SET timezone='Etc/UTC',version=version+1", 'UPDATE day_scale SET value=101,version=version+1', 'UPDATE day_scale_commands SET fingerprint=fingerprint', 'DELETE FROM day_scale_commands'])
        await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
});
it('IANA spellings are preserved when SQL-supported, incompatible Intl spelling fails safely', async () => {
 const actor=identityPrincipal(id(4)),base={coupleId:c2,membershipEpoch:1,expectedDate:'2026-11-09',value:20};
 for(const timezone of ['europe/london','utc'])expect(await createScaleSlot(db(),actor,{...base,commandId:id(++n),timezone})).toEqual({ok:false,error:'invalid_request'});
 expect(await createScaleSlot(db(),actor,{...base,commandId:id(++n),timezone:'US/Eastern'})).toMatchObject({ok:true,value:{slot:{timezone:'US/Eastern',localDate:'2026-11-09'}}});
});
