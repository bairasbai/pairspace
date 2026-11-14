import { expect, it } from 'vitest';
import { exact, followsStory, instant, orderStories, record, uuid, validStory, type StoryMetadata } from '../../../packages/domain/stories/metadata.ts';
import { id } from './fixtures.ts';
const scope = { coupleId: id(10), membershipEpoch: 1, userId: id(1) };
const base: StoryMetadata = { id: id(20), coupleId: scope.coupleId, topicAuthorId: id(1), storyAuthorId: id(2), membershipEpoch: 1,
  sequence: 1, version: 1, createdAt: '2026-11-13T00:00:00.000Z', topicState: 'active', storyState: 'waiting', topic: 'A topic' };
function row(topicState: StoryMetadata['topicState'], storyState: StoryMetadata['storyState']): StoryMetadata {
  const timed = storyState === 'told' || storyState === 'story_removed';
  const version = storyState === 'waiting' ? 1 : storyState === 'withdrawn' ? 2 : (storyState === 'story_removed' ? 3 : 2) + (topicState === 'removed' ? 1 : 0);
  const identity = { ...base };
  delete identity.topic;
  return { ...identity, topicState, storyState, version, ...(topicState === 'active' ? { topic: 'A topic' } : {}), ...(timed ? { toldAt: base.createdAt } : {}) };
}
const states = [base, row('active', 'told'), row('removed', 'told'), row('active', 'declined'), row('removed', 'declined'),
  row('removed', 'withdrawn'), row('active', 'story_removed'), row('removed', 'story_removed')];
it('accepts exactly eight legal metadata shapes without story bodies or fake absence fields', () => {
  for (const value of states) {
    expect(validStory(value, scope)).toBe(true);
    for (const extra of [{ body: 'never in metadata' }, { preview: '' }, { unknown: 1 }]) expect(validStory({ ...value, ...extra }, scope)).toBe(false);
  }
  expect(validStory(row('active', 'withdrawn'), scope)).toBe(false);
  expect(validStory(row('removed', 'waiting'), scope)).toBe(false);
  for (const bad of [null, [], 4, {}, { ...base, topicState: 'other' }, { ...base, storyState: 'other' },
    { ...base, id: 'bad' }, { ...base, topicAuthorId: 'bad' }, { ...base, storyAuthorId: 'bad' },
    { ...base, storyAuthorId: base.topicAuthorId }, { ...base, topicAuthorId: id(3), storyAuthorId: id(4) },
    { ...base, coupleId: id(11) }, { ...base, membershipEpoch: 2 }, { ...base, sequence: 0 },
    { ...base, sequence: 101 }, { ...base, sequence: 1.5 }, { ...base, createdAt: 'bad' },
    { ...base, topic: ' changed ' }, { ...base, topic: 4 }, { ...base, version: 2 },
    { ...states[1], toldAt: '2020-01-01T00:00:00.000Z' }, { ...states[1], toldAt: 'bad' }]) expect(validStory(bad, scope)).toBe(false);
});
it('enforces all terminal/version fences and permits a canonical multi-transition jump', () => {
  const permitted = [[0,1,2,3,4,5,6,7], [1,2,6,7], [2,7], [3,4], [4], [5], [6,7], [7]];
  for (let a = 0; a < states.length; a++) for (let b = 0; b < states.length; b++) expect(followsStory(states[a], states[b])).toBe(permitted[a].includes(b));
  for (const value of [{ ...base, id: id(21) }, { ...base, topic: 'different' }, { ...base, version: 0 },
    { ...states[1], toldAt: '2026-11-14T00:00:00.000Z' }, { ...base, sequence: 2 }]) expect(followsStory(states[1], value)).toBe(false);
  expect(followsStory(base, { ...base, topic: 'different' })).toBe(false);
  expect(followsStory(states[1], { ...states[1], toldAt: '2026-11-14T00:00:00.000Z' })).toBe(false);
  expect(followsStory(states[2], states[1])).toBe(false);
  const sorted = [states[1], { ...base, id: id(22), sequence: 2 }, base].sort(orderStories);
  expect(sorted.map(s => s.sequence)).toEqual([2,1,1]);
});
it('strict helpers reject unknown keys, nonrecords and noncanonical instants', () => {
  expect(record({})).toBe(true); expect(record(null)).toBe(false); expect(record([])).toBe(false);
  expect(exact({ a: 1, b: 2 }, 'b,a')).toBe(true); expect(exact({ a: 1 }, 'a,b')).toBe(false);
  expect(uuid(id(1))).toBe(true); expect(uuid(3)).toBe(false); expect(uuid('bad')).toBe(false);
  expect(instant(base.createdAt)).toBe(true);
  for (const x of [1, '', '2026-02-30T00:00:00.000Z', '2026-01-01Z', '2026-99-01T00:00:00.000Z']) expect(instant(x)).toBe(false);
});
