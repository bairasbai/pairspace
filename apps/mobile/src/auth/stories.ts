import type { SyntheticConfig } from './config';
import { validateSyntheticConfig } from './config';
import { readSessionContext } from './context';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { sameDateContext } from './dates-state';
import { readBoundedJson } from '../chat/transport';
import { emptyStories, normalizeStoryBody, normalizeStoryTopic, exact, followsStory, instant, orderStories, record, uuid, validStory,
  mergeStory, reconcileStoryDraft, type StoriesView, type StoryMetadata } from './stories-state';

type Kind = 'order' | 'tell' | 'decline' | 'removeTopic' | 'removeStory';
type Pending = Readonly<{ id: string; kind: Kind; target: string | null; version: number; text: string | null; revision: number }>;
type ReadTarget = Readonly<{ id: string; version: number; generation: number }>;
// Distinct ready controller instances also need distinct UI reset keys.
let nextGeneration = 0;
export function createStoriesController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyStories, bound: InvitationHostSnapshot | null = null, pending: Pending | null = null;
  let sequence = 0, topicRevision = 0, storyRevision = 0, readerGeneration = 0;
  let activeMode: 'list' | 'mutate' | 'read' | null = null, readAbort: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: StoriesView) => { view = Object.freeze(next); for (const listener of listeners) listener(); };
  function reset() {
    sequence++; topicRevision++; storyRevision++; readerGeneration++;
    readAbort?.abort(); readAbort = null; activeMode = null; bound = null; pending = null;
    publish({ ...emptyStories, generation: ++nextGeneration });
  }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity && sameDateContext(current.context, bound.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...view, available: true, userId: current.context.userId }); }
  }
  function close() {
    readerGeneration++; readAbort?.abort(); readAbort = null;
    if (activeMode === 'read') { sequence++; activeMode = null; publish({ ...view, opened: null, readerStatus: 'closed', busy: false }); }
    else publish({ ...view, opened: null, readerStatus: 'closed' });
  }
  async function run(mode: 'list' | 'mutate' | 'read', target?: ReadTarget) {
    if (view.busy || !view.available || !bound || (mode === 'mutate' && (!pending || view.requiresRefresh))) return;
    const expected = bound, command = pending, seq = ++sequence;
    activeMode = mode;
    const abort = mode === 'read' ? new AbortController() : null;
    if (abort) readAbort = abort;
    const boundMatches = () => { const c = host.capture(); return c !== null && c.generation === expected.generation && c.identity === expected.identity && sameDateContext(c.context, expected.context); };
    const current = () => sequence === seq && boundMatches() && (mode !== 'read' || target?.generation === readerGeneration);
    const obsolete = () => { if (current()) return false; sync(); return true; };
    const send = (input: Request) => request(abort ? new Request(input, { signal: abort.signal }) : input);
    publish({ ...view, busy: true, error: false, ...(mode === 'mutate' ? { status: 'saving' as const }
      : mode === 'list' ? { checked: false } : { readerStatus: 'loading' as const, opened: null }) });
    try {
      const cookie = await host.getCookie();
      if (obsolete()) return;
      const binding = await readSessionContext(settings, expected.identity.sessionId, cookie, send);
      if (obsolete()) return;
      if (!binding.ok) {
        if (binding.error !== 'transport_error') { host.block('auth_required'); reset(); return; }
        throw Error('retry');
      }
      if (!sameDateContext(expected.context, binding.value)) { reset(); await host.refresh(); return; }
      const cookieMatches = async () => {
        const matches = await host.getCookie() === cookie;
        if (current() && !matches) { host.block('auth_required'); reset(); }
        return matches && current();
      };
      if (!await cookieMatches()) return;
      const context = binding.value;
      if (context.state !== 'ready') return;
      const kind = command?.kind, mutating = mode === 'mutate';
      const suffix = mode === 'read' ? '/' + target!.id + '/text' : !mutating || !command!.target ? '' : '/' + command!.target
        + (kind === 'tell' || kind === 'removeStory' ? '/story' : kind === 'decline' ? '/decline' : '/topic');
      const payload = mutating ? { membership_epoch: context.membershipEpoch, command_id: command!.id,
        ...(kind !== 'order' ? { expected_version: command!.version } : {}),
        ...(kind === 'order' ? { topic: command!.text } : kind === 'tell' ? { body: command!.text } : {}) } : null;
      const response = await send(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/stories' + suffix
        + (mutating ? '' : '?membership_epoch=' + context.membershipEpoch), {
        method: !mutating ? 'GET' : kind === 'removeTopic' || kind === 'removeStory' ? 'DELETE' : 'POST',
        headers: { Cookie: cookie, Origin: settings.baseURL, ...(mutating ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(mutating ? { body: JSON.stringify(payload) } : {}), credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (obsolete() || !await cookieMatches()) { void response.body?.cancel().catch(() => {}); return; }
      if ([401, 403].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (response.status === 404) { publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true, ...(mode === 'read' ? { readerStatus: 'error' as const } : {}) }); return; }
      const body = await readBoundedJson(response, mode === 'list' ? 262144 : mode === 'read' ? 65536 : 16384);
      if (obsolete() || !await cookieMatches()) return;
      if (record(body) && exact(body, 'ok,error') && body.ok === false) {
        if (response.status === 409 && body.error === 'stale_membership') { host.block('access_required'); reset(); return; }
        if (mode === 'mutate' && response.status === 409 && ['version_conflict', 'idempotency_conflict', 'capacity_reached'].includes(String(body.error))) {
          pending = null; publish({ ...view, pending: false, requiresRefresh: true, checked: false, status: body.error === 'capacity_reached' ? 'limit' : 'conflict', error: true }); return;
        }
        if (mode === 'mutate' && response.status === 400 && body.error === 'invalid_request') {
          pending = null; publish({ ...view, pending: false, status: 'invalid', error: true }); return;
        }
      }
      if (response.status !== 200 || !record(body) || !exact(body, 'ok,value') || body.ok !== true || !record(body.value)) throw Error('retry');
      const value = body.value;
      if (mode === 'list') {
        if (!exact(value, 'stories,checkedAt,capacity,used') || !instant(value.checkedAt) || (view.checkedAt !== null && value.checkedAt < view.checkedAt)
          || value.capacity !== 100 || !Array.isArray(value.stories) || value.stories.length > 100 || value.used !== value.stories.length || Number(value.used) < view.used) throw Error('retry');
        const stories: StoryMetadata[] = [];
        for (const item of value.stories) {
          if (!validStory(item, context) || item.createdAt > value.checkedAt || (item.toldAt && item.toldAt > value.checkedAt)
            || item.sequence > Number(value.used) || stories.some(s => s.id === item.id || s.sequence === item.sequence)
            || (stories.length > 0 && orderStories(stories[stories.length - 1], item) > 0)) throw Error('retry');
          stories.push(item);
        }
        if (view.stories.some(old => { const next = stories.find(s => s.id === old.id); return !next || !followsStory(old, next); })) throw Error('retry');
        const opened = view.opened && stories.some(s => s.id === view.opened!.story.id && s.version === view.opened!.story.version && s.storyState === 'told') ? view.opened : null;
        publish({ ...view, stories, used: Number(value.used), checked: true, checkedAt: value.checkedAt, requiresRefresh: false,
          storyDraft: reconcileStoryDraft(view.storyDraft, stories), opened, readerStatus: opened ? 'opened' : 'closed', status: pending ? 'retry' : 'idle' });
      } else if (mode === 'read') {
        const story = value.story;
        if (!validStory(story, context) || story.id !== target!.id || !exact(value, 'story,checkedAt' + (story.storyState === 'told' ? ',body' : ''))
          || !instant(value.checkedAt) || (view.checkedAt !== null && value.checkedAt < view.checkedAt)
          || story.createdAt > value.checkedAt || (story.toldAt && story.toldAt > value.checkedAt)
          || (story.storyState === 'told' && (typeof value.body !== 'string' || normalizeStoryBody(value.body) !== value.body))) throw Error('retry');
        const latest = view.stories.find(s => s.id === story.id);
        if (!latest || !followsStory(latest, story)) throw Error('retry');
        const merged = mergeStory(view, story), changed = story.version !== target!.version;
        publish({ ...view, ...merged, checked: false, opened: !changed && story.storyState === 'told'
          ? { story, body: value.body as string, checkedAt: value.checkedAt } : null,
          readerStatus: !changed && story.storyState === 'told' ? 'opened' : 'changed' });
      } else {
        const story = value.story;
        if (!exact(value, 'story,commandId,replay') || !validStory(story, context) || value.commandId !== command!.id || typeof value.replay !== 'boolean'
          || (command!.target !== null && story.id !== command!.target) || story.version < Math.max(1, command!.version)
          || (kind === 'order' || kind === 'removeTopic' ? story.topicAuthorId : story.storyAuthorId) !== context.userId) throw Error('retry');
        if ((kind === 'tell' && !['told', 'story_removed'].includes(story.storyState)) || (kind === 'decline' && story.storyState !== 'declined')
          || (kind === 'removeTopic' && story.topicState !== 'removed') || (kind === 'removeStory' && story.storyState !== 'story_removed')) throw Error('retry');
        if (!value.replay && (story.version !== (kind === 'order' ? 1 : command!.version + 1)
          || (kind === 'order' && (story.topicState !== 'active' || story.storyState !== 'waiting' || story.topic !== command!.text))
          || (kind === 'tell' && story.storyState !== 'told'))) throw Error('retry');
        const merged = mergeStory(view, story);
        pending = null;
        publish({ ...view, ...merged, pending: false, checked: false, status: 'saved', readerStatus: merged.opened ? 'opened' : 'closed',
          ...(kind === 'order' && topicRevision === command!.revision ? { topicDraft: '' } : {}),
          ...(kind === 'tell' && view.storyDraft?.id === command!.target && storyRevision === command!.revision ? { storyDraft: null } : {}) });
      }
    } catch {
      if (current()) publish({ ...view, error: true, ...(mode === 'mutate' ? { status: 'retry' as const }
        : { opened: null, ...(mode === 'read' ? { readerStatus: 'error' as const } : { readerStatus: 'closed' as const }) }) });
      else sync();
    } finally {
      if (sequence === seq) { activeMode = null; readAbort = null; if (boundMatches()) publish({ ...view, busy: false }); else sync(); }
    }
  }
  function prepare(kind: Kind, target: string | null = null, confirmed = false) {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    const story = view.stories.find(s => s.id === target);
    if (kind === 'order') {
      if (!view.checked) { publish({ ...view, status: 'conflict', requiresRefresh: true, error: true }); return Promise.resolve(); }
      if (view.used >= 100) { publish({ ...view, status: 'limit' }); return Promise.resolve(); }
    } else {
      if (!story) return Promise.resolve();
      const allowed = kind === 'removeTopic' ? story.topicAuthorId === view.userId && story.topicState === 'active'
        : story.storyAuthorId === view.userId && (kind === 'removeStory' ? story.storyState === 'told' : story.topicState === 'active' && story.storyState === 'waiting');
      if (!allowed || (kind !== 'tell' && !confirmed)) return Promise.resolve();
      if (kind === 'tell' && (!view.storyDraft || view.storyDraft.id !== target || view.storyDraft.version !== story.version || view.storyDraft.stale)) {
        publish({ ...view, status: 'conflict', error: true }); return Promise.resolve();
      }
    }
    const text = kind === 'order' ? normalizeStoryTopic(view.topicDraft) : kind === 'tell' ? normalizeStoryBody(view.storyDraft!.text) : null;
    const id = commandId();
    if (!uuid(id) || ((kind === 'order' || kind === 'tell') && text === null)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    pending = Object.freeze({ id, kind, target, version: story?.version ?? 0, text, revision: kind === 'order' ? topicRevision : storyRevision });
    publish({ ...view, pending: true }); return run('mutate');
  }
  function open(id: string) {
    if (!view.available || pending || view.requiresRefresh || (activeMode !== null && activeMode !== 'read')) return Promise.resolve();
    const story = view.stories.find(s => s.id === id);
    if (story?.storyState !== 'told') return Promise.resolve();
    close(); return run('read', { id, version: story.version, generation: readerGeneration });
  }
  return { reset, sync, actions: {
    getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: () => run('list'), retry: () => run('mutate'), order: () => prepare('order'), tell: () => prepare('tell', view.storyDraft?.id ?? null),
    decline: (id: string, confirm: boolean) => prepare('decline', id, confirm),
    removeTopic: (id: string, confirm: boolean) => prepare('removeTopic', id, confirm), removeStory: (id: string, confirm: boolean) => prepare('removeStory', id, confirm),
    open, close,
    setTopic(text: string) { if (view.available) { topicRevision++; publish({ ...view, topicDraft: text.slice(0, 1200) }); } },
    setStory(text: string) { if (view.available && view.storyDraft) { storyRevision++; publish({ ...view, storyDraft: { ...view.storyDraft, text: text.slice(0, 32000) } }); } },
    beginStory(id: string) {
      const story = view.stories.find(s => s.id === id);
      if (!view.available || view.busy || pending || view.requiresRefresh || story?.topicState !== 'active' || story.storyState !== 'waiting' || story.storyAuthorId !== view.userId) return;
      if (view.storyDraft?.text) return;
      storyRevision++; publish({ ...view, storyDraft: { id, version: story.version, text: '' }, status: 'idle', error: false });
    },
    cancelTopic() { topicRevision++; publish({ ...view, topicDraft: '' }); },
    cancelStory() { storyRevision++; publish({ ...view, storyDraft: null }); },
  } };
}
export type StoriesActions = ReturnType<typeof createStoriesController>['actions'];
