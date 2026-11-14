import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createLoveWordsHandler } from '../src/love-words-http.ts';
import { adapter, c1, createFixture, id, principal } from './fixtures.ts';
let pg: PGlite;
beforeAll(async () => { pg = await createFixture(); await pg.exec("CREATE FUNCTION immutable_shared_date() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable' USING ERRCODE='23514'; END $$;"); await pg.exec(await readFile(new URL('../migrations/036_love_words.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
const base = `http://localhost/v1/couples/${c1}/love-words`;
const body = { membership_epoch: 1, command_id: id(50001), word: 'synthetic' };
const make = (method = 'POST', value: unknown = body, url = base, headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': body.command_id }) => new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
const db = () => { const source = adapter(pg); return { ...source, sessionAuthority: { ...source.sessionAuthority, authenticate: async () => principal } }; };
it('routes create/list/edit/delete and exact retry, secure headers, real conflicts', async () => {
    const handler = createLoveWordsHandler(db());
    const response = await handler(make());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json() as {
        value: {
            word: {
                id: string;
            };
        };
    };
    const url = base + '/' + result.value.word.id;
    expect((await handler(make('GET', null, base + '?membership_epoch=1'))).status).toBe(200);
    expect((await handler(make('PUT', { ...body, command_id: id(50002), expected_version: 1, said_when: 'when' }, url, { 'content-type': 'application/json', 'idempotency-key': id(50002) }))).status).toBe(200);
    expect((await handler(make('POST', { ...body, word: 'conflict' }))).status).toBe(409);
    expect((await handler(make('DELETE', { membership_epoch: 1, command_id: id(50003), expected_version: 2 }, url, { 'content-type': 'application/json', 'idempotency-key': id(50003) }))).status).toBe(200);
    expect((await handler(make('POST', { ...body, membership_epoch: 0 }))).status).toBe(400);
});
it('strict HTTP shape and method-specific Allow', async () => {
    const handler = createLoveWordsHandler(db());
    for (const url of [base, base + '/' + id(88)]) {
        const r = await handler(make('PATCH', {}, url));
        expect(r.status).toBe(405);
        expect(r.headers.get('allow')).toBe(url === base ? 'GET, POST' : 'PUT, DELETE');
    }
    expect((await handler(make('POST', {}, 'http://localhost/other'))).status).toBe(404);
    for (const query of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&x=2'])
        expect((await handler(make('GET', null, base + query))).status).toBe(400);
    expect((await handler(make('POST', body, base + '?x=2'))).status).toBe(400);
    expect((await handler(make('POST', body, base, {}))).status).toBe(415);
    for (const invalid of ['{', null, [], {}, { ...body, extra: 1 }, { ...body, command_id: 'bad' }])
        expect((await handler(make('POST', invalid))).status).toBe(400);
    expect((await handler(make('POST', body, base, { 'content-type': 'application/json', 'idempotency-key': id(1) }))).status).toBe(400);
    const normal = db();
    for (const who of [null, { ...principal, userId: 'bad' }, { ...principal, source: 'better-auth' as const, authUserId: 'x' }]) {
        const denied = createLoveWordsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => who } });
        expect((await denied(make())).status).toBe(401);
    }
    const unauthorized = createLoveWordsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, recheck: async () => false } });
    expect((await unauthorized(make())).status).toBe(403);
    const broken = createLoveWordsHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => { throw Error('private text'); } } });
    expect(await (await broken(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
