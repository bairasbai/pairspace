import { webBodyDigest, type BodyDigest } from '../chat/edit-knowledge';
import { createMorningDiscussionKnowledge } from './morning-discussion-knowledge';
import { createMorningDiscussionMutations, type DiscussionEditor, type DiscussionDelete } from './morning-discussion-mutations';
import { normalizeMessageText } from '../chat/text';
import { historyReadId } from '../chat/read-identity';
import { keys, uuid } from '../chat/reply-model';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { requestMorning, sameMorningContext } from './morning-request';
import { parseMorningSlot, canonicalMorningSlot, type MorningSlot, type MorningScope } from './morning-model';
import { parseV2Message, parseV2Page, type V2DiscussionMessage as DiscussionMessage, type V2DiscussionPage as DiscussionPage } from './morning-discussion-v2-model';

type Draft = { text: string; revision: number; slot: MorningSlot };
type Command = { id: string; body: string; revision: number; slot: MorningSlot };
type Direction = 'first' | 'last' | 'before' | 'after';
export type MorningDiscussionView = Readonly<{
  available: boolean;
  userId?: string;
  slot: MorningSlot | null;
  messages: readonly DiscussionMessage[];
  history: DiscussionPage | null;
  draft: string;
  savedDraftSlots: readonly MorningSlot[];
  busy: boolean;
  status: 'idle' | 'ready' | 'sending' | 'sent' | 'unknown' | 'invalid' | 'error';
  error?: string;
  pendingId?: string;
  pendingSlot?: MorningSlot;
  editor: DiscussionEditor;
  deletion: DiscussionDelete;
  suspended?: boolean;
}>;
const empty: MorningDiscussionView = { available: false, slot: null, messages: [], history: null,
  draft: '', savedDraftSlots: [], busy: false, status: 'idle',
  editor: { draft: '', needsReload: false, status: 'idle' }, deletion: { status: 'idle' } };

