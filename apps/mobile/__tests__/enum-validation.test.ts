import { followsStory, validStory, type StoryMetadata } from '../../../packages/domain/stories/metadata.ts';
import { canAdvanceDoing, completeDoing, followsDoing, validDoing, type SharedDoing } from '../../../packages/domain/doings/state.ts';
import { canReadQuestion, followsQuestion, validQuestion, type HardQuestion } from '../../../packages/domain/hard/metadata.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { coupleId: id(10), membershipEpoch: 1, userId: id(1) };
const common = { id: id(20), coupleId: scope.coupleId, authorId: id(1), recipientId: id(2),
  membershipEpoch: 1, sequence: 1, version: 1, createdAt: '2026-11-10T00:00:00.000Z' };
const storyBase = { id: common.id, coupleId: common.coupleId, topicAuthorId: id(1), storyAuthorId: id(2),
  membershipEpoch: 1, sequence: 1, version: 1, createdAt: common.createdAt };
const stories: StoryMetadata[] = [
  { ...storyBase, topicState: 'active', storyState: 'waiting', topic: 'Synthetic topic' },
  { ...storyBase, topicState: 'active', storyState: 'told', topic: 'Synthetic topic', version: 2, toldAt: common.createdAt },
  { ...storyBase, topicState: 'active', storyState: 'declined', topic: 'Synthetic topic', version: 2 },
  { ...storyBase, topicState: 'removed', storyState: 'withdrawn', version: 2 },
  { ...storyBase, topicState: 'removed', storyState: 'story_removed', version: 4, toldAt: common.createdAt },
];
const doingBase = { ...common, contentState: 'active' as const, title: 'Synthetic course',
  kind: 'course' as const, parts: 2, authorAt: 0 };
const doings: SharedDoing[] = [
  { ...doingBase, decisionState: 'invited' },
  { ...doingBase, decisionState: 'joined', recipientAt: 0, version: 2 },
  { ...doingBase, decisionState: 'declined', version: 2 },
  { ...common, contentState: 'removed', decisionState: 'withdrawn', version: 2 },
  { ...common, contentState: 'removed', decisionState: 'joined', version: 3 },
  { ...common, contentState: 'removed', decisionState: 'declined', version: 3 },
];
const questions: HardQuestion[] = [
  { ...common, contentState: 'active', decisionState: 'sealed' },
  { ...common, contentState: 'active', decisionState: 'opened', version: 2, openedAt: common.createdAt },
  { ...common, contentState: 'active', decisionState: 'declined', version: 2 },
  { ...common, contentState: 'removed', decisionState: 'withdrawn', version: 2 },
  { ...common, contentState: 'removed', decisionState: 'opened', version: 3, openedAt: common.createdAt },
  { ...common, contentState: 'removed', decisionState: 'declined', version: 3 },
];
function malformed(state: string): unknown[] {
  return [[state], { toString: () => state }, Object(state),
    { toString: () => { throw Error('enum coercion must not execute'); } }, true, false, null, 0, 1, 'unknown'];
}

it('preserves valid literal states, identity replay, and legitimate progression', () => {
  for (const value of stories) {
    expect(validStory(value, scope)).toBe(true);
    expect(followsStory(value, value)).toBe(true);
    expect(followsStory(stories[0], value)).toBe(true);
  }
  for (const value of doings) {
    expect(validDoing(value, scope)).toBe(true);
    expect(followsDoing(value, value)).toBe(true);
    expect(followsDoing(doings[0], value)).toBe(true);
  }
  for (const value of questions) {
    expect(validQuestion(value, scope)).toBe(true);
    expect(followsQuestion(value, value)).toBe(true);
    expect(followsQuestion(questions[0], value)).toBe(true);
    expect(canReadQuestion(value, id(1))).toBe(value.contentState === 'active');
    expect(canReadQuestion(value, id(2))).toBe(value.contentState === 'active' && value.decisionState === 'opened');
  }
  expect(canAdvanceDoing(doings[0], id(1))).toBe(true);
  expect(canAdvanceDoing(doings[1], id(2))).toBe(true);
  expect(completeDoing({ ...doingBase, decisionState: 'joined', version: 4, authorAt: 2, recipientAt: 2 })).toBe(true);
});
it.each(['topicState', 'storyState'] as const)('stories reject malformed %s in validators and both progression operands', field => {
  for (const value of stories) for (const state of malformed(value[field])) {
    const bad = { ...value, [field]: state } as StoryMetadata;
    expect(validStory(bad, scope)).toBe(false);
    expect(followsStory(bad, bad)).toBe(false);
    expect(followsStory(value, bad)).toBe(false);
    expect(followsStory(bad, value)).toBe(false);
  }
});
it.each(['contentState', 'decisionState'] as const)('doings reject malformed %s in validators and access/progression gates', field => {
  for (const value of doings) for (const state of malformed(value[field])) {
    const bad = { ...value, [field]: state } as SharedDoing;
    expect(validDoing(bad, scope)).toBe(false);
    expect(followsDoing(bad, bad)).toBe(false);
    expect(followsDoing(value, bad)).toBe(false);
    expect(followsDoing(bad, value)).toBe(false);
    expect(canAdvanceDoing(bad, id(1))).toBe(false);
    expect(canAdvanceDoing(bad, id(2))).toBe(false);
    expect(completeDoing(bad)).toBe(false);
  }
});
it.each(['contentState', 'decisionState'] as const)('hard questions reject malformed %s in validators and access/progression gates', field => {
  for (const value of questions) for (const state of malformed(value[field])) {
    const bad = { ...value, [field]: state } as HardQuestion;
    expect(validQuestion(bad, scope)).toBe(false);
    expect(followsQuestion(bad, bad)).toBe(false);
    expect(followsQuestion(value, bad)).toBe(false);
    expect(followsQuestion(bad, value)).toBe(false);
    expect(canReadQuestion(bad, id(1))).toBe(false);
    expect(canReadQuestion(bad, id(2))).toBe(false);
  }
});
it('rejects the audited missing-text and missing-event shapes', () => {
  expect(validStory({ ...storyBase, topicState: ['active'], storyState: 'declined', version: 3 }, scope)).toBe(false);
  expect(validStory({ ...storyBase, topicState: 'active', storyState: ['waiting'], topic: 'Synthetic topic', version: 2 }, scope)).toBe(false);
  expect(validDoing({ ...common, contentState: ['active'], decisionState: 'withdrawn', version: 2 }, scope)).toBe(false);
  expect(validDoing({ ...doingBase, decisionState: ['joined'], version: 2 }, scope)).toBe(false);
  expect(validQuestion({ ...common, contentState: ['active'], decisionState: 'withdrawn', version: 2 }, scope)).toBe(false);
  expect(validQuestion({ ...common, contentState: 'active', decisionState: ['opened'], version: 2 }, scope)).toBe(false);
});
