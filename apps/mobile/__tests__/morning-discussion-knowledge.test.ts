import { createMorningDiscussionKnowledge } from '../src/auth/morning-discussion-knowledge';
import type { V2DiscussionMessage } from '../src/auth/morning-discussion-v2-model';
import { message as original, id } from './morning-discussions.fixture';
const message = (n = 1): V2DiscussionMessage => ({ ...original(n), version: 1, editedAt: null, deletedAt: null });
const edited = (n = 1): V2DiscussionMessage => ({ ...message(n), version: 2, editedAt: message().createdAt, body: `edited ${n}` });
const dead = (n = 1): V2DiscussionMessage => ({ ...edited(n), version: 3, deletedAt: message().createdAt, body: null });
const digest = jest.fn(async (body: string) => body === 'contradiction' ? 'b'.repeat(64) : 'a'.repeat(64));
test('retains only counts of edited metadata and terminal facts, commits once', async () => {
  const k = createMorningDiscussionKnowledge(digest);
  let stage = await k.prepare([message()]); expect(stage?.messages).toEqual([message()]); expect(stage?.commit()).toBe(true);
  expect(stage?.isCurrent()).toBe(false); expect(stage?.commit()).toBe(false); expect(k.sizes()).toEqual({ edited: 0, terminal: 0 });
  stage = await k.prepare([edited()]); expect(stage?.commit()).toBe(true); expect(k.sizes().edited).toBe(1);
  expect(await k.prepare([message()])).toBeNull();
  expect(await k.prepare([{ ...edited(), body: 'contradiction' }])).toBeNull();
  stage = await k.prepare([dead()]); expect(stage?.commit()).toBe(true); expect(k.sizes()).toEqual({ edited: 0, terminal: 1 });
  stage = await k.prepare([{ ...edited(), version: 99 }]); expect(stage?.messages).toEqual([dead()]); expect(stage?.commit()).toBe(true);
});
test('same version must preserve edits/tombstone metadata, identities and scoped aliases', async () => {
  const k = createMorningDiscussionKnowledge(digest); (await k.prepare([edited()]))!.commit();
  for (const patch of [{ slotId: id(99) }, { authorId: id(99) }, { membershipEpoch: 2 }, { seq: 4 },
    { clientId: id(99) }, { createdAt: '2031-01-01T00:00:00.000Z' }, { editedAt: '2031-01-01T00:00:00.000Z' },
    { id: id(99) }]) expect(await k.prepare([{ ...edited(), ...patch }])).toBeNull();
  (await k.prepare([dead()]))!.commit();
  for (const patch of [{ version: 4 }, { editedAt: null }, { deletedAt: '2031-01-01T00:00:00.000Z' }])
    expect(await k.prepare([{ ...dead(), ...patch }])).toBeNull();
  expect((await k.prepare([dead()]))?.commit()).toBe(true);
});
test('visible immutable bodies reject contradictory or lower snapshots without retaining plaintext', async () => {
  const k = createMorningDiscussionKnowledge(digest);
  expect(await k.prepare([{ ...message(), body: 'changed' }], [message()])).toBeNull();
  expect(await k.prepare([message()], [edited()])).toBeNull();
  expect(await k.prepare([{ ...edited(), version: 4 }], [dead()])).toBeNull();
  expect((await k.prepare([edited()], [message()]))?.commit()).toBe(true);
});
test('staging is atomic, terminal commits dominate concurrent live preparations', async () => {
  const k = createMorningDiscussionKnowledge(digest);
  const live = await k.prepare([edited()]), terminal = await k.prepare([dead()]);
  expect(terminal?.commit()).toBe(true); expect(live?.commit()).toBe(false);
  expect((await k.prepare([message()]))?.messages).toEqual([dead()]);
  const staged = await k.prepare([dead()]); k.reset(); expect(staged?.commit()).toBe(false); expect(k.sizes()).toEqual({ edited: 0, terminal: 0 });
});
test('reset during hashing cancels result and bad digest fails closed', async () => {
  let resolve!: (hash: string) => void;
  const k = createMorningDiscussionKnowledge(() => new Promise<string>(r => { resolve = r; }));
  const preparing = k.prepare([edited()]); k.reset(); resolve('a'.repeat(64)); expect(await preparing).toBeNull();
  await expect(createMorningDiscussionKnowledge(async () => 'not hash').prepare([edited()])).rejects.toThrow('invalid_digest');
});
test('independent non-evicting limits reject atomically rather than discard known facts', async () => {
  expect(() => createMorningDiscussionKnowledge(digest, 0)).toThrow('invalid_knowledge_limit');
  const k = createMorningDiscussionKnowledge(digest, 1); (await k.prepare([edited()]))!.commit();
  await expect(k.prepare([edited(2)])).rejects.toThrow('edit_knowledge_limit'); expect(k.sizes().edited).toBe(1);
  (await k.prepare([dead()]))!.commit(); await expect(k.prepare([dead(2)])).rejects.toThrow('terminal_knowledge_limit');
  expect(k.sizes()).toEqual({ edited: 0, terminal: 1 });
});
test('input plaintext mutations during awaited hashing cannot alter staged canonical message', async () => {
  let resolve!: (hash: string) => void;
  const k = createMorningDiscussionKnowledge(() => new Promise<string>(r => { resolve = r; }));
  const input = edited(), preparing = k.prepare([input]); input.body = 'mutated caller'; resolve('a'.repeat(64));
  const stage = await preparing; expect(stage?.messages[0].body).toBe('edited 1'); expect(stage?.commit()).toBe(true);
});
