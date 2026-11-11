import { createWishesController } from './wishes';
import { createSongsController } from './songs';
import { createMemoriesController } from './memories';
import { createDatesController } from './dates';
import { createBlindController } from './blind';
import { createTasksController } from './tasks';
import { createLeaveController } from './leave';
import { createLettersController } from './letters';
import { createCareController } from './care';
import { mergeHistory, type HistoryView } from '../chat/history';
import { createQueue, enqueue, retry } from '../chat/queue';
import { createChatTransport, type ChatMessage, type TransportSession } from '../chat/transport';
import type { QueueState } from '../chat/types';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import { readSessionContext, type SessionContext } from './context';
import { createInvitationController } from './invitations-controller';
import { provisionProfile } from './profile';
import { requestWaitingSpace } from './waiting';
import type { AuthIdentity, SessionClient } from './official-client';

export type AuthView = Readonly<{
  phase: 'signed_out' | 'busy' | 'signed_in' | 'blocked';
  error: string | null; draft: string; messages: readonly ChatMessage[];
  history?: HistoryView;
  outgoing?: Readonly<{ body: string; status: 'sending' | 'retry' | 'sent' }>;
}>;
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
  let pending: { readonly body: string; readonly revision: number; id: string | null } | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: AuthView) => { view = next; for (const notify of listeners) notify(); };
  const invalidate = (preserveLeave = false) => {
    generation++; historyBusy = false; abort.abort(); abort = new AbortController();
    if (!preserveLeave) leaveController.reset();
    verifiedContext = null; invitationController.reset(); careController.reset(); lettersController.reset(); tasksController.reset(); wishesController.reset(); datesController.reset(); memoriesController.reset(); songsController.reset(); blindController.reset();
    session = null; authIdentity = null; waitingUserId = null; queue = null; sending = false; pending = null; draftRevision++;
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
        publish({ ...empty, phase: 'signed_in' });
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
    let current = generation;
    const sequence = ++refreshSequence;
    historyBusy = true;
    if (view.phase === 'signed_in') publish({ ...view, history: { ...view.history, status: 'loading', nextBeforeSeq: view.history?.nextBeforeSeq ?? null } });
    try {
      const discovered = await discover();
      if (!discovered) return;
      current = discovered.credential.credentialGeneration;
      const result = await transport.history(discovered.credential, { limit: 50 });
      if (current !== generation) return;
      if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
        denied(result.error); return;
      }
      if (sequence !== refreshSequence) return;
      if (result.ok) publish({ ...view, error: null, messages: result.value.messages,
        history: { status: 'ready', nextBeforeSeq: result.value.nextBeforeSeq, windowReset: true } });
      else denied(result.error);
    } catch { if (current === generation && sequence === refreshSequence) publish({ ...view, error: 'transport_error' }); }
    finally {
      if (current === generation && sequence === refreshSequence) {
        historyBusy = false;
        if (view.history?.status === 'loading') publish({ ...view, history: { ...view.history, status: 'error' } });
      }
    }
  }
  async function loadOlder() {
    const cursor = view.history?.nextBeforeSeq;
    if (historyBusy || view.phase !== 'signed_in' || cursor == null || view.messages.length >= 200) return;
    const current = generation;
    const sequence = ++refreshSequence;
    historyBusy = true;
    publish({ ...view, history: { ...view.history, nextBeforeSeq: cursor, status: 'loading' } });
    try {
      const discovered = await discover();
      if (!discovered || current !== generation || sequence !== refreshSequence) return;
      const result = await transport.history(discovered.credential, { limit: Math.min(50, 200 - view.messages.length), beforeSeq: cursor });
      if (current !== generation) return;
      if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
        denied(result.error); return;
      }
      if (sequence !== refreshSequence) return;
      if (!result.ok) { denied(result.error); return; }
      const messages = mergeHistory(view.messages, result.value.messages);
      if (!messages) { denied('invalid_response'); return; }
      publish({ ...view, error: null, messages,
        history: { ...view.history, status: 'ready', nextBeforeSeq: result.value.nextBeforeSeq } });
    } catch { if (current === generation && sequence === refreshSequence) publish({ ...view, error: 'transport_error' }); }
    finally {
      if (current === generation && sequence === refreshSequence) {
        historyBusy = false;
        if (view.history?.status === 'loading') publish({ ...view, history: { ...view.history, status: 'error' } });
      }
    }
  }
  return {
    leave,
    invitations,
    care,
    letters,
    tasks, wishes, dates, memories, songs,
    blind,
    loadOlder,
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
      if (sending || view.phase !== 'signed_in' || !queue) return;
      sending = true;
      const current = generation;
      // One unresolved command at a time. Edits remain a separate draft, never a replay payload.
      const command = pending ?? { body: view.draft, revision: draftRevision, id: null };
      pending = command;
      publish({ ...view, error: null, outgoing: { body: command.body, status: 'sending' } });
      try {
        const discovered = await discover();
        if (!discovered || discovered.changed || current !== generation || !queue) return;
        const credential = discovered.credential;
        command.id ??= commandId();
        const id = command.id;
        const added = enqueue(queue, credential.scope, id, command.body);
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
        const result = await transport.send(id, credential);
        if (current !== generation) return;
        if (result.ok) {
          pending = null;
          publish({ ...view, error: null, draft: draftRevision === command.revision ? '' : view.draft,
            outgoing: { body: command.body, status: 'sent' } });
          await refresh();
        } else denied(result.error);
      } catch { if (current === generation) publish({ ...view, error: 'transport_error' }); }
      finally {
        if (current === generation) {
          sending = false;
          if (pending) publish({ ...view, outgoing: { body: pending.body, status: 'retry' } });
        }
      }
    },
    refresh,
  };
}
