import { readBoundedJson } from '../chat/transport';
import { readSessionContext, type SessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHostSnapshot } from './invitations-controller';
export type LeaveView = Readonly<{ available: boolean; status: 'idle' | 'confirming' | 'pending' | 'retry' | 'closed' | 'unavailable' }>;
export type LeaveHost = {
  capture(): InvitationHostSnapshot | null;
  getCookie(): Promise<string>;
  suspend(): InvitationHostSnapshot | null;
  finish(): void;
  block(error: string): void;
};
const empty: LeaveView = { available: false, status: 'idle' };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: SessionContext, b: SessionContext) => a.state === 'ready' && b.state === 'ready'
  && a.sessionId === b.sessionId && a.userId === b.userId && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch;
type Command = Readonly<{ commandId: string; coupleId: string; membershipEpoch: number; confirm: true }>;
/** The frozen confirmation survives an unknown ACK only in this authenticated in-memory lifecycle. */
export function createLeaveController(config: SyntheticConfig, host: LeaveHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = empty;
  let bound: InvitationHostSnapshot | null = null;
  let command: Command | null = null;
  let submitted = false;
  let sequence = 0;
  const listeners = new Set<() => void>();
  const publish = (next: LeaveView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; bound = null; command = null; submitted = false; publish(empty); }
  function sync() {
    if (view.status !== 'idle') return;
    const current = host.capture();
    publish({ ...empty, available: current?.context.state === 'ready' });
  }
  function begin() {
    if (!view.available || view.status !== 'idle') return;
    const captured = host.capture();
    if (captured?.context.state !== 'ready') { reset(); return; }
    bound = { ...captured, context: Object.freeze({ ...captured.context }) };
    publish({ available: true, status: 'confirming' });
  }
  function cancel() {
    // Cancellation exists only before dispatch. Aborting HTTP cannot undo a committed transaction.
    if (view.status !== 'confirming') return;
    reset(); sync();
  }
  async function confirm() {
    if (!bound || !['confirming', 'retry'].includes(view.status)) return;
    if (!command) {
      const context = bound.context;
      if (context.state !== 'ready') return;
      let id: string;
      try { id = commandId(); } catch { reset(); return; }
      if (!uuid(id)) { reset(); return; }
      command = Object.freeze({ commandId: id.toLowerCase(), coupleId: context.coupleId, membershipEpoch: context.membershipEpoch, confirm: true });
    }
    const original = bound;
    const snapshot = host.capture();
    if (!snapshot || snapshot.identity !== original.identity || snapshot.generation !== original.generation) { reset(); return; }
    if (!submitted && !same(snapshot.context, original.context)) { reset(); return; }
    const suspended = host.suspend();
    if (!suspended) { reset(); return; }
    bound = { ...suspended, context: original.context };
    const expected = bound;
    const frozen = command;
    const id = ++sequence;
    const current = () => {
      const next = host.capture();
      return id === sequence && next !== null && next.identity === expected.identity && next.generation === expected.generation;
    };
    publish({ available: false, status: 'pending' });
    try {
      const cookie = await host.getCookie();
      if (!current()) return;
      const binding = await readSessionContext(settings, expected.identity.sessionId, cookie, request);
      if (!current()) return;
      if (!binding.ok) {
        if (binding.error !== 'transport_error') { host.block('auth_required'); reset(); return; }
        throw new Error('unknown');
      }
      const context = binding.value;
      if (context.state === 'unmapped' || expected.context.state !== 'ready' || context.userId !== expected.context.userId) {
        host.block('auth_required'); reset(); return;
      }
      if (!submitted && !same(context, expected.context)) {
        publish({ available: false, status: 'unavailable' }); host.finish(); return;
      }
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      submitted = true;
      const response = await request(new Request(settings.baseURL + '/v1/pair/leave', {
        method: 'POST', headers: { Cookie: cookie, Origin: settings.baseURL, 'Content-Type': 'application/json' },
        body: JSON.stringify(frozen), credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if (response.status === 401 || response.status === 403) { host.block('auth_required'); reset(); return; }
      if (response.status === 409) { publish({ available: false, status: 'unavailable' }); host.finish(); return; }
      if (response.status !== 200) throw new Error('unknown');
      const body = await readBoundedJson(response, 4096);
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if (!record(body) || body.ok !== true || !record(body.value)) throw new Error('invalid_response');
      const value = body.value;
      if (value.state !== 'closed' || value.sessionId !== expected.identity.sessionId || value.userId !== context.userId
        || value.coupleId !== frozen.coupleId || value.membershipEpoch !== frozen.membershipEpoch
        || value.commandId !== frozen.commandId || typeof value.replayed !== 'boolean') throw new Error('invalid_response');
      publish({ available: false, status: 'closed' }); host.finish();
    } catch { if (current()) publish({ available: false, status: 'retry' }); }
  }
  return { reset, sync, unresolved: () => ['pending', 'retry'].includes(view.status), actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    begin, cancel, confirm,
  } };
}
