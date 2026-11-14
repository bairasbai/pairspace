import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createDayScaleHandler } from '../src/day-scale-http.ts';
import { adapter, c1, createFixture, id, principal } from './fixtures.ts';
let pg: PGlite;
beforeAll(async () => { pg = await createFixture(); for (const file of ['012_shared_dates.sql', '038_day_scale.sql'])
    await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
const base = `http://localhost/v1/couples/${c1}/day-scale`, body = { membership_epoch: 1, command_id: id(90001), expected_date: '2026-11-10', timezone: 'UTC', value: 0 };
const make = (method = 'POST', value: unknown = body, url = base, headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': (value as {
        command_id?: string;
    })?.command_id ?? body.command_id }) => new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
const db = () => { const source = adapter(pg); return { ...source, sessionAuthority: { ...source.sessionAuthority, authenticate: async () => principal } }; };
it('collection/slot endpoints preserve zero, canonical conflict and removals', async () => {
    const h = createDayScaleHandler(db());
    const r = await h(make());
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const saved = await r.json() as {
        value: {
            slot: {
                id: string;
            };
        };
    };
    const url = base + '/' + saved.value.slot.id;
    expect((await h(make('GET', null, base + '?membership_epoch=1'))).status).toBe(200);
    expect((await h(make('PUT', { membership_epoch: 1, command_id: id(90002), expected_version: 1, value: 50 }, url))).status).toBe(200);
    const conflict = await h(make('DELETE', { membership_epoch: 1, command_id: id(90003), expected_version: 1 }, url));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'version_conflict', current: { state: 'active', value: 50, version: 2 } });
    expect((await h(make('DELETE', { membership_epoch: 1, command_id: id(90004), expected_version: 2 }, url))).status).toBe(200);
    expect((await h(make('POST', { ...body, membership_epoch: 0 }))).status).toBe(400);
});
it('shape/content-type/query/auth and exact Allow fail closed', async () => {
    const h = createDayScaleHandler(db());
    for (const [url, allow] of [[base, 'GET, POST'], [base + '/id', 'PUT, DELETE']]) {
        const r = await h(make('PATCH', {}, url));
        expect(r.status).toBe(405);
        expect(r.headers.get('allow')).toBe(allow);
    }
    expect((await h(make('POST', {}, base + '/x/y'))).status).toBe(404);
    for (const query of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&x=2'])
        expect((await h(make('GET', null, base + query))).status).toBe(400);
    expect((await h(make('POST', body, base + '?x=2'))).status).toBe(400);
    expect((await h(make('POST', body, base, {}))).status).toBe(415);
    for (const invalid of ['{', null, [], {}, { ...body, extra: 1 }, { ...body, command_id: 'bad' }])
        expect((await h(make('POST', invalid))).status).toBe(400);
    expect((await h(make('POST', body, base, { 'content-type': 'application/json', 'idempotency-key': id(1) }))).status).toBe(400);
    const source = db();
    for (const p of [null, { ...principal, userId: 'bad' }, { ...principal, source: 'better-auth' as const, authUserId: 'x' }])
        expect((await createDayScaleHandler({ ...source, sessionAuthority: { ...source.sessionAuthority, authenticate: async () => p } })(make())).status).toBe(401);
    expect((await createDayScaleHandler({ ...source, sessionAuthority: { ...source.sessionAuthority, recheck: async () => false } })(make())).status).toBe(403);
    const throws = createDayScaleHandler({ ...source, sessionAuthority: { ...source.sessionAuthority, authenticate: async () => { throw Error('secret'); } } });
    expect(await (await throws(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
