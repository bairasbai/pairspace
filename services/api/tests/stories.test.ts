import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { normalizeStoryTopic, normalizeStoryBody } from '../../../packages/domain/stories/text.ts';
import { listStories, readStory, orderStory, tellStory, declineStory, removeStoryTopic, removeStoryBody } from '../src/stories.ts';
import { adapter, c1, c2, createFixture, id, identityPrincipal, outsider, principal, u2, waiting } from './fixtures.ts';
let pg: PGlite;
let number = 91000;
const scope = { coupleId: c1, membershipEpoch: 1 }, partner = identityPrincipal(u2);
const command = () => ({ ...scope, commandId: id(++number) });
const db = () => adapter(pg);
beforeAll(async () => { pg = await createFixture(); await pg.exec(await readFile(new URL('../migrations/040_ordered_stories.sql', import.meta.url), 'utf8')); });
afterAll(async () => pg.close());
async function order(topic = 'Synthetic narrative topic') {
  const input = { ...command(), topic }, result = await orderStory(db(), principal, input);
  if (!result.ok) throw Error('fixture');
  return { input, story: result.value.story };
}
it('normalizes short topics and long Unicode narratives independently of Ask limits', () => {
  expect(normalizeStoryTopic(' e\u0301\r\n next ')).toBe('é\n next');
  expect(normalizeStoryBody(' body\r\n\r\n next ')).toBe('body\n\n next');
  expect(normalizeStoryTopic('🦉'.repeat(300))).not.toBeNull();
  expect(normalizeStoryBody('🦉'.repeat(8000))).not.toBeNull();
  expect(normalizeStoryBody('x'.repeat(2001))).not.toBeNull();
  expect(normalizeStoryTopic('x'.repeat(301))).toBeNull();
  expect(normalizeStoryBody('x'.repeat(8001))).toBeNull();
  for (const value of [null, 4, '', ' ', '\ud800', '\udfff', 'a\tb', 'x\0', '\u0080', 'x'.repeat(32001)]) {
    expect(normalizeStoryTopic(value)).toBeNull(); expect(normalizeStoryBody(value)).toBeNull();
  }
});
it('publishes topic then one long story; list and every ACK omit body and detail explicitly reads it', async () => {
  expect(await listStories(db(), principal, scope)).toMatchObject({ ok: true, value: { stories: [], capacity: 100, used: 0 } });
  const { input, story } = await order();
  expect(story).toMatchObject({ topicAuthorId: principal.userId, storyAuthorId: u2, topicState: 'active', storyState: 'waiting', version: 1 });
  expect(await orderStory(db(), principal, input)).toMatchObject({ ok: true, value: { story, replay: true } });
  expect(await orderStory(db(), principal, { ...input, topic: 'different' })).toEqual({ ok: false, error: 'idempotency_conflict' });
  const body = '🦉'.repeat(8000), telling = { ...command(), storyId: story.id, expectedVersion: 1, body };
  expect(await tellStory(db(), principal, telling)).toEqual({ ok: false, error: 'unavailable' });
  const told = await tellStory(db(), partner, telling);
  expect(told).toMatchObject({ ok: true, value: { story: { version: 2, storyState: 'told', toldAt: '2026-11-10T00:00:00.000Z' } } });
  expect(JSON.stringify(told)).not.toContain(body);
  const listed = await listStories(db(), principal, scope);
  expect(JSON.stringify(listed)).not.toContain(body);
  const detail = { ...scope, storyId: story.id };
  expect(await readStory(db(), principal, detail)).toMatchObject({ ok: true, value: { body, story: { storyState: 'told' } } });
  expect(await readStory(db(), partner, detail)).toMatchObject({ ok: true, value: { body } });
  expect(await tellStory(db(), partner, { ...telling, commandId: id(++number), expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
  const removeTopic = { ...command(), storyId: story.id, expectedVersion: 2 };
  expect(await removeStoryTopic(db(), partner, removeTopic)).toEqual({ ok: false, error: 'unavailable' });
  const removedTopic = await removeStoryTopic(db(), principal, removeTopic);
  expect(removedTopic).toMatchObject({ ok: true, value: { story: { topicState: 'removed', storyState: 'told', version: 3 } } });
  if (!removedTopic.ok) throw Error('fixture');
  expect(removedTopic.value.story).not.toHaveProperty('topic');
  expect(await readStory(db(), principal, detail)).toMatchObject({ ok: true, value: { body } });
  const removeBody = { ...command(), storyId: story.id, expectedVersion: 3 };
  expect(await removeStoryBody(db(), principal, removeBody)).toEqual({ ok: false, error: 'unavailable' });
  expect(await removeStoryBody(db(), partner, removeBody)).toMatchObject({ ok: true, value: { story: { storyState: 'story_removed', version: 4, toldAt: '2026-11-10T00:00:00.000Z' } } });
  const cleared = await readStory(db(), partner, detail);
  expect(cleared).toMatchObject({ ok: true, value: { story: { storyState: 'story_removed' } } });
  if (!cleared.ok) throw Error('fixture');
  expect(cleared.value).not.toHaveProperty('body');
  expect(await tellStory(db(), partner, telling)).toMatchObject({ ok: true, value: { replay: true, story: cleared.value.story } });
  expect(await orderStory(db(), principal, input)).toMatchObject({ ok: true, value: { story: cleared.value.story } });
  expect(await removeStoryBody(db(), partner, { ...removeBody, commandId: id(++number), expectedVersion: 4 })).toEqual({ ok: false, error: 'version_conflict' });
  expect(await removeStoryTopic(db(), principal, { ...removeTopic, commandId: id(++number), expectedVersion: 4 })).toEqual({ ok: false, error: 'version_conflict' });
  expect(JSON.stringify((await pg.query('SELECT * FROM story_commands')).rows)).not.toMatch(/Synthetic|🦉/);
});
it('decline and withdrawal are separate terminal choices; removes own body before topic; pending first', async () => {
  const first = (await order()).story, pending = (await order()).story, withdrawn = (await order()).story;
  const action = (storyId: string, expectedVersion = 1) => ({ ...command(), storyId, expectedVersion });
  expect(await declineStory(db(), principal, action(first.id))).toEqual({ ok: false, error: 'unavailable' });
  expect(await declineStory(db(), partner, action(first.id))).toMatchObject({ ok: true, value: { story: { storyState: 'declined', version: 2 } } });
  expect(await declineStory(db(), partner, action(first.id, 2))).toEqual({ ok: false, error: 'version_conflict' });
  expect(await removeStoryTopic(db(), principal, action(first.id, 2))).toMatchObject({ ok: true, value: { story: { storyState: 'declined', topicState: 'removed' } } });
  expect(await removeStoryTopic(db(), principal, action(withdrawn.id))).toMatchObject({ ok: true, value: { story: { storyState: 'withdrawn', version: 2 } } });
  expect(await tellStory(db(), partner, { ...action(withdrawn.id, 2), body: 'cannot revive' })).toEqual({ ok: false, error: 'version_conflict' });
  const list = await listStories(db(), partner, scope);
  if (!list.ok) throw Error('fixture');
  expect(list.value.stories[0].id).toBe(pending.id);
  const second = (await order()).story;
  expect(await tellStory(db(), partner, { ...action(second.id), body: 'A published story' })).toMatchObject({ ok: true });
  expect(await removeStoryBody(db(), partner, action(second.id, 2))).toMatchObject({ ok: true, value: { story: { topicState: 'active', storyState: 'story_removed' } } });
  const read = await readStory(db(), principal, { ...scope, storyId: pending.id });
  expect(read).toMatchObject({ ok: true, value: { story: { storyState: 'waiting' } } });
  if (read.ok) expect(read.value).not.toHaveProperty('body');
});
it('strict fields, wrong actors, both pairs, waiting/closed/former membership and epoch', async () => {
  const input = { ...command(), topic: 'topic' };
  for (const [operation, data] of [[orderStory, input], [listStories, scope]] as const) {
    for (const coupleId of [c2, waiting, id(999)]) expect(await operation(db(), principal, { ...data, coupleId })).toEqual({ ok: false, error: 'unavailable' });
    for (const actor of [identityPrincipal(outsider), { ...principal, userId: 'bad' }, { ...principal, tokenExpiresAt: 1 }]) expect(await operation(db(), actor, data)).toEqual({ ok: false, error: 'unavailable' });
    expect(await operation(db(), principal, { ...data, membershipEpoch: 2 })).toEqual({ ok: false, error: 'stale_membership' });
    for (const bad of [null, [], {}, { ...data, extra: 1 }, { ...data, coupleId: 'bad' }, { ...data, membershipEpoch: 0 }]) expect(await operation(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  }
  for (const bad of [{ ...input, commandId: 'bad' }, { ...input, topic: '' }]) expect(await orderStory(db(), principal, bad)).toEqual({ ok: false, error: 'invalid_request' });
  for (const bad of [{ ...command(), storyId: 'bad', expectedVersion: 1, body: 'x' }, { ...command(), storyId: id(8), expectedVersion: 0, body: 'x' }, { ...command(), storyId: id(8), expectedVersion: 2147483647, body: 'x' }, { ...command(), storyId: id(8), expectedVersion: 1, body: '' }]) expect(await tellStory(db(), partner, bad)).toEqual({ ok: false, error: 'invalid_request' });
  expect(await readStory(db(), principal, { ...scope, storyId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
  expect(await readStory(db(), principal, { ...scope, storyId: 'bad' })).toEqual({ ok: false, error: 'invalid_request' });
  expect(await readStory(db(), { ...principal, tokenExpiresAt: 1 }, { ...scope, storyId: id(999) })).toEqual({ ok: false, error: 'unavailable' });
  expect(await readStory(db(), principal, { ...scope, membershipEpoch: 2, storyId: id(999) })).toEqual({ ok: false, error: 'stale_membership' });
  expect(await declineStory(db(), partner, { ...command(), storyId: id(999), expectedVersion: 1 })).toEqual({ ok: false, error: 'unavailable' });
  const fresh = (await order()).story;
  expect(await declineStory(db(), partner, { ...command(), storyId: fresh.id, expectedVersion: 2 })).toEqual({ ok: false, error: 'version_conflict' });
});
it('100 lifetime orders include tombstones; tell/decline/removal/read work at capacity', async () => {
  const used = Number((await pg.query<{ n: number }>('SELECT count(*)::int n FROM ordered_stories')).rows[0].n);
  let last = '';
  for (let n = used; n < 100; n++) last = (await order()).story.id;
  expect(await orderStory(db(), principal, { ...command(), topic: 'over' })).toEqual({ ok: false, error: 'capacity_reached' });
  expect(await declineStory(db(), partner, { ...command(), storyId: last, expectedVersion: 1 })).toMatchObject({ ok: true });
  expect(await listStories(db(), principal, scope)).toMatchObject({ ok: true, value: { used: 100, capacity: 100 } });
});
it('SQL prevents content/identity rewrites, resurrection, no-op transitions, physical and receipt deletion', async () => {
  const pending = (await pg.query<{ id: string }>("SELECT id FROM ordered_stories WHERE story_state='waiting' LIMIT 1")).rows[0].id;
  const removed = (await pg.query<{ id: string }>("SELECT id FROM ordered_stories WHERE story_state='story_removed' LIMIT 1")).rows[0].id;
  for (const sql of [
    `UPDATE ordered_stories SET topic='changed',version=version+1 WHERE id='${pending}'`,
    `UPDATE ordered_stories SET told_at=told_at+interval '1 second',version=version+1 WHERE id='${removed}'`,
    `UPDATE ordered_stories SET story_state='waiting',topic_state='active',topic='resurrected',told_at=NULL,version=version+1 WHERE id='${removed}'`,
    'UPDATE ordered_stories SET version=version', 'UPDATE ordered_stories SET sequence=sequence+1,version=version+1',
    'DELETE FROM ordered_stories', 'UPDATE story_commands SET fingerprint=fingerprint', 'DELETE FROM story_commands']) await expect(pg.query(sql)).rejects.toMatchObject({ code: '23514' });
});
it('reads/replays recheck actual session; receipt wait expiry and invalid write acknowledgements roll back', async () => {
  const base = db();
  const intercept = (trigger: string, badRows = false, throws = false) => {
    let revoked = false;
    return { ...base, sessionAuthority: { ...base.sessionAuthority, recheck: async (...args: Parameters<typeof base.sessionAuthority.recheck>) => !revoked && base.sessionAuthority.recheck(...args) },
      transaction: <T>(work: Parameters<typeof base.transaction<T>>[0]) => base.transaction(tx => work({ query: async <R>(sql: string, params?: unknown[]) => {
        const result = await tx.query<R>(sql, params);
        if (sql.includes(trigger)) { if (throws) throw Error('unexpected'); if (badRows) return { rows: [] }; revoked = true; }
        return result;
      } })) };
  };
  expect(await listStories(intercept('ORDER BY'), principal, scope)).toEqual({ ok: false, error: 'unavailable' });
  const actor = identityPrincipal(id(3)), input = { coupleId: c2, membershipEpoch: 1, commandId: id(++number), topic: 'Other pair topic' };
  expect(await orderStory(intercept('AS used FROM ordered_stories'), actor, input)).toEqual({ ok: false, error: 'unavailable' });
  expect(await orderStory(intercept('INSERT INTO story_commands'), actor, input)).toEqual({ ok: false, error: 'unavailable' });
  await expect(orderStory(intercept('INSERT INTO ordered_stories', true), actor, input)).rejects.toThrow('invalid_story_write');
  await expect(orderStory(intercept('INSERT INTO story_commands', true), actor, input)).rejects.toThrow('invalid_story_receipt');
  await expect(orderStory(intercept('INSERT INTO story_commands', false, true), actor, input)).rejects.toThrow('unexpected');
  expect((await pg.query('SELECT id FROM ordered_stories WHERE couple_id=$1', [c2])).rows).toHaveLength(0);
  const saved = await orderStory(base, actor, input);
  if (!saved.ok) throw Error('fixture');
  expect(await orderStory(intercept('AND id=$3 FOR UPDATE'), actor, input)).toEqual({ ok: false, error: 'unavailable' });
  const detail = { coupleId: c2, membershipEpoch: 1, storyId: saved.value.story.id };
  expect(await readStory(intercept('AND id=$3 FOR UPDATE'), actor, detail)).toEqual({ ok: false, error: 'unavailable' });
  const tell = { ...detail, commandId: id(++number), expectedVersion: 1, body: 'Other narrative' };
  const storyteller = identityPrincipal(id(4));
  expect(await tellStory(intercept('AND id=$3 FOR UPDATE'), storyteller, tell)).toEqual({ ok: false, error: 'unavailable' });
  await expect(tellStory(intercept('UPDATE ordered_stories', true), storyteller, tell)).rejects.toThrow('invalid_story_write');
  expect(await tellStory(base, storyteller, tell)).toMatchObject({ ok: true });
  const rollbackClock = { ...base, now: () => new Date('2026-11-09Z') };
  const nextInput = { ...input, commandId: id(++number) };
  const next = await orderStory(base, actor, nextInput);
  if (!next.ok) throw Error('fixture');
  expect(await tellStory({ ...base, now: () => new Date('2020-01-01Z') }, storyteller, { ...tell, storyId: next.value.story.id, commandId: id(++number) })).toEqual({ ok: false, error: 'unavailable' });
  expect(await tellStory(rollbackClock, storyteller, { ...tell, storyId: next.value.story.id, commandId: id(++number) })).toMatchObject({ ok: true, value: { story: { toldAt: next.value.story.createdAt } } });
  expect(await readStory(rollbackClock, actor, detail)).toMatchObject({ ok: true, value: { checkedAt: '2026-11-09T00:00:00.000Z' } });
  await expect(listStories({ ...base, now: () => new Date('bad') }, actor, { coupleId: c2, membershipEpoch: 1 })).rejects.toThrow('invalid_server_clock');
});
