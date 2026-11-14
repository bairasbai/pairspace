import { normalizeStoryTopic, normalizeStoryBody } from '../../../../packages/domain/stories/text';
import { exact, followsStory, instant, orderStories, record, uuid, validStory, type StoryMetadata } from '../../../../packages/domain/stories/metadata';
export { normalizeStoryTopic, normalizeStoryBody, exact, followsStory, instant, orderStories, record, uuid, validStory };
export type { StoryMetadata };
export type StoryDraft = Readonly<{ id: string; version: number; text: string; stale?: 'changed' | 'terminal' }>;
export type StoriesView = Readonly<{
  generation: number;
  available: boolean; userId: string | null; busy: boolean; checked: boolean; checkedAt: string | null;
  stories: readonly StoryMetadata[]; used: number; capacity: 100;
  topicDraft: string; storyDraft: StoryDraft | null;
  opened: Readonly<{ story: StoryMetadata; body: string; checkedAt: string }> | null;
  readerStatus: 'closed' | 'loading' | 'opened' | 'changed' | 'error';
  pending: boolean; requiresRefresh: boolean; error: boolean;
  status: 'idle' | 'saving' | 'retry' | 'saved' | 'invalid' | 'conflict' | 'unavailable' | 'limit';
}>;
export const emptyStories: StoriesView = Object.freeze({ generation: 0, available: false, userId: null, busy: false, checked: false, checkedAt: null,
  stories: [], used: 0, capacity: 100, topicDraft: '', storyDraft: null, opened: null,
  readerStatus: 'closed', pending: false, requiresRefresh: false, error: false, status: 'idle' });
export function reconcileStoryDraft(draft: StoryDraft | null, stories: readonly StoryMetadata[]): StoryDraft | null {
  if (!draft) return null;
  const next = stories.find(s => s.id === draft.id);
  if (next?.topicState === 'active' && next.storyState === 'waiting' && next.version === draft.version) return draft;
  return draft.text ? { ...draft, stale: next?.topicState === 'active' && next.storyState === 'waiting' ? 'changed' : 'terminal' } : null;
}
/** A canonical single-record ACK may leave history gaps; only full GET proves completeness. */
export function mergeStory(view: StoriesView, next: StoryMetadata): Pick<StoriesView, 'stories' | 'used' | 'storyDraft' | 'opened'> {
  const old = view.stories.find(s => s.id === next.id);
  if ((old && !followsStory(old, next)) || view.stories.some(s => s.id !== next.id && s.sequence === next.sequence)
    || (!old && view.stories.length >= 100)) throw Error('invalid_story_revision');
  const stories = [...view.stories.filter(s => s.id !== next.id), next].sort(orderStories);
  const opened = view.opened && view.opened.story.id === next.id
    && (view.opened.story.version !== next.version || next.storyState !== 'told') ? null : view.opened;
  return { stories, used: Math.max(view.used, next.sequence), storyDraft: reconcileStoryDraft(view.storyDraft, stories), opened };
}
