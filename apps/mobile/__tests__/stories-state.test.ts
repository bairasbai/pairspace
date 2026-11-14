import { emptyStories, mergeStory, reconcileStoryDraft } from '../src/auth/stories-state';
import { own, incoming, told, removed, uuid } from './stories-fixtures';
it('keeps a single-record sequence gap unconfirmed and fences removed metadata', () => {
  const view = { ...emptyStories, stories: [own], used: 1 }, third = { ...incoming, id: uuid(30), sequence: 3 };
  const merged = mergeStory(view, third);
  expect(merged.used).toBe(3); expect(merged.stories).toHaveLength(2);
  expect(() => mergeStory(view, incoming)).toThrow('invalid_story_revision');
  expect(() => mergeStory({ ...view, stories: [removed] }, told)).toThrow('invalid_story_revision');
  expect(() => mergeStory({ ...view, stories: Array.from({ length: 100 }, (_, i) => ({ ...own, id: uuid(100 + i), sequence: i + 1 })) }, { ...third, sequence: 100 })).toThrow('invalid_story_revision');
});
it('retains newer private draft as stale, clears empty draft, and closes a revised reader', () => {
  const draft = { id: incoming.id, version: 1, text: 'Newer private RAM' };
  expect(reconcileStoryDraft(null, [])).toBeNull();
  expect(reconcileStoryDraft(draft, [incoming])).toEqual(draft);
  expect(reconcileStoryDraft(draft, [told])).toMatchObject({ text: draft.text, stale: 'terminal' });
  expect(reconcileStoryDraft({ ...draft, version: 0 }, [incoming])).toMatchObject({ stale: 'changed' });
  expect(reconcileStoryDraft({ ...draft, text: '' }, [told])).toBeNull();
  const view = { ...emptyStories, stories: [told], used: 1, opened: { story: told, body: 'Published', checkedAt: '2026-11-11T00:00:00.000Z' } };
  expect(mergeStory(view, told).opened).toEqual(view.opened);
  expect(mergeStory(view, removed).opened).toBeNull();
});
