import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createFixture, adapter, principal, identityPrincipal, u2, u3, c1, id, failOn } from './fixtures.ts';
import { commandMorning } from '../src/morning-commands.ts';
import { preparedMorning } from '../src/morning-prepared.ts';
import { readMorning } from '../src/morning-read.ts';
import { createMorningsHandler } from '../src/morning-http.ts';
let pg: PGlite, slotId: string;
const now = new Date(), scope = { coupleId: c1, membershipEpoch: 1 }, partner = identityPrincipal(u2);
const db = () => ({ ...adapter(pg), now: () => now });
const read = () => ({ ...scope, slotId, readId: id(9100) });
const edit = (n = 9101, body = 'Edited', expectedVersion = 1) => ({ ...scope, slotId, commandId: id(n), body, expectedVersion });
beforeAll(async () => {
    pg = await createFixture();
    for (const name of ['024_morning_ritual.sql', '027_morning_prepared_edits.sql'])
        await pg.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
    await commandMorning(db(), partner, { ...scope, commandId: id(9000), expectedVersion: 0, timezone: 'UTC', localTime: '09:00' }, 'preference');
    const result = await commandMorning(db(), principal, { ...scope, commandId: id(9001), preferenceVersion: 1, localDate: new Date(now.getTime() + 5 * 86400000).toISOString().slice(0, 10), offset: '+00:00' }, 'schedule');
    if (!result.ok || !('slot' in result.value))
        throw Error('seed');
    slotId = result.value.slot.id;
});
afterAll(async () => pg.close());
it('author-only prepared read, CAS edits, no-op and immutable original-fill replay', async () => {
    expect(await preparedMorning(db(), principal, read(), false)).toMatchObject({ error: 'unavailable' });
    await commandMorning(db(), principal, { ...scope, slotId, commandId: id(9002), body: 'Original' }, 'fill');
    const sealed = await readMorning(db(), partner, read());
    expect(await preparedMorning(db(), principal, read(), false)).toMatchObject({ ok: true, value: { body: 'Original', version: 1 } });
    expect(await preparedMorning(db(), partner, read(), false)).toMatchObject({ error: 'unavailable' });
    expect(await preparedMorning(db(), principal, edit(9102, 'Original'), true)).toMatchObject({ ok: true, value: { version: 1 } });
    expect(await preparedMorning(db(), principal, edit(), true)).toMatchObject({ ok: true, value: { body: 'Edited', version: 2, replay: false } });
    expect(await preparedMorning(db(), principal, edit(9103), true)).toMatchObject({ error: 'version_conflict' });
    expect(await preparedMorning(db(), principal, edit(9104, 'Original', 2), true)).toMatchObject({ ok: true, value: { version: 3 } });
    expect(await preparedMorning(db(), principal, edit(), true)).toMatchObject({ ok: true, value: { body: 'Original', version: 3, replay: true } });
    expect(await preparedMorning(db(), principal, edit(9101, 'different'), true)).toMatchObject({ error: 'idempotency_conflict' });
    expect(await readMorning(db(), partner, read())).toEqual(sealed);
    expect(await commandMorning(db(), principal, { ...scope, slotId, commandId: id(9002), body: 'Original' }, 'fill')).toMatchObject({ ok: true, value: { replay: true } });
});
it('malformed, scoped, expired and transactional paths fail without changes', async () => {
    for (const v of [null, {}, [], { ...read(), extra: 1 }, { ...read(), slotId: 'bad' }, { ...read(), readId: 'bad' }])
        expect(await preparedMorning(db(), principal, v, false)).toMatchObject({ error: 'invalid_request' });
    for (const v of [{ ...edit(), body: ' ' }, { ...edit(), expectedVersion: 0 }, { ...edit(), expectedVersion: 1.5 }, { ...edit(), expectedVersion: 2147483646 }, { ...edit(), commandId: 'bad' }])
        expect(await preparedMorning(db(), principal, v, true)).toMatchObject({ error: 'invalid_request' });
    expect(await preparedMorning(db(), identityPrincipal(u3), read(), false)).toMatchObject({ error: 'unavailable' });
    expect(await preparedMorning(db(), principal, { ...read(), membershipEpoch: 2 }, false)).toMatchObject({ error: 'stale_membership' });
    expect(await preparedMorning(db(), principal, { ...read(), slotId: id(99999) }, false)).toMatchObject({ error: 'unavailable' });
    let checks = 0;
    const revoked = { ...db(), sessionAuthority: { ...db().sessionAuthority, recheck: async () => ++checks < 3 } };
    expect(await preparedMorning(revoked, principal, read(), false)).toMatchObject({ error: 'unavailable' });
    const later = { ...db(), now: () => new Date(now.getTime() + 10 * 86400000) };
    expect(await preparedMorning(later, principal, read(), false)).toMatchObject({ error: 'slot_closed' });
    expect(await preparedMorning(later, principal, edit(9110, 'late', 3), true)).toMatchObject({ error: 'slot_closed' });
    expect(await preparedMorning(later, principal, edit(), true)).toMatchObject({ ok: true, value: { replay: true, version: 3 } });
    await expect(preparedMorning(failOn(db(), 'INSERT INTO morning_prepared_receipts'), principal, edit(9111, 'rollback', 3), true)).rejects.toThrow();
    expect(await preparedMorning(db(), principal, read(), false)).toMatchObject({ ok: true, value: { body: 'Original', version: 3 } });
});
it('prepared HTTP reads and mutations keep no-store and strict envelopes', async () => {
    const d = db();
    const handler = createMorningsHandler({ ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => principal } });
    const base = `https://test/v1/couples/${c1}/mornings/slots/${slotId}/prepared`;
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