/** One current 30-message window, 30 private drafts, and one immutable unresolved command. */
export function createMorningDiscussionsController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string, digest?: BodyDigest) {
  const settings = Object.freeze({ ...config });
  validateSyntheticConfig(settings);
  let bound: InvitationHostSnapshot | null = null;
  let view = empty, readSequence = 0, draftRevision = 0;
  let pending: Command | null = null;
  let writing = false;
  const knowledge = createMorningDiscussionKnowledge(digest);
  const drafts = new Map<string, Draft>();
  const listeners = new Set<() => void>();
  let accepting = false;
  const publish = (patch: Partial<MorningDiscussionView>) => {
    view = { ...view, ...patch };
    if (!accepting) listeners.forEach(listener => listener());
  };
  const scope = (): MorningScope | null => bound?.context.state === 'ready' ? bound.context : null;
  function reset() {
    bound = null; pending = null; writing = false;
    readSequence++; draftRevision++;
    drafts.clear(); knowledge.reset(); view = empty; mutations.reset(); listeners.forEach(listener => listener());
  }
  function sync() {
    const next = host.capture();
    if (bound && next && bound.identity === next.identity && bound.generation === next.generation
      && sameMorningContext(bound.context, next.context)) return;
    reset();
    if (next?.context.state === 'ready') {
      bound = next; publish({ available: true, userId: next.context.userId });
    }
  }
  function current(expected: InvitationHostSnapshot) {
    const next = host.capture();
    return bound === expected && next !== null && next.identity === expected.identity
      && next.generation === expected.generation && sameMorningContext(next.context, expected.context);
  }
  async function security(error: string) {
    if (!['auth_required', 'access_required', 'scope_changed'].includes(error)) return false;
    reset();
    if (error === 'scope_changed') await host.refresh();
    else host.block(error);
    return true;
  }
  const saved = () => [...drafts.values()].map(draft => draft.slot);
  function select(slot: MorningSlot) {
    const s = scope(), parsed = s && parseMorningSlot(slot, s);
    if (!parsed || parsed.state !== 'available'
      || (parsed.recipientId === s!.userId ? !parsed.openedAt : !parsed.prepared)) return false;
    const prior = drafts.get(parsed.id)?.slot;
    if (prior && !canonicalMorningSlot(prior, parsed)) return false;
    readSequence++;
    mutations.actions.cancelDelete();
    publish({ slot: parsed, messages: [], history: null, draft: drafts.get(parsed.id)?.text ?? '',
      busy: writing, status: 'ready', error: undefined });
    return true;
  }
  function close() {
    readSequence++;
    mutations.actions.cancelDelete();
    publish({ slot: null, messages: [], history: null, draft: '', busy: writing, error: undefined });
  }
  function setDraft(text: string) {
    if (!bound || !view.slot || typeof text !== 'string' || [...text].length > 8000) return;
    if (text && !drafts.has(view.slot.id) && drafts.size >= 30) {
      publish({ status: 'invalid', error: 'draft_limit' }); return;
    }
    if (text === view.draft) return;
    draftRevision++;
    if (text) drafts.set(view.slot.id, { text, revision: draftRevision, slot: view.slot });
    else drafts.delete(view.slot.id);
    publish({ draft: text, savedDraftSlots: saved(), error: undefined });
  }
  async function accept(messages: readonly DiscussionMessage[], cookie: string, valid: () => boolean) {
    const expected = bound;
    if (!expected || !current(expected) || !valid() || view.suspended) return null;
    try {
      const staged = await knowledge.prepare(messages, view.messages);
      if (!current(expected)) return null;
      const freshCookie = await host.getCookie();
      if (!current(expected)) return null;
      if (freshCookie !== cookie) { await security('auth_required'); return null; }
      if (!valid() || !staged || !staged.isCurrent() || !staged.commit()) return null;
      const accepted = staged.messages;
      accepting = true;
      for (const message of accepted) {
        mutations.observe(message);
        if (message.deletedAt && pending?.id === message.clientId && message.authorId === scope()?.userId) {
          const draft = drafts.get(pending.slot.id);
          if (draft?.revision === pending.revision) {
            drafts.delete(pending.slot.id);
            if (view.slot?.id === pending.slot.id) publish({ draft: '' });
          }
          pending = null;
          publish({ pendingId: undefined, pendingSlot: undefined, savedDraftSlots: saved(), status: 'sent' });
        }
      }
      const replace = (old: DiscussionMessage) => accepted.find(next => next.id === old.id) ?? old;
      accepting = false;
      publish({ messages: view.messages.map(replace),
        history: view.history ? { ...view.history, messages: view.history.messages.map(replace) } : null });
      return accepted;
    } catch (error) {
      accepting = false;
      if (!current(expected) || !valid()) return null;
      const reason = error instanceof Error ? error.message : 'invalid_response';
      if (reason.includes('limit')) {
        accepting = true;
        if (pending && messages.some(message => message.deletedAt && message.clientId === pending!.id
          && message.authorId === scope()?.userId)) {
          if (drafts.get(pending.slot.id)?.revision === pending.revision) {
            drafts.delete(pending.slot.id);
            if (view.slot?.id === pending.slot.id) publish({ draft: '' });
          }
        }
        mutations.suspend();
        accepting = false;
        publish({ suspended: true, messages: [], history: null, status: 'error', error: reason });
      } else publish({ status: 'error', error: 'invalid_response' });
      return null;
    }
  }
  const mutations = createMorningDiscussionMutations({
    capture: () => bound,
    digest: digest ?? webBodyDigest,
    current,
    busy: () => view.busy || !!pending || !!view.suspended,
    find: id => {
      const message = view.messages.find(item => item.id === id);
      return message && view.slot ? { message, slot: view.slot } : null;
    },
    parse: (raw, slot) => scope() ? parseV2Message(raw, scope()!, slot) : null,
    publish: (editor, deletion) => publish({ editor, deletion }),
    accept: async (message, cookie, valid) => (await accept([message], cookie, valid))?.[0] ?? null,
    async exchange(slot, method, id, command, body) {
      const expected = bound;
      if (!expected) return { ok: false, error: 'stale' };
      const readId = historyReadId();
      const result = await requestMorning(settings, host, expected, () => current(expected), request, {
        path: `/slots/${slot.id}/discussion-v2/${id}`, method, readId, commandId: command, body, canonicalDeleted: true,
      });
      if (!current(expected)) return { ok: false, error: 'stale' };
      if (!result.ok && await security(result.error)) return { ok: false, error: 'stale' };
      if (result.ok && method === 'GET' && (!keys(result.value, 'readId,message') || result.value.readId !== readId))
        return { ok: false, error: 'invalid_response' };
      return result;
    },
  }, commandId);
  async function read(direction: Direction = 'first') {
    if (!bound || !view.slot || view.busy || view.suspended) return;
    const expected = bound, slot = view.slot, s = scope()!, serial = ++readSequence;
    const anchor = direction === 'before' ? view.history?.previousCursor
      : direction === 'after' ? view.history?.nextCursor : undefined;
    if ((direction === 'before' || direction === 'after') && !anchor) return;
    const readId = historyReadId();
    publish({ busy: true, error: undefined });
    try {
      const result = await requestMorning(settings, host, expected, () => current(expected), request, {
        path: `/slots/${slot.id}/discussion-v2`, readId,
        query: { direction, ...(anchor ? { anchor_id: anchor.id, anchor_seq: String(anchor.seq) } : {}) },
      });
      if (!current(expected)) return;
      if (!result.ok && await security(result.error)) return;
      if (serial !== readSequence) return;
      if (!result.ok) {
        publish({ status: 'error', error: result.error,
          ...(result.error === 'invalid_cursor' ? { history: null } : {}) }); return;
      }
      const page = parseV2Page(result.value, s, slot, readId, direction, anchor ?? undefined);
      if (!page) throw Error('invalid_response');
      const accepted = await accept(page.messages, result.cookie, () => current(expected) && serial === readSequence);
      if (!current(expected) || serial !== readSequence) return;
      if (!accepted) { if (!view.suspended) publish({ status: 'error', error: 'invalid_response' }); return; }
      publish({ history: { ...page, messages: accepted }, messages: accepted, status: 'ready' });
    } catch {
      if (current(expected) && serial === readSequence) publish({ status: 'error', error: 'invalid_response' });
    } finally {
      if (current(expected) && serial === readSequence) publish({ busy: false });
    }
  }
  async function write() {
    if (!bound || !pending || writing || view.busy || view.suspended || mutations.busy() || mutations.unresolved()) return;
    const expected = bound, command = pending, s = scope()!;
    writing = true;
    publish({ busy: true, status: 'sending', error: undefined });
    try {
      const result = await requestMorning(settings, host, expected, () => current(expected), request, {
        path: `/slots/${command.slot.id}/discussion-v2`, method: 'POST', commandId: command.id,
        body: { body: command.body },
      });
      if (!current(expected)) return;
      if (!result.ok && await security(result.error)) return;
      if (pending !== command) return;
      if (!result.ok) {
        const definitive = ['invalid_request', 'idempotency_conflict'].includes(result.error);
        if (definitive) pending = null;
        publish({ status: definitive ? 'error' : 'unknown', error: result.error,
          ...(definitive ? { pendingId: undefined, pendingSlot: undefined } : {}) });
        return;
      }
      const value = result.value;
      const message = parseV2Message(value.message, s, command.slot);
      if (!keys(value, 'commandId,replay,message') || value.commandId !== command.id
        || typeof value.replay !== 'boolean' || !message || message.clientId !== command.id
        || message.authorId !== s.userId || (message.version === 1 && message.body !== command.body)
        || (!value.replay && (message.version !== 1 || message.deletedAt))) throw Error('invalid_response');
      const accepted = await accept([message], result.cookie, () => current(expected) && pending === command);
      if (!current(expected) || (pending && pending !== command)) return;
      if (!pending && accepted?.[0].deletedAt) return;
      if (pending !== command) return;
      if (!accepted) { if (view.suspended) return; throw Error('invalid_response'); }
      pending = null;
      const draft = drafts.get(command.slot.id);
      const unchanged = draft?.revision === command.revision;
      if (unchanged) drafts.delete(command.slot.id);
      publish({ pendingId: undefined, pendingSlot: undefined, savedDraftSlots: saved(), status: 'sent',
        ...(view.slot?.id === command.slot.id ? { history: null } : {}),
        ...(unchanged && view.slot?.id === command.slot.id ? { draft: '' } : {}) });
    } catch {
      if (current(expected) && pending === command) publish({ status: 'unknown', error: 'invalid_response' });
    } finally {
      if (current(expected)) { writing = false; publish({ busy: false }); }
    }
  }
  const actions = {
    ...mutations.actions,
    getSnapshot: () => view,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async open(slot: MorningSlot) { if (select(slot)) await read(); },
    close,
    first: () => read('first'), last: () => read('last'),
    older: () => read('before'), newer: () => read('after'),
    setDraft, clearDraft: () => setDraft(''),
    selectDraft(id: string) { const draft = drafts.get(id); if (draft) select(draft.slot); },
    async send() {
      if (!bound || !view.slot || view.busy || pending || view.suspended || mutations.busy() || mutations.unresolved()) return;
      const normalized = normalizeMessageText(view.draft);
      if (!normalized.ok) { publish({ status: 'invalid', error: 'invalid_body' }); return; }
      const id = commandId();
      if (!uuid(id)) { publish({ status: 'invalid', error: 'invalid_command' }); return; }
      pending = { id, body: normalized.text, revision: drafts.get(view.slot.id)!.revision, slot: view.slot };
      publish({ pendingId: id, pendingSlot: view.slot });
      await write();
    },
    retry: write,
  };
  return { actions, sync, reset };
}
