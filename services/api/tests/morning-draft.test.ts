import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createFixture, adapter, principal, identityPrincipal, u2, u3, c1, id, failOn } from './fixtures.ts';
import { commandMorning } from '../src/morning-commands.ts';
import { draftMorning } from '../src/morning-draft.ts';
import { readMorning } from '../src/morning-read.ts';
import { createMorningsHandler } from '../src/morning-http.ts';
let pg: PGlite, slotId: string;
const now = new Date(), scope = { coupleId: c1, membershipEpoch: 1 }, partner = identityPrincipal(u2);
const db = () => ({ ...adapter(pg), now: () => now });
const read = () => ({ ...scope, slotId, readId: id(9100) });
const edit = (n = 9101, body = 'Edited', expectedVersion = 1) => ({ ...scope, slotId, commandId: id(n), body, expectedVersion });
beforeAll(async () => {
    pg = await createFixture();
    for (const name of ['024_morning_ritual.sql', '028_morning_private_drafts.sql'])
        await pg.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    await commandMorning(db(), partner, { ...scope, commandId: id(9000), expectedVersion: 0, timezone: 'UTC', localTime: '09:00' }, 'preference');
    const result = await commandMorning(db(), principal, { ...scope, commandId: id(9001), preferenceVersion: 1, localDate: new Date(now.getTime() + 5 * 86400000).toISOString().slice(0, 10), offset: '+00:00' }, 'schedule');
    if (!result.ok || !('slot' in result.value))
        throw Error('seed');
    slotId = result.value.slot.id;
});
afterAll(async () => pg.close());
it('private draft remains separate across no-op, CAS, canonical retry, release and fill', async () => {
    const sealed = await readMorning(db(), partner, read());
    expect(await draftMorning(db(), principal, read(), false)).toMatchObject({ value: { body: null, version: 0 } });
    expect(await draftMorning(db(), principal, edit(9100, 'Original', 0), true)).toMatchObject({ value: { version: 1 } });
    expect(await draftMorning(db(), partner, read(), false)).toMatchObject({ error: 'unavailable' });
    expect(await draftMorning(db(), principal, edit(9102, 'Original'), true)).toMatchObject({ value: { version: 1 } });
    expect(await draftMorning(db(), principal, edit(), true)).toMatchObject({ value: { body: 'Edited', version: 2, replay: false } });
    expect(await draftMorning(db(), principal, edit(9103), true)).toMatchObject({ error: 'version_conflict' });
    expect(await draftMorning(db(), principal, edit(9104, 'Original', 2), true)).toMatchObject({ value: { version: 3 } });
    expect(await draftMorning(db(), principal, edit(), true)).toMatchObject({ value: { body: 'Original', version: 3, replay: true } });
    expect(await draftMorning(db(), principal, edit(9101, 'different'), true)).toMatchObject({ error: 'idempotency_conflict' });
    expect(await readMorning(db(), partner, read())).toEqual(sealed);
    const later = { ...db(), now: () => new Date(now.getTime() + 10 * 86400000) };
    const missed = await readMorning(later, partner, read());
    expect(missed).toMatchObject({ value: { slot: { state: 'missed' } } });
    expect(await draftMorning(later, principal, read(), false)).toMatchObject({ value: { body: 'Original', version: 3 } });
    expect(await readMorning(later, partner, read())).toEqual(missed);
    await commandMorning(db(), principal, { ...scope, slotId, commandId: id(9002), body: 'Canonical not draft' }, 'fill');
    expect(await draftMorning(db(), principal, read(), false)).toMatchObject({ value: { body: 'Original', version: 3 } });
});
it('malformed, scoped, expired and transactional paths fail without changes', async () => {
    for (const v of [null, {}, [], { ...read(), extra: 1 }, { ...read(), slotId: 'bad' }, { ...read(), readId: 'bad' }])
        expect(await draftMorning(db(), principal, v, false)).toMatchObject({ error: 'invalid_request' });
    for (const v of [{ ...edit(), body: ' ' }, { ...edit(), expectedVersion: -1 }, { ...edit(), expectedVersion: 1.5 }, { ...edit(), expectedVersion: 2147483646 }, { ...edit(), commandId: 'bad' }])
        expect(await draftMorning(db(), principal, v, true)).toMatchObject({ error: 'invalid_request' });
    expect(await draftMorning(db(), identityPrincipal(u3), read(), false)).toMatchObject({ error: 'unavailable' });
    expect(await draftMorning(db(), principal, { ...read(), membershipEpoch: 2 }, false)).toMatchObject({ error: 'stale_membership' });
    expect(await draftMorning(db(), principal, { ...read(), slotId: id(99999) }, false)).toMatchObject({ error: 'unavailable' });
    let checks = 0;
    const revoked = { ...db(), sessionAuthority: { ...db().sessionAuthority, recheck: async () => ++checks < 3 } };
    expect(await draftMorning(revoked, principal, read(), false)).toMatchObject({ error: 'unavailable' });
    const later = { ...db(), now: () => new Date(now.getTime() + 10 * 86400000) };
    expect(await draftMorning(later, principal, read(), false)).toMatchObject({ ok: true });
    expect(await draftMorning(later, principal, edit(9110, 'Original', 3), true)).toMatchObject({ ok: true });
    expect(await draftMorning(later, principal, edit(), true)).toMatchObject({ ok: true, value: { replay: true, version: 3 } });
    await expect(draftMorning(failOn(db(), 'INSERT INTO morning_draft_receipts'), principal, edit(9111, 'rollback', 3), true)).rejects.toThrow();
    expect(await draftMorning(db(), principal, read(), false)).toMatchObject({ ok: true, value: { body: 'Original', version: 3 } });
});
it('prepared HTTP reads and mutations keep no-store and strict envelopes', async () => {
    const d = db();
    const handler = createMorningsHandler({ ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => principal } });
    const base = `https://test/v1/couples/${c1}/mornings/slots/${slotId}/draft`;
    const get = await handler(new Request(`${base}?membership_epoch=1&read_id=${id(9120)}`));
    expect(get.status).toBe(200);
    expect(get.headers.get('cache-control')).toBe('no-store');
    const command = id(9121), body = { membership_epoch: 1, command_id: command, expected_version: 3, body: 'HTTP' };
    const put = await handler(new Request(base, { method: 'PUT', headers: { 'content-type': 'application/json', 'idempotency-key': command }, body: JSON.stringify(body) }));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ value: { body: 'HTTP', version: 4 } });
    expect((await handler(new Request(base, { method: 'DELETE' }))).status).toBe(405);
    expect((await handler(new Request(base.replace('/slots/', '/preference/')))).status).toBe(404);
    expect((await handler(new Request(base + '?extra=x'))).status).toBe(400);
});
it('private draft may start on missed empty slot but not an already filled slot', async () => {
    for (const [day, fill] of [[7, false], [8, true]] as const) {
        const r = await commandMorning(db(), principal, { ...scope, commandId: id(9400 + day), preferenceVersion: 1,
            localDate: new Date(now.getTime() + day * 86400000).toISOString().slice(0, 10), offset: '+00:00' }, 'schedule');
        if (!r.ok || !('slot' in r.value)) throw Error('seed');
        const target = r.value.slot.id;
        if (fill) await commandMorning(db(), principal, { ...scope, slotId: target, commandId: id(9500 + day), body: 'Ready' }, 'fill');
        const later = { ...db(), now: () => new Date(now.getTime() + 12 * 86400000) };
        const before = await readMorning(later, partner, { ...read(), slotId: target });
        const result = await draftMorning(later, principal, { ...edit(9600 + day, 'Private after morning', 0), slotId: target }, true);
        expect(result).toMatchObject(fill ? { error: 'slot_filled' } : { ok: true, value: { version: 1 } });
        expect(await draftMorning(later, principal, { ...read(), slotId: target }, false)).toMatchObject(fill ? { error: 'slot_filled' } : { value: { body: 'Private after morning' } });
        expect(await readMorning(later, partner, { ...read(), slotId: target })).toEqual(before);
    }
});
it('SQL guards preserve draft identity and immutable fingerprint receipts', async () => {
    for (const sql of ["DELETE FROM morning_drafts", "UPDATE morning_drafts SET version=version+1",
        `UPDATE morning_drafts SET actor_id='${u2}'`, "UPDATE morning_draft_receipts SET fingerprint=repeat('f',64)",
        "DELETE FROM morning_draft_receipts"])
        await expect(pg.exec(sql)).rejects.toThrow();
    await expect(pg.query('INSERT INTO morning_draft_receipts(actor_id,command_id,slot_id,fingerprint) VALUES($1,$2,$3,$4)',
        [u2, id(9700), slotId, 'f'.repeat(64)])).rejects.toThrow();
});
it('recipient writes and revoked membership cannot access even exact retry', async () => {
    expect(await draftMorning(db(), partner, edit(9800, 'partner', 5), true)).toMatchObject({ error: 'unavailable' });
    await pg.query("UPDATE couples SET status='closed' WHERE id=$1", [c1]);
    await pg.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1 AND user_id=$2", [c1, principal.userId]);
    expect(await draftMorning(db(), principal, read(), false)).toMatchObject({ error: 'unavailable' });
    expect(await draftMorning(db(), principal, edit(), true)).toMatchObject({ error: 'unavailable' });

});
