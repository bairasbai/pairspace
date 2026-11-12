import { createChatDelete, type DeleteState } from './chat-delete';
import { createWishesController } from './wishes';
import { createSongsController } from './songs';
import { createMemoriesController } from './memories';
import { createDatesController } from './dates';
import { createBlindController } from './blind';
import { createTasksController } from './tasks';
import { createLeaveController } from './leave';
import { createLettersController } from './letters';
import { createCareController } from './care';
import { type HistoryView } from '../chat/history';
import type { HistoryWindowOptions } from '../chat/history-window';
import { readReplyWindow, readReplyDetail, sendChatReply } from '../chat/reply-transport';
import { displayMessage, createReplyKnowledge, selectReply, type DisplayMessage, type ReplySelection } from '../chat/reply-view';
import { createQueue, enqueue, retry, beginSend, failSend, acknowledge, deleteConfirmed } from '../chat/queue';
import { createChatTransport, type TransportSession } from '../chat/transport';
import type { QueueState } from '../chat/types';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import { readSessionContext, type SessionContext } from './context';
import { createInvitationController } from './invitations-controller';
import { provisionProfile } from './profile';
import { requestWaitingSpace } from './waiting';
import type { AuthIdentity, SessionClient } from './official-client';

export type AuthView = Readonly<{
  phase: 'signed_out' | 'busy' | 'signed_in' | 'blocked';
  error: string | null; draft: string; messages: readonly DisplayMessage[];
  replyTarget?: ReplySelection; replyDetail?: DisplayMessage; replyDetailLoading?: boolean; chatSuspended?: boolean;
  history?: HistoryView;
  currentUserId?: string; deleteState?: DeleteState;
  outgoing?: Readonly<{ body: string; status: 'sending' | 'retry' | 'sent'; replyToId?: string }>;
}>;
// Correlation only, never authentication. Independent from mutation command IDs.
let historyReadSequence = 0;
function historyReadId() {
  if (++historyReadSequence > 999999999999) throw Error('read_identity_exhausted');
  return `00000000-0000-4000-8000-${String(historyReadSequence).padStart(12, '0')}`;
}
const empty: AuthView = { phase: 'signed_out', error: null, draft: '', messages: [] };
/** Ephemeral UI state; never persists credentials, drafts or message bodies. */
export function createSessionController(config: SyntheticConfig, client: SessionClient,
  request: (request: Request) => Promise<Response>, commandId: () => string) {
  const contextConfig: SyntheticConfig = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(contextConfig);
  let view = empty;
  let generation = 0;
  let refreshSequence = 0;
  let historyBusy = false;
  let detailSequence = 0;
  const replyKnowledge = createReplyKnowledge();
  let discoverySequence = 0;
  let authIdentity: AuthIdentity | null = null;
  let waitingUserId: string | null = null;
  let verifiedContext: SessionContext | null = null;
  let session: TransportSession | null = null;
  let queue: QueueState | null = null;
  let abort = new AbortController();
  let authTail = Promise.resolve();
  let sending = false;
  let draftRevision = 0;
  let outgoingClientId: string | null = null;
  let pending: { readonly body: string; readonly revision: number; id: string | null; replyToId?: string } | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: AuthView) => { view = next; for (const notify of listeners) notify(); };
  const invalidate = (preserveLeave = false) => {
    generation++; detailSequence++; replyKnowledge.reset(); chatDelete.reset(); historyBusy = false; abort.abort(); abort = new AbortController();
    if (!preserveLeave) leaveController.reset();
    verifiedContext = null; invitationController.reset(); careController.reset(); lettersController.reset(); tasksController.reset(); wishesController.reset(); datesController.reset(); memoriesController.reset(); songsController.reset(); blindController.reset();
    session = null; authIdentity = null; waitingUserId = null; queue = null; sending = false; pending = null; outgoingClientId = null; draftRevision++;
    publish({ ...empty, phase: 'busy' });
    return generation;
  };
  const serialize = (action: () => Promise<void>) => {
    const current = generation;
    authTail = authTail.then(action).catch(() => {
      if (current === generation) block('auth_failed');
    });
    return authTail;
  };
  const invitationController = createInvitationController(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block, refresh,
  }, boundedRequest, commandId);
  const invitations = invitationController.actions;
  const careController = createCareController(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block, refresh,
  }, boundedRequest, commandId);
  const care = careController.actions;
  const lettersController = createLettersController(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block, refresh,
  }, boundedRequest, commandId);
  const letters = lettersController.actions;
  const tasksController = createTasksController(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block, refresh,
  }, boundedRequest, commandId);
  const tasks = tasksController.actions;
  const wishesController = createWishesController(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block, refresh,
  }, boundedRequest, commandId);
  const wishes = wishesController.actions;
  const datesController = createDatesController(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block, refresh,
  }, boundedRequest, commandId);
  const dates = datesController.actions;
  const memoriesController = createMemoriesController(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block, refresh,
  }, boundedRequest, commandId);
  const memories = memoriesController.actions;
  const songsController = createSongsController(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block, refresh,
  }, boundedRequest, commandId);
  const songs = songsController.actions;
  const blindController = createBlindController(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block, refresh,
  }, boundedRequest, commandId);
  const blind = blindController.actions;
  const leaveController = createLeaveController(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block,
    suspend() {
      if (!authIdentity || !verifiedContext) return null;
      const identity = authIdentity; const context = verifiedContext;
      invalidate(true); authIdentity = identity; verifiedContext = context;
      publish({ ...empty, phase: 'blocked', error: 'leave_pending' });
      return { generation, identity, context };
    },
    finish() {
      const identity = authIdentity;
      invalidate(true); authIdentity = identity;
      publish({ ...empty, phase: 'blocked', error: 'leave_finished' });
    },
  }, boundedRequest, commandId);
  const leave = leaveController.actions;
  const transport = createChatTransport({
    baseUrl: contextConfig.baseURL, allowHttpLoopbackForTests: true, cookieOrigin: contextConfig.baseURL,
    getCredentialGeneration: () => generation,
    store: {
      get() { if (!queue) throw new Error('no_session'); return queue; },
      set(next) { queue = next; },
    },
    request: boundedRequest,
  });
  async function boundedRequest(input: Request) {
    const controller = new AbortController();
    const lifecycle = abort.signal;
    const cancel = () => controller.abort();
    lifecycle.addEventListener('abort', cancel, { once: true });
    input.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 10000);
    try {
      if (lifecycle.aborted || input.signal.aborted) controller.abort();
      return await request(new Request(input, { signal: controller.signal }));
    } finally {
      clearTimeout(timer); lifecycle.removeEventListener('abort', cancel);
      input.signal.removeEventListener('abort', cancel);
    }
  }
  async function discover(): Promise<{ credential: TransportSession; changed: boolean } | null> {
    const expected = authIdentity;
    if (!expected) return null;
    const current = generation; const sequence = ++discoverySequence;
    try {
      const cookie = await client.getCookie();
      if (current !== generation || expected !== authIdentity) return null;
      const result = await readSessionContext(contextConfig, expected.sessionId, cookie, boundedRequest);
      if (current !== generation || expected !== authIdentity) return null;
      // Any auth denial invalidates the current session, even from an older discovery request.
      if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
        block(result.error); return null;
      }
      if (sequence !== discoverySequence) return null;
      if (!result.ok) {
        if (result.error === 'transport_error' && session) publish({ ...view, error: result.error });
        else block(result.error);
        return null;
      }
      const value = result.value;
      if (value.state !== 'ready') {
        block('context_' + value.state);
        authIdentity = expected;
        verifiedContext = value; invitationController.sync(); careController.sync(); lettersController.sync(); tasksController.sync(); wishesController.sync(); datesController.sync(); memoriesController.sync(); songsController.sync(); blindController.sync(); leaveController.sync();
        if (value.state === 'no_active_pair') waitingUserId = value.userId;
        return null;
      }
      const changed = session !== null && (session.scope.userId !== value.userId
        || session.scope.coupleId !== value.coupleId || session.scope.membershipEpoch !== value.membershipEpoch);
      if (changed) { invalidate(); authIdentity = expected; }
      if (!session) {
        const scope = { userId: value.userId, coupleId: value.coupleId, membershipEpoch: value.membershipEpoch,
          sessionId: `${expected.sessionId}:${generation}` };
        queue = createQueue(scope);
        session = { scope, token: '', credentialGeneration: generation, credentialKind: 'cookie' };
        publish({ ...empty, phase: 'signed_in', currentUserId: value.userId });
      }
      verifiedContext = value; invitationController.sync(); careController.sync(); lettersController.sync(); tasksController.sync(); wishesController.sync(); datesController.sync(); memoriesController.sync(); songsController.sync(); blindController.sync(); leaveController.sync();
      return { credential: { ...session, token: cookie }, changed };
    } catch {
      if (current === generation && sequence === discoverySequence) {
        if (session) publish({ ...view, error: 'transport_error' });
        else block('transport_error');
      }
      return null;
    }
  }
  function block(error: string) {
    invalidate(); publish({ ...empty, phase: 'blocked', error });
  }
  function denied(error: string) {
    if (error === 'auth_required' || error === 'access_required') {
      block(error);
    } else publish({ ...view, error });
  }
  async function refresh() {
    if (leaveController.unresolved()) return;
    leaveController.reset();
    return readWindow('latest', true);
  }
  async function readWindow(direction: HistoryWindowOptions['direction'], supersede = false) {
    const anchorId = direction === 'before' ? view.messages[0]?.id : direction === 'after' ? view.messages.at(-1)?.id : undefined;
    const anchorSeq = direction === 'before' ? view.history?.nextBeforeSeq
      : direction === 'after' ? view.history?.nextAfterSeq : undefined;
    if (view.chatSuspended || (!supersede && (historyBusy || view.phase !== 'signed_in'))) return;
    if ((direction === 'before' || direction === 'after') && anchorSeq == null) return;
    let current = generation;
    const sequence = ++refreshSequence;
    historyBusy = true;
    if (view.phase === 'signed_in') publish({ ...view, history: {
      ...view.history, status: 'loading', nextBeforeSeq: view.history?.nextBeforeSeq ?? null,
      nextAfterSeq: view.history?.nextAfterSeq ?? null, boundedWindow: true,
    } });
    try {
      const discovered = await discover();
      if (!discovered || sequence !== refreshSequence) return;
      if (!supersede && current !== generation) return;
      current = discovered.credential.credentialGeneration;
      const credential = discovered.credential;
      const readId = historyReadId();
      const result = await readReplyWindow(contextConfig.baseURL, credential, {
        direction, readId, ...(anchorSeq == null ? {} : { anchorSeq, anchorId }), allowHttpLoopbackForTests: true,
      }, boundedRequest);
      if (current !== generation) return;
      // A valid denial still invalidates this authentication generation even if
      // a later navigation won. An old account's denial never affects a new one.
      if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
        denied(result.error); return;
      }
      if (sequence !== refreshSequence) return;
      const cookie = await client.getCookie();
      if (current !== generation || sequence !== refreshSequence) return;
      if (cookie !== credential.token) { block('auth_required'); return; }
      if (!result.ok) {
        if (result.error === 'invalid_cursor') publish({ ...view, error: result.error,
          history: { status: 'error', nextBeforeSeq: null, nextAfterSeq: null, boundedWindow: true } });
        else denied(result.error);
        return;
      }
      // Validate overlap identities, but retain only the new fifty-row window.
      const messages = result.value.messages.map(displayMessage);
      if (!acceptMessages(messages)) { if (!view.chatSuspended) denied('invalid_response'); return; }
      publish({ ...view, error: null, messages,
        history: { status: 'ready', nextBeforeSeq: result.value.olderCursor?.seq ?? null,
          nextAfterSeq: result.value.newerCursor?.seq ?? null, boundedWindow: true, windowReset: direction === 'latest' } });
    } catch { if (current === generation && sequence === refreshSequence) publish({ ...view, error: 'transport_error' }); }
    finally {
      if (current === generation && sequence === refreshSequence) {
        historyBusy = false;
        if (view.history?.status === 'loading') publish({ ...view, history: { ...view.history, status: 'error' } });
      }
    }
  }
  function scrubDeletedOutgoing(messages: readonly DisplayMessage[]) {
    for (const m of messages) {
      if (!m.deletedAt || !queue || !session || m.senderId !== session.scope.userId) continue;
      const removed = deleteConfirmed(queue, session.scope, m.clientId, m.id, m.version);
      if (removed.ok) queue = removed.state;
      if (pending?.id === m.clientId) {
        if (draftRevision === pending.revision) publish({ ...view, draft: '', replyTarget: undefined });
        pending = null;
      }
      if (outgoingClientId === m.clientId) { outgoingClientId = null; publish({ ...view, outgoing: undefined }); }
    }
  }
  function acceptMessages(messages: readonly DisplayMessage[]) {
    try {
      if (!replyKnowledge.accept(messages, [...view.messages, ...(view.replyDetail ? [view.replyDetail] : [])])) return false;
    } catch {
      detailSequence++; refreshSequence++; scrubDeletedOutgoing(messages);
      publish({ ...view, messages: [], outgoing: undefined, replyDetail: undefined, replyTarget: undefined,
        replyDetailLoading: false, chatSuspended: true, error: 'tombstone_limit' });
      return false;
    }
    const tombstones = messages.filter(m => m.deletedAt);
    if (tombstones.length) {
      scrubDeletedOutgoing(tombstones);
      const updated = (m: DisplayMessage) => replyKnowledge.tombstone(m.id) ?? m;
      publish({ ...view, messages: view.messages.map(updated),
        ...(view.replyDetail ? { replyDetail: updated(view.replyDetail) } : {}),
        ...(view.replyTarget && replyKnowledge.tombstone(view.replyTarget.id) ? { replyTarget: undefined } : {}),
      });
    }
    return true;
  }
  async function sendQueuedReply(id: string, replyToId: string, credential: TransportSession, current: number) {
    const started = beginSend(queue!, credential.scope, id);
    if (!started.ok) return { ok: false as const, error: started.error };
    queue = started.state;
    const item = queue.messages.find(message => message.clientId === id)!;
    const result = await sendChatReply(contextConfig.baseURL, credential, {
      clientId: id, body: item.body!, replyToId, allowHttpLoopbackForTests: true,
    }, boundedRequest);
    if (current !== generation || !queue) return { ok: false as const, error: 'stale_session' as const };
    const cookie = await client.getCookie();
    if (current !== generation || !queue) return { ok: false as const, error: 'stale_session' as const };
    if (cookie !== credential.token) return { ok: false as const, error: 'auth_required' as const };
    if (!result.ok) {
      const failed = failSend(queue, credential.scope, id, item.attempt, result.error === 'transport_error' || result.error === 'rate_limited');
      if (failed.ok) queue = failed.state;
      return result;
    }
    const m = result.value.message;
    if (!acceptMessages([displayMessage(m)])) return { ok: false as const, error: 'invalid_response' as const };
    const ack = acknowledge(queue, credential.scope, { clientId: id, serverId: m.id, senderId: m.senderId,
      seq: m.seq, version: m.version, body: m.body, replyToId: m.replyToId });
    if (!ack.ok) return { ok: false as const, error: 'invalid_response' as const };
    queue = ack.state; return result;
  }
  async function openReplyTarget(messageId: string) {
    if (view.phase !== 'signed_in' || view.chatSuspended) return;
    const source = view.messages.find(item => item.id === messageId) ?? (view.replyDetail?.id === messageId ? view.replyDetail : undefined);
    const targetId = source?.replyToId;
    if (!targetId) return;
    const current = generation, sequence = ++detailSequence;
    publish({ ...view, replyDetail: undefined, replyDetailLoading: true });
    try {
      const discovered = await discover();
      if (!discovered || current !== generation || sequence !== detailSequence) return;
      const credential = discovered.credential;
      const result = await readReplyDetail(contextConfig.baseURL, credential, {
        messageId: targetId, readId: historyReadId(), allowHttpLoopbackForTests: true,
      }, boundedRequest);
      if (current !== generation) return;
      if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) { denied(result.error); return; }
      if (sequence !== detailSequence) return;
      const cookie = await client.getCookie();
      if (current !== generation || sequence !== detailSequence) return;
      if (cookie !== credential.token) { block('auth_required'); return; }
      if (!result.ok) {
        if (result.error === 'reply_unavailable') publish({ ...view, error: result.error,
          ...(view.replyTarget?.id === targetId ? { replyTarget: undefined } : {}),
          ...(view.replyDetail?.id === targetId ? { replyDetail: undefined } : {}),
        });
        else denied(result.error);
        return;
      }
      const message = displayMessage(result.value);
      if (!acceptMessages([message])) { if (!view.chatSuspended) denied('invalid_response'); return; }
      publish({ ...view, error: null, replyDetail: message });
    } catch { if (current === generation && sequence === detailSequence) publish({ ...view, error: 'transport_error' }); }
    finally { if (current === generation && sequence === detailSequence) publish({ ...view, replyDetailLoading: false }); }
  }
  function setReplyTarget(id: string) {
    if (view.phase !== 'signed_in') return;
    const message = view.messages.find(item => item.id === id) ?? (view.replyDetail?.id === id ? view.replyDetail : undefined);
    if (!message || message.body === null || view.chatSuspended) return;
    draftRevision++; publish({ ...view, replyTarget: selectReply(message) });
  }
  const chatDelete = createChatDelete(contextConfig.baseURL, {
    capture: () => session && view.phase === 'signed_in' && !view.chatSuspended ? { generation, session } : null,
    find: id => view.messages.find(message => message.id === id) ?? (view.replyDetail?.id === id ? view.replyDetail : undefined),
    credential: discover, cookie: () => client.getCookie(), denied,
    publish: deleteState => publish({ ...view, deleteState }),
    accept: message => acceptMessages([message]),
  }, boundedRequest, commandId);
  const loadOlder = () => readWindow('before');
  return {
    leave,
    invitations,
    care,
    letters,
    tasks, wishes, dates, memories, songs,
    blind,
    setReplyTarget, openReplyTarget,
    beginDelete: chatDelete.beginDelete, cancelDelete: chatDelete.cancelDelete,
    confirmDelete: chatDelete.confirmDelete, retryDelete: chatDelete.retryDelete,
    cancelReply() { if (view.phase !== 'signed_in') return; draftRevision++; publish({ ...view, replyTarget: undefined }); },
    closeReplyDetail() { detailSequence++; publish({ ...view, replyDetail: undefined, replyDetailLoading: false }); },
    loadOlder,
    loadNewer: () => readWindow('after'),
    loadLatest: () => readWindow('latest', true),
    loadOldest: () => readWindow('oldest'),
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) {
      if (view.phase === 'signed_in') { draftRevision++; publish({ ...view, draft }); }
    },
    dispose() { invalidate(); publish(empty); },
    signIn(email: string, password: string) {
      if (view.phase !== 'signed_out') return authTail;
      const current = invalidate();
      return serialize(async () => {
        if (current !== generation) return;
        if (!await client.signOut()) throw new Error('cleanup_failed');
        if (current !== generation) return;
        const identity = await client.signIn(email, password);
        if (current !== generation) return;
        if (!identity) {
          if (!await client.signOut()) throw new Error('cleanup_failed');
          publish({ ...empty, error: 'login_failed' }); return;
        }
        authIdentity = identity;
      }).then(async () => { if (current === generation) await refresh(); });
    },
    signOut() {
      const current = invalidate();
      return serialize(async () => {
        if (current !== generation) return;
        if (!await client.signOut()) throw new Error('logout_failed');
        if (current === generation) publish(empty);
      });
    },
    async createProfile() {
      if (view.phase !== 'blocked' || !['context_unmapped', 'profile_retry_required'].includes(view.error ?? '')
        || !authIdentity) return;
      const expected = authIdentity;
      const current = invalidate(); authIdentity = expected;
      try {
        const cookie = await client.getCookie();
        if (current !== generation || authIdentity !== expected) return;
        // Bind this exact cookie snapshot before a mutation, not merely after its response.
        const binding = await readSessionContext(contextConfig, expected.sessionId, cookie, boundedRequest);
        if (current !== generation || authIdentity !== expected) return;
        if (!binding.ok) {
          const error = binding.error === 'access_required' ? 'access_required'
            : binding.error === 'auth_required' || binding.error === 'invalid_context' ? 'auth_required' : 'profile_retry_required';
          block(error);
          if (error === 'profile_retry_required') authIdentity = expected;
          return;
        }
        if (binding.value.state !== 'unmapped') { await refresh(); return; }
        const result = await provisionProfile(contextConfig, expected.sessionId, cookie, boundedRequest);
        if (current !== generation || authIdentity !== expected) return;
        if (result.ok) { await refresh(); return; }
        block(result.error);
        if (result.error === 'profile_retry_required') authIdentity = expected;
      } catch {
        if (current !== generation || authIdentity !== expected) return;
        block('profile_retry_required'); authIdentity = expected;
      }
    },
    async createWaitingSpace() {
      if (invitations.getSnapshot().busy || invitations.getSnapshot().recovery === 'accept_uncertain'
        || view.phase !== 'blocked' || !['context_no_active_pair', 'waiting_retry_required'].includes(view.error ?? '')
        || !authIdentity || !waitingUserId) return;
      const expected = authIdentity; const expectedUserId = waitingUserId;
      const current = invalidate(); authIdentity = expected; waitingUserId = expectedUserId;
      try {
        const cookie = await client.getCookie();
        if (current !== generation || authIdentity !== expected) return;
        const binding = await readSessionContext(contextConfig, expected.sessionId, cookie, boundedRequest);
        if (current !== generation || authIdentity !== expected) return;
        if (!binding.ok) {
          const error = binding.error === 'access_required' ? 'access_required'
            : binding.error === 'auth_required' || binding.error === 'invalid_context' ? 'auth_required' : 'waiting_retry_required';
          block(error);
          if (error === 'waiting_retry_required') { authIdentity = expected; waitingUserId = expectedUserId; }
          return;
        }
        if (binding.value.state !== 'unmapped' && binding.value.userId !== expectedUserId) {
          block('auth_required'); return;
        }
        if (binding.value.state !== 'no_active_pair') { await refresh(); return; }
        const result = await requestWaitingSpace(contextConfig, expected.sessionId, cookie, boundedRequest);
        if (current !== generation || authIdentity !== expected) return;
        if (result.ok) { await refresh(); return; }
        block(result.error);
        if (result.error === 'waiting_retry_required') { authIdentity = expected; waitingUserId = expectedUserId; }
      } catch {
        if (current !== generation || authIdentity !== expected) return;
        block('waiting_retry_required'); authIdentity = expected; waitingUserId = expectedUserId;
      }
    },
    async send() {
      if (sending || view.chatSuspended || view.phase !== 'signed_in' || !queue) return;
      sending = true;
      const current = generation;
      // One unresolved command at a time. Edits remain a separate draft, never a replay payload.
      const command = pending ?? { body: view.draft, revision: draftRevision, id: null, ...(view.replyTarget ? { replyToId: view.replyTarget.id } : {}) };
      pending = command;
      publish({ ...view, error: null, outgoing: { body: command.body, status: 'sending', ...(command.replyToId ? { replyToId: command.replyToId } : {}) } });
      try {
        const discovered = await discover();
        if (!discovered || discovered.changed || current !== generation || !queue) return;
        const credential = discovered.credential;
        command.id ??= commandId();
        const id = command.id;
        outgoingClientId = id;
        const added = enqueue(queue, credential.scope, id, command.body, command.replyToId);
        if (!added.ok) {
          pending = null;
          publish({ ...view, outgoing: undefined, error: added.error });
          return;
        }
        queue = added.state;
        if (queue.messages.find(message => message.clientId === id)?.status === 'failed') {
          const retried = retry(queue, credential.scope, id);
          if (retried.ok) queue = retried.state;
        }
        const result = command.replyToId ? await sendQueuedReply(id, command.replyToId, credential, current) : await transport.send(id, credential);
        if (current !== generation) return;
        if (queue?.messages.find(item => item.clientId === id)?.deleted) {
          pending = null; outgoingClientId = null;
          publish({ ...view, outgoing: undefined, draft: draftRevision === command.revision ? '' : view.draft });
          return;
        }
        if (view.chatSuspended) return;
        if (result.ok) {
          pending = null;
          publish({ ...view, error: null, draft: draftRevision === command.revision ? '' : view.draft,
            ...(draftRevision === command.revision ? { replyTarget: undefined } : {}),
            outgoing: { body: command.body, status: 'sent', ...(command.replyToId ? { replyToId: command.replyToId } : {}) } });
          // Keep the reader's chosen window. Latest is an explicit action.
        } else if (result.error === 'reply_unavailable') {
          pending = null; publish({ ...view, outgoing: undefined, error: result.error,
            ...(view.replyTarget?.id === command.replyToId ? { replyTarget: undefined } : {}),
          });
        } else if (!view.chatSuspended) denied(result.error);
      } catch { if (current === generation) publish({ ...view, error: 'transport_error' }); }
      finally {
        if (current === generation) {
          sending = false;
          if (pending && !view.chatSuspended) publish({ ...view, outgoing: { body: pending.body, status: 'retry', ...(pending.replyToId ? { replyToId: pending.replyToId } : {}) } });
        }
      }
    },
    refresh,
  };
}
