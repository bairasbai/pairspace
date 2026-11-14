import { readReconciliation, type ReconcileSelection, type Reconciliation } from '../chat/reconciliation';
import { displayMessage, type DisplayMessage } from '../chat/reply-view';
import type { TransportSession } from '../chat/transport';
export type ReconciliationView = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'error'; error?: string;
  hasNewMessages: boolean; latestVisible?: Reconciliation['latestVisible'];
}>;
type Host = {
  capture(): { generation: number; session: TransportSession } | null;
  selection(): ReconcileSelection;
  credential(valid: () => boolean): Promise<{ credential: TransportSession; changed: boolean } | null>;
  cookie(): Promise<string>; denied(error: string): void;
  accept(messages: readonly DisplayMessage[], cookie: string, revision: number | undefined, valid: () => boolean): Promise<boolean>;
  unavailable(ids: readonly string[], blockedReplyId?: string): void;
};
const empty: ReconciliationView = { status: 'idle', hasNewMessages: false };
/** Explicit reads and foreground transitions only. Bursts share one read; no queued polling. */
export function createChatReconciliation(baseURL: string, host: Host,
  request: (input: Request, valid?: () => boolean) => Promise<Response>, readId: () => string) {
  let view = empty, sequence = 0, active: Promise<void> | null = null, appState: string | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: ReconciliationView) => { view = next; listeners.forEach(notify => notify()); };
  function invalidate() { sequence++; active = null; publish(empty); }
  function check(): Promise<void> {
    if (active) return active;
    const captured = host.capture();
    if (!captured) return Promise.resolve();
    const serial = ++sequence;
    const current = () => host.capture()?.generation === captured.generation;
    const valid = () => current() && serial === sequence;
    const selection = host.selection();
    publish({ ...view, status: 'loading', error: undefined });
    const work = (async () => {
      try {
        const found = await host.credential(valid);
        if (!found || found.changed || !valid()) return;
        const result = await readReconciliation(baseURL, found.credential, selection, readId(), input => request(input, valid));
        if (!current()) return;
        // Security denials from the current account remain effective after navigation.
        if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
          host.denied(result.error); return;
        }
        if (!valid()) return;
        const cookie = await host.cookie();
        if (!valid()) return;
        if (cookie !== found.credential.token) { host.denied('auth_required'); return; }
        if (!result.ok) { publish({ ...view, status: 'error', error: result.error }); return; }
        const roles = [result.value.detail, result.value.replyTarget].filter(role => role !== null);
        const messages = [...new Map([...result.value.messages, ...roles.flatMap(role => role.message ? [role.message] : [])].map(m => [m.id, m])).values()];
        const accepted = await host.accept(messages.map(displayMessage), cookie, result.visibilityRevision, valid);
        if (!valid()) return;
        if (!accepted) { publish({ ...view, status: 'error', error: 'invalid_response' }); return; }
        const target = result.value.replyTarget;
        const blockedReplyId = target && (!target.message || target.message.body === null) ? target.id : undefined;
        host.unavailable([...result.value.unavailableIds, ...roles.filter(role => !role.message).map(role => role.id)], blockedReplyId);
        if (!valid()) return;
        const latest = result.value.latestVisible, tail = host.selection().messages.at(-1)?.seq ?? 0;
        publish({ status: 'ready', latestVisible: latest, hasNewMessages: !!latest && latest.seq > tail });
      } catch { if (valid()) publish({ ...view, status: 'error', error: 'transport_error' }); }
      finally {
        if (serial === sequence) {
          active = null;
          if (view.status === 'loading') publish({ ...view, status: 'error', error: 'transport_error' });
        }
      }
    })();
    active = work;
    return work;
  }
  return {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    check, invalidate,
    visibilityChanged() { sequence++; active = null; publish({ status: 'error', error: 'visibility_changed', hasNewMessages: false }); },
    reset() { appState = null; invalidate(); },
    appStateChanged(next: string): Promise<void> {
      const previous = appState; appState = next;
      return next === 'active' && (previous === 'inactive' || previous === 'background') ? check() : Promise.resolve();
    },
  };
}
