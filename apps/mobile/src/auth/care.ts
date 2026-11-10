import { readBoundedJson } from '../chat/transport';
import { readSessionContext, type SessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
export type CareSignal = Readonly<{ id: string; coupleId: string; senderId: string; recipientId: string;
  clientId: string; membershipEpoch: number; kind: 'thinking_of_you'; createdAt: string }>;
export type CareView = Readonly<{ available: boolean; busy: boolean; status: 'idle' | 'sending' | 'retry' | 'sent' | 'cooldown' | 'unavailable';
  incoming: CareSignal | null; checked: boolean; error: boolean }>;
const empty: CareView = { available: false, busy: false, status: 'idle', incoming: null, checked: false, error: false };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function same(a: SessionContext, b: SessionContext) {
  return a.state === 'ready' && b.state === 'ready' && a.sessionId === b.sessionId
    && a.userId === b.userId && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch;
}
function validSignal(v: unknown, context: SessionContext, clientId: string | null): v is CareSignal {
  if (!record(v) || context.state !== 'ready') return false;
  return uuid(v.id) && uuid(v.clientId) && uuid(v.senderId) && uuid(v.recipientId)
    && v.senderId !== v.recipientId && v.coupleId === context.coupleId
    && v.membershipEpoch === context.membershipEpoch && v.kind === 'thinking_of_you'
    && typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt))
    && (clientId === null ? v.recipientId === context.userId && v.senderId !== context.userId
      : v.clientId === clientId && v.senderId === context.userId && v.recipientId !== context.userId);
}
/** Ephemeral explicit actions only. An unknown acknowledgement keeps its command ID until scope reset. */
export function createCareController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = empty;
  let bound: InvitationHostSnapshot | null = null;
  let pending: string | null = null;
  let sequence = 0;
  const listeners = new Set<() => void>();
  const publish = (next: CareView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; bound = null; pending = null; publish(empty); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && same(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...empty, available: true }); }
  }
  async function run(send: boolean) {
    if (view.busy || !view.available || !bound) return;
    const expected = bound;
    const id = ++sequence;
    const current = () => {
      const next = host.capture();
      return sequence === id && next !== null && next.generation === expected.generation
        && next.identity === expected.identity && same(next.context, expected.context);
    };
    publish({ ...view, busy: true, error: false, ...(send ? { status: 'sending' as const } : {}) });
    try {
      const cookie = await host.getCookie();
      if (!current()) return;
      const binding = await readSessionContext(settings, expected.identity.sessionId, cookie, request);
      if (!current()) return;
      if (!binding.ok) {
        if (binding.error !== 'transport_error') { host.block('auth_required'); reset(); return; }
        throw new Error('retry');
      }
      if (!same(expected.context, binding.value)) { reset(); await host.refresh(); return; }
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      const context = binding.value;
      if (context.state !== 'ready') return;
      if (send) { pending ??= commandId(); if (!uuid(pending)) throw new Error('invalid_command'); }
      const clientId = send ? pending : null;
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/care-signals'
        + (send ? '' : '?membership_epoch=' + context.membershipEpoch), {
        method: send ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(send ? { 'Content-Type': 'application/json', 'Idempotency-Key': clientId! } : {}) },
        ...(send ? { body: JSON.stringify({ client_signal_id: clientId, membership_epoch: context.membershipEpoch }) } : {}),
        credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if ([401, 403, 409].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (response.status === 404) { publish({ ...view, status: 'unavailable' }); return; }
      if (send && response.status === 429) { pending = null; publish({ ...view, status: 'cooldown' }); return; }
      if (![200, 201].includes(response.status)) throw new Error('retry');
      const body = await readBoundedJson(response, 4096);
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if (!record(body) || body.ok !== true || !record(body.value)) throw new Error('invalid_response');
      const signal = body.value.signal;
      if (send) {
        if (typeof body.value.replay !== 'boolean' || !validSignal(signal, context, clientId)) throw new Error('invalid_response');
        pending = null; publish({ ...view, status: 'sent' });
      } else {
        if (signal !== null && !validSignal(signal, context, null)) throw new Error('invalid_response');
        publish({ ...view, incoming: signal, checked: true });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(send ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) publish({ ...view, busy: false }); }
  }
  return { reset, sync, actions: { getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    send: () => run(true), read: () => run(false),
  } };
}
