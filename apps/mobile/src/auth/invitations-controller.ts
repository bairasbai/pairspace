import type { SyntheticConfig } from './config';
import { readSessionContext, type SessionContext } from './context';
import type { AuthIdentity } from './official-client';
import { createInvitationTransport, validInvitationToken, type InvitationMetadata, type InvitationResult } from './invitations';

export type InviteView = Readonly<{
  mode: 'unavailable' | 'owner' | 'recipient';
  busy: null | 'read' | 'issue' | 'revoke' | 'preview' | 'accept';
  error: string | null; invitation: InvitationMetadata | null; issuedToken: string | null;
  tokenInput: string; preview: Readonly<{ expiresAt: string }> | null; consent: boolean;
  recovery: 'none' | 'issue_uncertain' | 'revoke_required' | 'revoke_uncertain' | 'accept_uncertain';
}>;
export type InvitationHostSnapshot = Readonly<{
  generation: number; identity: AuthIdentity; context: SessionContext;
}>;
export type InvitationHost = Readonly<{
  capture(): InvitationHostSnapshot | null;
  getCookie(): Promise<string>;
  block(error: string): void;
  refresh(): Promise<void>;
}>;
const empty: InviteView = { mode: 'unavailable', busy: null, error: null, invitation: null,
  issuedToken: null, tokenInput: '', preview: null, consent: false, recovery: 'none' };
