import { createQueue, enqueue, retry } from '../chat/queue';
import { createChatTransport, type ChatMessage, type TransportSession } from '../chat/transport';
import type { QueueState } from '../chat/types';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import { readSessionContext } from './context';
import type { AuthIdentity, SessionClient } from './official-client';

export type AuthView = Readonly<{
  phase: 'signed_out' | 'busy' | 'signed_in' | 'blocked';
  error: string | null; draft: string; messages: readonly ChatMessage[];
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
  let discoverySequence = 0;
  let authIdentity: AuthIdentity | null = null;
  let session: TransportSession | null = null;
  let queue: QueueState | null = null;
  let abort = new AbortController();
  let authTail = Promise.resolve();
  let sending = false;
  const pending = new Map<string, string>();
  const listeners = new Set<() => void>();
  const publish = (next: AuthView) => { view = next; for (const notify of listeners) notify(); };
  const invalidate = () => {
    generation++; abort.abort(); abort = new AbortController();
    session = null; authIdentity = null; queue = null; sending = false; pending.clear();
    publish({ ...empty, phase: 'busy' });
    return generation;
  };
  const serialize = (action: () => Promise<void>) => {
    authTail = authTail.then(action).catch(() => publish({ ...empty, phase: 'blocked', error: 'auth_failed' }));
    return authTail;
  };
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
    const timer = setTimeout(cancel, 10000);
    try {
      if (lifecycle.aborted) controller.abort();
      return await request(new Request(input, { signal: controller.signal }));
    } finally { clearTimeout(timer); lifecycle.removeEventListener('abort', cancel); }
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
      if (!result.ok) { block(result.error); return null; }
      const value = result.value;
      if (value.state !== 'ready') { block('context_' + value.state); return null; }
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
      return { credential: { ...session, token: cookie }, changed };
    } catch {
      if (current === generation && sequence === discoverySequence) block('transport_error');
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
    let current = generation;
    const sequence = ++refreshSequence;
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
      if (result.ok) publish({ ...view, error: null, messages: result.value.messages });
      else denied(result.error);
    } catch { if (current === generation && sequence === refreshSequence) publish({ ...view, error: 'transport_error' }); }
  }
  return {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) { if (view.phase === 'signed_in') publish({ ...view, draft }); },
    signIn(email: string, password: string) {
      if (view.phase !== 'signed_out') return authTail;
      const current = invalidate();
      return serialize(async () => {
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
        if (!await client.signOut()) throw new Error('logout_failed');
        if (current === generation) publish(empty);
      });
    },
    async send() {
      if (sending || view.phase !== 'signed_in' || !queue) return;
      sending = true;
      const current = generation; const body = view.draft;
      try {
        const discovered = await discover();
        if (!discovered || discovered.changed || current !== generation || !queue) return;
        const credential = discovered.credential;
        const id = pending.get(body) ?? commandId();
        const added = enqueue(queue, credential.scope, id, body);
        if (!added.ok) { denied(added.error); return; }
        pending.set(body, id);
        queue = added.state;
        if (queue.messages.find(message => message.clientId === id)?.status === 'failed') {
          const retried = retry(queue, credential.scope, id);
          if (retried.ok) queue = retried.state;
        }
        const result = await transport.send(id, credential);
        if (current !== generation) return;
        if (result.ok) {
          pending.delete(body);
          publish({ ...view, draft: view.draft === body ? '' : view.draft });
          await refresh();
        } else denied(result.error);
      } catch { if (current === generation) publish({ ...view, error: 'transport_error' }); }
      finally { if (current === generation) sending = false; }
    },
    refresh,
  };
}
