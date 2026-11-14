import { normalizeStoryTopic } from './text.ts';

export type StoryMetadata = Readonly<{
  id: string; coupleId: string; topicAuthorId: string; storyAuthorId: string;
  membershipEpoch: number; sequence: number; version: number; createdAt: string;
  topicState: 'active' | 'removed';
  storyState: 'waiting' | 'told' | 'declined' | 'withdrawn' | 'story_removed';
  topic?: string; toldAt?: string;
}>;
export type StoryScope = Readonly<{ coupleId: string; membershipEpoch: number; userId: string }>;
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function instant(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
export function validStory(v: unknown, scope: StoryScope): v is StoryMetadata {
  if (!record(v) || !['active', 'removed'].includes(String(v.topicState))
    || !['waiting', 'told', 'declined', 'withdrawn', 'story_removed'].includes(String(v.storyState))) return false;
  const active = v.topicState === 'active', timed = ['told', 'story_removed'].includes(String(v.storyState));
  if (!exact(v, 'id,coupleId,topicAuthorId,storyAuthorId,membershipEpoch,sequence,version,createdAt,topicState,storyState'
      + (active ? ',topic' : '') + (timed ? ',toldAt' : ''))
    || !uuid(v.id) || !uuid(v.topicAuthorId) || !uuid(v.storyAuthorId) || v.topicAuthorId === v.storyAuthorId
    || ![v.topicAuthorId, v.storyAuthorId].includes(scope.userId) || v.coupleId !== scope.coupleId || v.membershipEpoch !== scope.membershipEpoch
    || !instant(v.createdAt) || !Number.isInteger(v.sequence) || Number(v.sequence) < 1 || Number(v.sequence) > 100) return false;
  if ((!active && v.storyState === 'waiting') || (active && v.storyState === 'withdrawn')) return false;
  const version = v.storyState === 'waiting' ? 1 : v.storyState === 'withdrawn' ? 2
    : (v.storyState === 'story_removed' ? 3 : 2) + (active ? 0 : 1);
  if (v.version !== version || (active && (typeof v.topic !== 'string' || normalizeStoryTopic(v.topic) !== v.topic))) return false;
  return !timed || (instant(v.toldAt) && v.toldAt >= v.createdAt);
}
export function followsStory(old: StoryMetadata, next: StoryMetadata): boolean {
  if (!['id', 'coupleId', 'topicAuthorId', 'storyAuthorId', 'membershipEpoch', 'sequence', 'createdAt']
    .every(k => old[k as keyof StoryMetadata] === next[k as keyof StoryMetadata]) || next.version < old.version) return false;
  if (old.topicState === 'removed' && next.topicState !== 'removed') return false;
  if (old.topicState === 'active' && next.topicState === 'active' && old.topic !== next.topic) return false;
  if (old.storyState !== 'waiting' && next.storyState !== old.storyState
    && !(old.storyState === 'told' && next.storyState === 'story_removed')) return false;
  if (old.toldAt && old.toldAt !== next.toldAt) return false;
  const topicStep = old.topicState !== next.topicState && next.storyState !== 'withdrawn' ? 1 : 0;
  const storySteps = old.storyState === next.storyState ? 0 : old.storyState === 'waiting' && next.storyState === 'story_removed' ? 2 : 1;
  const steps = topicStep + storySteps;
  return next.version === old.version + steps && (steps > 0 || Object.keys(old).every(k => old[k as keyof StoryMetadata] === next[k as keyof StoryMetadata]));
}
export const orderStories = (a: StoryMetadata, b: StoryMetadata) => Number(b.storyState === 'waiting') - Number(a.storyState === 'waiting') || b.sequence - a.sequence;
