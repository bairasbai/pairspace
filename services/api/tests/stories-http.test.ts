import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createStoriesHandler } from '../src/stories-http.ts';
import { adapter, c1, c2, createFixture, id, principal, identityPrincipal, u2 } from './fixtures.ts';
let pg: PGlite;
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/040_ordered_stories.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
const base = `http://localhost/v1/couples/${c1}/stories`;
const topic = { membership_epoch: 1, command_id: id(95001), topic: 'Synthetic topic' };
function make(method = 'POST', value: unknown = topic, url = base, headers: Record<string, string> = {
  'content-type': 'application/json', 'idempotency-key': (value as { command_id?: string })?.command_id ?? topic.command_id,
}) {
  return new Request(url, { method, headers, ...(method === 'GET' ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
}
const db = () => { const d = adapter(pg); return { ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => principal } }; };
it('all routes keep long story out of metadata/ACK and expose canonical text only on explicit GET', async () => {
  const d = db(), handler = createStoriesHandler(d), partner = createStoriesHandler({ ...d, sessionAuthority: { ...d.sessionAuthority, authenticate: async () => identityPrincipal(u2) } });
  const ordered = await handler(make());
  expect(ordered.status).toBe(200); expect(ordered.headers.get('cache-control')).toBe('no-store');
  expect(ordered.headers.get('x-content-type-options')).toBe('nosniff');
  const created = await ordered.json() as { value: { story: { id: string } } }, target = base + '/' + created.value.story.id;
  expect((await handler(make('GET', null, base + '?membership_epoch=1'))).status).toBe(200);
  const body = '🦉'.repeat(8000), tell = { membership_epoch: 1, command_id: id(95002), expected_version: 1, body };
  const told = await partner(make('POST', tell, target + '/story'));
  expect(told.status).toBe(200); expect(await told.text()).not.toContain('🦉');
  const list = await handler(make('GET', null, base + '?membership_epoch=1'));
  expect(await list.text()).not.toContain('🦉');
  const detail = await handler(make('GET', null, target + '/text?membership_epoch=1'));
  expect(await detail.json()).toMatchObject({ ok: true, value: { body } });
  expect((await handler(make('DELETE', { membership_epoch: 1, command_id: id(95003), expected_version: 2 }, target + '/topic'))).status).toBe(200);
  expect((await partner(make('DELETE', { membership_epoch: 1, command_id: id(95004), expected_version: 3 }, target + '/story'))).status).toBe(200);
  const removed = await handler(make('GET', null, target + '/text?membership_epoch=1'));
  expect(await removed.json()).toMatchObject({ ok: true, value: { story: { storyState: 'story_removed' } } });
  expect((await partner(make('POST', { membership_epoch: 1, command_id: id(95005), expected_version: 4 }, target + '/decline'))).status).toBe(409);
  const freshResponse = await handler(make('POST', { ...topic, command_id: id(95006) }));
  const fresh = await freshResponse.json() as { value: { story: { id: string } } };
  expect((await partner(make('POST', { membership_epoch: 1, command_id: id(95007), expected_version: 1 }, base + '/' + fresh.value.story.id + '/decline'))).status).toBe(200);
  expect((await handler(make('POST', { ...topic, topic: 'changed' }))).status).toBe(409);
  expect((await handler(make('POST', { ...topic, membership_epoch: 0 }))).status).toBe(400);
  expect((await handler(make('GET', null, base.replace(c1, c2) + '?membership_epoch=1'))).status).toBe(403);
});
it('strict query/body fields, method allowlist and safe failures; no body on metadata routes', async () => {
  const handler = createStoriesHandler(db());
  for (const [suffix, allow] of [['', 'GET, POST'], ['/x/story', 'POST, DELETE'], ['/x/decline', 'POST'], ['/x/topic', 'DELETE'], ['/x/text', 'GET']]) {
    const r = await handler(make('PUT', {}, base + suffix));
    expect(r.status).toBe(405); expect(r.headers.get('allow')).toBe(allow);
  }
  expect((await handler(make('POST', {}, base + '/unknown'))).status).toBe(404);
  for (const query of ['', '?membership_epoch=0', '?membership_epoch=1&membership_epoch=1', '?membership_epoch=1&x=2']) expect((await handler(make('GET', null, base + query))).status).toBe(400);
  expect((await handler(make('POST', topic, base + '?x=2'))).status).toBe(400);
  expect((await handler(make('POST', topic, base, {}))).status).toBe(415);
  for (const invalid of ['{', null, [], {}, { ...topic, extra: 1 }, { ...topic, command_id: 'bad' }]) expect((await handler(make('POST', invalid))).status).toBe(400);
  expect((await handler(make('POST', topic, base, { 'content-type': 'application/json', 'idempotency-key': id(1) }))).status).toBe(400);
  expect((await handler(make('POST', { ...topic, topic: 'x'.repeat(70000) }))).status).toBe(400);
  const normal = db();
  for (const who of [null, { ...principal, userId: 'bad' }, { ...principal, source: 'better-auth' as const, authUserId: 'x' }]) {
    expect((await createStoriesHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => who } })(make())).status).toBe(401);
  }
  expect((await createStoriesHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, recheck: async () => false } })(make())).status).toBe(403);
  const broken = createStoriesHandler({ ...normal, sessionAuthority: { ...normal.sessionAuthority, authenticate: async () => { throw Error('private'); } } });
  expect(await (await broken(make())).json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
});
