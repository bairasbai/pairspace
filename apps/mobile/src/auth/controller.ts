import { createQueue, enqueue, retry } from '../chat/queue';
import { createChatTransport, type ChatMessage, type TransportSession } from '../chat/transport';
import type { QueueState } from '../chat/types';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { SessionClient } from './official-client';

export type AuthView = Readonly<{
  phase: 'signed_out' | 'busy' | 'signed_in' | 'blocked';
  error: string | null; draft: string; messages: readonly ChatMessage[];
}>;
const empty: AuthView = { phase: 'signed_out', error: null, draft: '', messages: [] };
/** Ephemeral UI state; never persists credentials, drafts or message bodies. */
export function createSessionController(config: SyntheticConfig, client: SessionClient,
  request: (request: Request) => Promise<Response>, commandId: () => string) {
  validateSyntheticConfig(config);
  let view = empty;
  let generation = 0;
  let refreshSequence = 0;
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
    session = null; queue = null; sending = false; pending.clear();
    publish({ ...empty, phase: 'busy' });
    return generation;
  };
  const serialize = (action: () => Promise<void>) => {
    authTail = authTail.then(action).catch(() => publish({ ...empty, phase: 'blocked', error: 'auth_failed' }));
    return authTail;
  };
  const transport = createChatTransport({
    baseUrl: config.baseURL, allowHttpLoopbackForTests: true, cookieOrigin: config.baseURL,
    getCredentialGeneration: () => generation,
    store: {
      get() { if (!queue) throw new Error('no_session'); return queue; },
      set(next) { queue = next; },
    },
    async request(input) {
      const controller = new AbortController();
      const lifecycle = abort.signal;
      const cancel = () => controller.abort();
      lifecycle.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, 10000);
      try {
        if (lifecycle.aborted) controller.abort();
        return await request(new Request(input, { signal: controller.signal }));
      } finally { clearTimeout(timer); lifecycle.removeEventListener('abort', cancel); }
    },
  });
  async function credentials(): Promise<TransportSession | null> {
    const captured = session;
    if (!captured || view.phase !== 'signed_in') return null;
    const token = await client.getCookie();
    if (captured !== session) return null;
    if (!token) { denied('auth_required'); return null; }
    return { ...captured, token };
  }
  function denied(error: string) {
    if (error === 'auth_required' || error === 'access_required') {
      invalidate(); publish({ ...empty, phase: 'blocked', error });
    } else publish({ ...view, error });
  }
  async function refresh() {
    const current = generation;
    const sequence = ++refreshSequence;
    try {
      const credential = await credentials();
      if (!credential) return;
      const result = await transport.history(credential, { limit: 50 });
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
        const mapping = identity && config.identities[identity.userId];
        if (!identity || !mapping) {
          if (!await client.signOut()) throw new Error('cleanup_failed');
          publish({ ...empty, error: 'login_failed' }); return;
        }
        const scope = { ...mapping, sessionId: `${identity.sessionId}:${current}` };
        queue = createQueue(scope);
        session = { scope, token: '', credentialGeneration: current, credentialKind: 'cookie' };
        publish({ ...empty, phase: 'signed_in' });
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
        const credential = await credentials();
        if (!credential || !queue) return;
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
