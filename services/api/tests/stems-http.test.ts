import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createStemsHandler } from '../src/stems-http.ts';
import { adapter, c1, createFixture, id, principal, identityPrincipal, u2 } from './fixtures.ts';
let pg: PGlite;
beforeAll(async () => { pg = await createFixture(); await pg.exec("CREATE FUNCTION immutable_shared_date() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable' USING ERRCODE='23514'; END $$;"); await pg.exec(await readFile(new URL('../migrations/039_stems.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
const base = `http://localhost/v1/couples/${c1}/stems`;
const body = { membership_epoch: 1, command_id: id(75001), beginning: 'synthetic', own_continuation: 'private' };
const make = (method = 'POST', value: unknown = body, url = base, headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': (value as {
        command_id?: string;
    })?.command_id ?? body.command_id }) => new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
const db = () => { const source = adapter(pg); return { ...source, sessionAuthority: { ...source.sessionAuthority, authenticate: async () => principal } }; };
it('routes all commands with current canonical retry and secure headers', async () => {
    const handler = createStemsHandler(db());
    const source = db();
    const partner = createStemsHandler({ ...source, sessionAuthority: { ...source.sessionAuthority, authenticate: async () => identityPrincipal(u2) } });
    const r = await handler(make());
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const value = await r.json() as {
        value: {
            round: {
                id: string;
            };
        };
    };
    const url = base + '/' + value.value.round.id;
    expect((await handler(make('GET', null, base + '?membership_epoch=1'))).status).toBe(200);
    expect((await partner(make('POST', { membership_epoch: 1, command_id: id(75002), expected_version: 1, continuation: 'answer' }, url + '/complete'))).status).toBe(200);
    expect((await handler(make('DELETE', { membership_epoch: 1, command_id: id(75003), expected_version: 2 }, url + '/author-bundle'))).status).toBe(200);
    expect((await partner(make('DELETE', { membership_epoch: 1, command_id: id(75004), expected_version: 3 }, url + '/recipient-continuation'))).status).toBe(200);
    expect((await partner(make('POST', { membership_epoch: 1, command_id: id(75005), expected_version: 4 }, url + '/skip'))).status).toBe(409);
    expect((await handler(make('POST', { ...body, beginning: 'conflict' }))).status).toBe(409);
    expect((await handler(make('POST', { ...body, membership_epoch: 0 }))).status).toBe(400);
});
it('strict body/query/schema, route-specific methods, safe auth failures', async () => {
    const handler = createStemsHandler(db());
    for (const [suffix, allow] of [['', 'GET, POST'], ['/x/complete', 'POST'], ['/x/skip', 'POST'], ['/x/author-bundle', 'DELETE']]) {
        const r = await handler(make('PUT', {}, base + suffix));
        expect(r.status).toBe(405);
        expect(r.headers.get('allow')).toBe(allow);
    }
    expect((await handler(make('POST', {}, base + '/unknown'))).status).toBe(404);
    for (const query of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&x=2'])
        expect((await handler(make('GET', null, base + query))).status).toBe(400);
    expect((await handler(make('POST', body, base + '?x=2'))).status).toBe(400);
    expect((await handler(make('POST', body, base, {}))).status).toBe(415);
    for (const invalid of ['{', null, [], {}, { ...body, extra: 1 }, { ...body, command_id: 'bad' }])
        expect((await handler(make('POST', invalid))).status).toBe(400);
    expect((await handler(make('POST', body, base, { 'content-type': 'application/json', 'idempotency-key': id(1) }))).status).toBe(400);
    const normal = db();
    for (const who of [null, { ...principal, userId: 'bad' }, { ...principal, source: 'better-auth' as const, authUserId: 'x' }]) {
        const denied = createStemsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => who } });
        expect((await denied(make())).status).toBe(401);
    }
    const denied = createStemsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, recheck: async () => false } });
    expect((await denied(make())).status).toBe(403);
    const broken = createStemsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => { throw Error('private'); } } });
    expect(await (await broken(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