function sameContext(a: SessionContext, b: SessionContext): boolean {
  if (a.state !== b.state || a.sessionId !== b.sessionId) return false;
  if (a.state === 'unmapped' || b.state === 'unmapped') return true;
  if (a.userId !== b.userId) return false;
  if (a.state === 'no_active_pair' || b.state === 'no_active_pair') return true;
  return a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch;
}
/** Isolated, ephemeral consent state. The host, never the UI, supplies identity and authority. */
export function createInvitationController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const transport = createInvitationTransport(config, request);
  const snapshotConfig = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  const listeners = new Set<() => void>();
  let view: InviteView = empty;
  let bound: InvitationHostSnapshot | null = null;
  let sequence = 0;
  let abort = new AbortController();
  let pendingRevoke: string | null = null;
  let pendingAccept: string | null = null;
  const publish = (next: InviteView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function interrupt() { sequence++; abort.abort(); abort = new AbortController(); }
  function reset() {
    interrupt(); bound = null; pendingRevoke = null; pendingAccept = null; publish(empty);
  }
  function sync() {
    const current = host.capture();
    if (current && bound && current.generation === bound.generation && current.identity === bound.identity
      && sameContext(current.context, bound.context)) return;
    reset();
    if (!current) return;
    bound = current;
    const mode = current.context.state === 'waiting_partner' ? 'owner'
      : current.context.state === 'no_active_pair' ? 'recipient' : 'unavailable';
    publish({ ...empty, mode });
  }
  function active(id: number, expected: InvitationHostSnapshot): boolean {
    const current = host.capture();
    return id === sequence && current !== null && current.generation === expected.generation
      && current.identity === expected.identity && sameContext(current.context, expected.context);
  }
  function fail(error: string) {
    if (error === 'auth_required' || error === 'access_required') host.block(error);
    else publish({ ...view, error });
  }
  type Operation = { cookie: string; signal: AbortSignal; current(): boolean };
  async function run(kind: NonNullable<InviteView['busy']>, mode: InviteView['mode'],
    work: (op: Operation) => Promise<void>, allowAccepted = false) {
    if (view.busy || view.mode !== mode || !bound) return;
    const expected = bound;
    const id = ++sequence;
    const signal = abort.signal;
    const current = () => active(id, expected);
    publish({ ...view, busy: kind, error: null });
    try {
      const cookie = await host.getCookie();
      if (!current()) return;
      const binding = await readSessionContext(snapshotConfig, expected.identity.sessionId, cookie, input =>
        request(new Request(input, { signal })));
      if (!current()) return;
      if (!binding.ok) {
        fail(binding.error === 'invalid_context' ? 'auth_required'
          : binding.error === 'transport_error' ? 'invitation_retry_required' : binding.error);
        return;
      }
      const value = binding.value;
      // A retry of the exact approved token may now be an idempotent replay in a ready pair.
      const acceptedRetry = allowAccepted && expected.context.state === 'no_active_pair'
        && value.state === 'ready' && value.sessionId === expected.context.sessionId
        && value.userId === expected.context.userId;
      if (!sameContext(value, expected.context) && !acceptedRetry) {
        if (value.state === 'unmapped' || expected.context.state === 'unmapped'
          || value.userId !== expected.context.userId) host.block('auth_required');
        else await host.refresh();
        return;
      }
      const latest = await host.getCookie();
      if (!current()) return;
      if (latest !== cookie) { host.block('auth_required'); return; }
      await work({ cookie, signal, current });
    } catch { if (current()) fail('invitation_retry_required'); }
    finally { if (current()) publish({ ...view, busy: null }); }
  }
  async function checked<T>(op: Operation, result: InvitationResult<T>): Promise<{ value: T } | null> {
    if (!op.current()) return null;
    // Never display a response from an SDK cookie that has changed while the request was in flight.
    const cookie = await host.getCookie();
    if (!op.current()) return null;
    if (cookie !== op.cookie) { host.block('auth_required'); return null; }
    if (!result.ok) { fail(result.error); return null; }
    return { value: result.value };
  }
  const actions = {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    readMetadata() {
      return run('read', 'owner', async op => {
        const result = await transport.read(op.cookie, op.signal);
        const confirmed = await checked(op, result);
        if (!confirmed) return;
        const invitation = confirmed.value.invitation;
        const keepToken = invitation?.id === view.invitation?.id && invitation?.status === 'pending';
        publish({ ...view, invitation, issuedToken: keepToken ? view.issuedToken : null,
          recovery: ['issue_uncertain', 'revoke_required'].includes(view.recovery)
            ? invitation ? 'revoke_required' : 'none' : view.recovery });
      });
    },
    issue() {
      if (view.recovery !== 'none' || view.invitation?.status === 'pending') return Promise.resolve();
      return run('issue', 'owner', async op => {
        const id = commandId();
        // Conservative until an acknowledged response; cancellation does not imply server rollback.
        publish({ ...view, issuedToken: null, recovery: 'issue_uncertain' });
        if (!op.current()) return;
        const result = await transport.issue(op.cookie, id, op.signal);
        const confirmed = await checked(op, result);
        if (!confirmed) {
          if (op.current() && !result.ok && result.error === 'invitation_unavailable') publish({ ...view, recovery: 'none' });
          return;
        }
        publish({ ...view, invitation: confirmed.value.invitation, issuedToken: confirmed.value.token,
          recovery: confirmed.value.token === null ? 'revoke_required' : 'none' });
      });
    },
    revoke() {
      if (!pendingRevoke && (!view.invitation || !['pending', 'expired'].includes(view.invitation.status))) return Promise.resolve();
      return run('revoke', 'owner', async op => {
        const id = pendingRevoke ?? view.invitation!.id;
        pendingRevoke = id;
        publish({ ...view, issuedToken: null, recovery: 'revoke_uncertain' });
        if (!op.current()) return;
        const result = await transport.revoke(op.cookie, id, op.signal);
        if (!await checked(op, result)) return;
        pendingRevoke = null;
        publish({ ...view, invitation: view.invitation?.id === id ? null : view.invitation, recovery: 'none' });
      });
    },
    setToken(token: string) {
      if (view.mode !== 'recipient' || token === view.tokenInput) return;
      interrupt(); pendingAccept = null;
      publish({ ...view, busy: null, tokenInput: token, preview: null, consent: false, error: null, recovery: 'none' });
    },
    preview() {
      if (view.busy || view.mode !== 'recipient' || view.recovery === 'accept_uncertain') return Promise.resolve();
      if (!validInvitationToken(view.tokenInput)) { fail('invitation_token_invalid'); return Promise.resolve(); }
      const token = view.tokenInput;
      publish({ ...view, preview: null, consent: false });
      return run('preview', 'recipient', async op => {
        const result = await transport.preview(op.cookie, token, op.signal);
        const confirmed = await checked(op, result);
        if (confirmed) publish({ ...view, preview: confirmed.value });
      });
    },
    setConsent(consent: boolean) {
      if (view.mode === 'recipient' && !view.busy && view.preview && view.recovery !== 'accept_uncertain') publish({ ...view, consent });
    },
    accept() {
      if (view.busy || view.mode !== 'recipient') return Promise.resolve();
      const retry = view.recovery === 'accept_uncertain' && pendingAccept !== null;
      if (!retry && (!view.preview || !view.consent || !validInvitationToken(view.tokenInput))) {
        fail('invitation_consent_required'); return Promise.resolve();
      }
      const token = retry ? pendingAccept! : view.tokenInput;
      const expected = bound;
      return run('accept', 'recipient', async op => {
        pendingAccept = token;
        publish({ ...view, recovery: 'accept_uncertain' });
        if (!op.current()) return;
        const result = await transport.accept(op.cookie, token, op.signal);
        const confirmed = await checked(op, result);
        if (!confirmed) {
          if (op.current() && !result.ok && result.error === 'invitation_unavailable') {
            pendingAccept = null; publish({ ...view, recovery: 'none', preview: null, consent: false });
          }
          return;
        }
        if (!expected || expected.context.state === 'unmapped' || confirmed.value.sessionId !== expected.identity.sessionId
          || confirmed.value.userId !== expected.context.userId) { host.block('auth_required'); return; }
        // Membership authority comes only from context, never from an acceptance acknowledgement.
        pendingAccept = null;
        publish({ ...view, tokenInput: '', preview: null, consent: false, recovery: 'none' });
        await host.refresh();
      }, retry);
    },
    cancel() {
      interrupt(); pendingAccept = null;
      publish({ ...view, busy: null, issuedToken: null, tokenInput: '', preview: null, consent: false,
        error: null, recovery: view.recovery === 'accept_uncertain' ? 'none' : view.recovery });
    },
  };
  return { actions, reset, sync };
}
