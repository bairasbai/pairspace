import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createFixture, adapter, principal, identityPrincipal, u2, u3, c1, id, failOn } from './fixtures.ts';
import { commandMorning } from '../src/morning-commands.ts';
import { listMornings, readMorning } from '../src/morning-read.ts';
import { openMorning } from '../src/morning-open.ts';
import { createMorningsHandler } from '../src/morning-http.ts';
import { parseMorningPreference, resolveMorning, resolveMorningChoice } from '../../../packages/domain/letters/morning.ts';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
let pg: PGlite, slotId: string;
const scope = { coupleId: c1, membershipEpoch: 1 };
const partner = identityPrincipal(u2);
const now = new Date();
const date = new Date(now.getTime() + 5 * 86400000).toISOString().slice(0, 10);
const db = () => ({ ...adapter(pg), now: () => now });
const pref = (commandId = id(6100), expectedVersion = 0) => ({ ...scope, commandId, expectedVersion, timezone: 'utc', localTime: '09:00' });
const schedule = (commandId = id(6101), localDate = date) => ({ ...scope, commandId, preferenceVersion: 1, localDate, offset: '+00:00' });
const fill = (commandId = id(6102)) => ({ ...scope, commandId, slotId, body: ' Private\r\n🙂 ' });
const detail = () => ({ ...scope, slotId, readId: id(6103) });
const win = () => ({ ...scope, readId: id(6104), direction: 'latest' });
beforeAll(async () => {
    pg = await createFixture();
    await pg.exec(await readFile(new URL('../migrations/024_morning_ritual.sql', import.meta.url), 'utf8'));
});
afterAll(async () => { await pg.close(); });
it('resolves civil normal/fold/gap, canonicalizes aliases and rejects invalid inputs without adjustment', () => {
    expect(parseMorningPreference('utc', '09:00')).toEqual({ timezone: 'UTC', localTime: '09:00' });
    for (const args of [[null, '09:00'], ['bad', '09:00'], ['UTC', '24:00'], ['x'.repeat(101), '00:00']])
        expect(parseMorningPreference(...args as [
            unknown,
            unknown
        ])).toBeNull();
    expect(resolveMorning('2027-11-07', '01:30', 'America/New_York')).toHaveLength(2);
    expect(resolveMorning('2027-03-14', '02:30', 'America/New_York')).toEqual([]);
    expect(resolveMorning('2011-12-30', '09:00', 'Pacific/Apia')).toEqual([]);
    expect(resolveMorning('2027-01-01', '09:00', 'UTC')).toEqual([{ offset: '+00:00', releaseAt: '2027-01-01T09:00:00.000Z' }]);
    for (const args of [['bad', '09:00', 'UTC'], ['2101-01-01', '09:00', 'UTC'], ['2027-01-01', 'bad', 'UTC']])
        expect(resolveMorning(...args as [
            unknown,
            unknown,
            unknown
        ])).toEqual([]);
    for (const offset of ['-00:00', '+14:01', '+15:00', 'Z', 'bad'])
        expect(resolveMorningChoice(date, '09:00', 'UTC', offset)).toBeNull();
    expect(resolveMorningChoice('2027-02-30', '09:00', 'UTC', '+00:00')).toBeNull();
    expect(resolveMorningChoice(date, '09:00', 'Bad', '+00:00')).toBeNull();
});
it('explicit preferences and snapshots, shared command namespace, immutable body and recipient secrecy', async () => {
    const d = db();
    expect(await commandMorning(d, partner, pref(), 'preference')).toMatchObject({ ok: true, value: { preference: { timezone: 'UTC', version: 1 } } });
    const result = await commandMorning(d, principal, schedule(), 'schedule');
    if (!result.ok || !('slot' in result.value))
        throw Error('seed');
    slotId = result.value.slot.id;
    expect(result.value.slot).toMatchObject({ state: 'sealed', prepared: false, coupleId: c1, membershipEpoch: 1 });
    const before = await readMorning(d, partner, detail());
    expect(await commandMorning(d, principal, fill(), 'fill')).toMatchObject({ ok: true, value: { slot: { prepared: true } } });
    expect(await readMorning(d, partner, detail())).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('prepared');
    expect(JSON.stringify(before)).not.toContain('Private');
    expect(await commandMorning(d, principal, fill(), 'fill')).toMatchObject({ ok: true, value: { replay: true } });
    expect(await commandMorning(d, principal, fill(id(6105)), 'fill')).toEqual({ ok: false, error: 'slot_filled' });
    expect(await commandMorning(d, partner, { ...fill(), commandId: id(6106) }, 'fill')).toEqual({ ok: false, error: 'unavailable' });
    expect(await commandMorning(d, principal, schedule(id(6107)), 'schedule')).toEqual({ ok: false, error: 'slot_exists' });
    expect(await commandMorning(d, principal, { ...schedule(), offset: '+01:00' }, 'schedule')).toEqual({ ok: false, error: 'idempotency_conflict' });
    expect(await commandMorning(d, principal, { ...fill(), commandId: id(6101) }, 'fill')).toEqual({ ok: false, error: 'idempotency_conflict' });
    expect(await commandMorning(d, partner, pref(id(6108), 1), 'preference')).toMatchObject({ ok: true, value: { preference: { version: 2 } } });
    expect(await commandMorning(d, partner, pref(), 'preference')).toMatchObject({ ok: true, value: { replay: true, preference: { version: 2 } } });
    const after = { ...d, now: () => new Date(date + 'T10:00:00Z') };
    expect(await commandMorning(after, principal, schedule(), 'schedule')).toMatchObject({ ok: true, value: { replay: true, slot: { preferenceVersion: 1, state: 'available' } } });
    expect(await commandMorning(after, principal, fill(), 'fill')).toMatchObject({ ok: true, value: { replay: true } });
    expect(await commandMorning(after, principal, fill(id(6109)), 'fill')).toEqual({ ok: false, error: 'slot_closed' });
    expect(await readMorning(after, principal, detail())).toMatchObject({ ok: true, value: { body: ' Private\n🙂 ' } });
    const recipient = await readMorning(after, partner, detail());
    expect(recipient).toMatchObject({ ok: true, value: { slot: { state: 'available', openedAt: null } } });
    expect(JSON.stringify(recipient)).not.toContain('Private');
    expect(await listMornings(after, partner, win())).toMatchObject({ ok: true, value: { lastAvailableId: slotId } });
});
it('strict operations, authorization, CAS and rollback without orphan slots or changed preference', async () => {
    const d = db();
    for (const input of [null, [], {}, { ...pref(), extra: true }, { ...pref(), expectedVersion: -1 }, { ...pref(), timezone: 'bad' }, { ...pref(), commandId: 'bad' }])
        expect(await commandMorning(d, principal, input, 'preference')).toMatchObject({ ok: false });
    expect(await commandMorning(d, partner, pref(id(6200), 0), 'preference')).toEqual({ ok: false, error: 'version_conflict' });
    expect(await commandMorning(d, principal, schedule(id(6201)), 'schedule')).toEqual({ ok: false, error: 'version_conflict' });
    expect(await commandMorning(d, principal, { ...schedule(id(6202)), preferenceVersion: 2, localDate: '2001-01-01' }, 'schedule')).toEqual({ ok: false, error: 'invalid_request' });
    expect(await commandMorning(d, principal, { ...fill(), body: ' ' }, 'fill')).toEqual({ ok: false, error: 'invalid_request' });
    expect(await commandMorning(d, principal, { ...fill(id(6299)), slotId: id(99999) }, 'fill')).toEqual({ ok: false, error: 'unavailable' });
    expect(await commandMorning(d, identityPrincipal(u3), pref(), 'preference')).toEqual({ ok: false, error: 'unavailable' });
    expect(await commandMorning(d, partner, { ...pref(), membershipEpoch: 2 }, 'preference')).toEqual({ ok: false, error: 'stale_membership' });
    await expect(commandMorning(failOn(d, 'INSERT INTO morning_command_receipts'), principal, pref(id(6203)), 'preference')).rejects.toThrow();
    expect((await listMornings(d, principal, win()))).toMatchObject({ ok: true, value: { preferences: [{ userId: u2 }] } });
    let checks = 0;
    const revoked = { ...d, sessionAuthority: { ...d.sessionAuthority, recheck: async () => ++checks < 3 } };
    expect(await commandMorning(revoked, principal, pref(id(6204)), 'preference')).toEqual({ ok: false, error: 'unavailable' });
});
it('read-only windows, scoped cursors, nonexistent targets and unopened future never disclose bodies', async () => {
    const d = db();
    for (const input of [null, {}, { ...win(), direction: 'bad' }, { ...win(), readId: 'bad' }])
        expect(await listMornings(d, principal, input)).toEqual({ ok: false, error: 'invalid_request' });
    for (const anchorReleaseAt of ['bad', new Date().toISOString()])
        expect(await listMornings(d, principal, { ...win(), direction: 'before', anchorId: id(9999), anchorReleaseAt })).toEqual({ ok: false, error: 'invalid_cursor' });
    const page = await listMornings(d, principal, win());
    if (!page.ok)
        throw Error('read');
    const slot = page.value.slots[0];
    expect(await listMornings(d, principal, { ...win(), direction: 'before', anchorId: slot.id, anchorReleaseAt: slot.releaseAt })).toMatchObject({ ok: true, value: { slots: [] } });
    expect(await listMornings(d, principal, { ...win(), direction: 'after', anchorId: slot.id, anchorReleaseAt: slot.releaseAt })).toMatchObject({ ok: true, value: { slots: [] } });
    expect(await listMornings(d, principal, { ...win(), direction: 'oldest' })).toMatchObject({ ok: true, value: { slots: [{ id: slot.id }] } });
    expect(await readMorning(d, principal, { ...detail(), slotId: id(9999) })).toEqual({ ok: false, error: 'unavailable' });
    expect(await readMorning(d, principal, {})).toEqual({ ok: false, error: 'invalid_request' });
    expect(await openMorning(d, partner, { ...scope, slotId, commandId: id(6300), confirm: true })).toEqual({ ok: false, error: 'slot_closed' });
    expect(await openMorning(d, principal, { ...scope, slotId, commandId: id(6300), confirm: true })).toEqual({ ok: false, error: 'unavailable' });
    expect(await openMorning(d, partner, { ...scope, slotId, commandId: id(6300), confirm: false })).toEqual({ ok: false, error: 'invalid_request' });
});
it('HTTP strict contracts, nonces and errors; no implicit creation', async () => {
    const handler = createMorningsHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => principal)));
    const base = `http://localhost/v1/couples/${c1}/mornings`;
    const request = (suffix = '', method = 'GET', body?: unknown) => new Request(base + suffix, { method, headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json', 'idempotency-key': id(6400) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await handler(request(`?membership_epoch=1&read_id=${id(6400)}&direction=latest`))).status).toBe(200);
    expect((await handler(request(`/slots/${slotId}?membership_epoch=1&read_id=${id(6400)}`))).status).toBe(200);
    expect((await handler(request('/preference', 'PUT', { membership_epoch: 1, command_id: id(6400), expected_version: 0, timezone: 'UTC', local_time: '09:00' }))).status).toBe(200);
    expect((await handler(request('/slots', 'POST', { membership_epoch: 1, command_id: id(6400), preference_version: 2, local_date: date, offset: '+00:00' }))).status).toBe(409);
    expect((await handler(request(`/slots/${slotId}/body`, 'PUT', { membership_epoch: 1, command_id: id(6400), body: 'Another' }))).status).toBe(409);
    expect((await handler(request(`/slots/${slotId}/open`, 'POST', { membership_epoch: 1, command_id: id(6400), confirm: true }))).status).toBe(409);
    for (const suffix of ['', '?membership_epoch=1&read_id=bad&direction=latest', '?membership_epoch=1&read_id=' + id(6400) + '&direction=latest&extra=1'])
        expect((await handler(request(suffix))).status).toBe(400);
    expect((await handler(request('/no-route'))).status).toBe(404);
    expect((await handler(request('/preference', 'POST', {}))).status).toBe(405);
    expect((await handler(request('/preference', 'PUT', {}))).status).toBe(400);
    const denied = createMorningsHandler(bindSessionAuthority(db(), createSyntheticAuthority(async () => null)));
    expect((await denied(request())).status).toBe(401);
    const broken = createMorningsHandler(bindSessionAuthority(failOn(db(), 'FROM couples'), createSyntheticAuthority(async () => principal)));
    expect((await broken(request(`?membership_epoch=1&read_id=${id(6400)}&direction=latest`))).status).toBe(503);
});
it('covers strict HTTP failures and early authority denial without writes', async () => {
    const d = db();
    for (const p of [{ ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }])
        expect(await listMornings(d, p, win())).toEqual({ ok: false, error: 'unavailable' });
    expect(await listMornings(d, principal, { ...win(), coupleId: id(9999) })).toEqual({ ok: false, error: 'unavailable' });
    let checks = 0;
    expect(await listMornings({ ...d, sessionAuthority: { ...d.sessionAuthority, recheck: async () => ++checks === 1 } }, principal, win())).toEqual({ ok: false, error: 'unavailable' });
    const handler = createMorningsHandler(bindSessionAuthority(d, createSyntheticAuthority(async () => principal)));
    const base = `http://localhost/v1/couples/${c1}/mornings`;
    const req = (suffix: string, body: string, contentType = 'application/json') => new Request(base + suffix, { method: 'PUT', headers: { authorization: 'Bearer synthetic', 'content-type': contentType }, body });
    expect((await handler(req('/preference?x=1', '{}'))).status).toBe(400);
    expect((await handler(req('/preference', '{}', 'text/plain'))).status).toBe(415);
    expect((await handler(req('/preference', '{'))).status).toBe(400);
    expect((await handler(req('/preference', 'null'))).status).toBe(400);
    expect((await handler(new Request(base + `?membership_epoch=2&read_id=${id(6400)}&direction=latest`, { headers: { authorization: 'Bearer synthetic' } }))).status).toBe(409);
    expect((await handler(new Request(base + `/slots/${id(9999)}?membership_epoch=1&read_id=${id(6400)}`, { headers: { authorization: 'Bearer synthetic' } }))).status).toBe(403);
});
it('navigates beyond thirty slots with native anchors and preserves missed metadata', async () => {
    const d = db();
    for (let n = 0; n < 32; n++) {
        const localDate = new Date(now.getTime() + (10 + n) * 86400000).toISOString().slice(0, 10);
        expect(await commandMorning(d, principal, { ...schedule(id(6500 + n), localDate), preferenceVersion: 2 }, 'schedule')).toMatchObject({ ok: true });
    }
    const first = await listMornings(d, principal, win());
    if (!first.ok)
        throw Error('window');
    expect(first.value.slots).toHaveLength(30);
    expect(first.value.hasOlder).toBe(true);
    const cursor = first.value.olderCursor!;
    const last = await listMornings(d, principal, { ...win(), direction: 'before', anchorId: cursor.id, anchorReleaseAt: cursor.releaseAt });
    if (!last.ok)
        throw Error('window');
    expect(last.value.slots).toHaveLength(3);
    expect(last.value.hasNewer).toBe(true);
    const reverse = last.value.newerCursor!;
    expect(await listMornings(d, principal, { ...win(), direction: 'after', anchorId: reverse.id, anchorReleaseAt: reverse.releaseAt })).toMatchObject({ ok: true, value: { slots: first.value.slots } });
    const later = { ...d, now: () => new Date(now.getTime() + 100 * 86400000) };
    const missed = await listMornings(later, partner, win());
    if (!missed.ok)
        throw Error('window');
    expect(missed.value.slots.every(s => s.state === 'missed')).toBe(true);
    expect(missed.value.lastAvailableId).toBe(slotId);
});
