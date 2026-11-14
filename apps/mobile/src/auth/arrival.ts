import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyArrival, blankArrival, record, sameDateContext, instant, uuid, validArrival, sameArrival, parseArrivalFields,
  type ArrivalView, type ArrivalFields, type ArrivalPlan } from './arrival-state';
type Pending = Readonly<{ id: string; fields: ArrivalFields; version: number; revision: number }>;
export function createArrivalController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyArrival;
  let bound: InvitationHostSnapshot | null = null;
  let pending: Pending | null = null;
  let revision = 0, sequence = 0;
  let activeAction: 'save' | 'list' | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: ArrivalView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; revision++; activeAction = null; bound = null; pending = null; publish(emptyArrival); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && sameDateContext(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...emptyArrival, available: true }); }
  }
  async function run(action: 'save' | 'list') {
    if (view.busy || !view.available || !bound || (action === 'save' && (!pending || view.requiresRefresh))) return;
    const command = pending, expected = bound, id = ++sequence;
    const current = () => {
      const next = host.capture();
      return sequence === id && next !== null && next.generation === expected.generation
        && next.identity === expected.identity && sameDateContext(next.context, expected.context);
    };
    activeAction = action;
    publish({ ...view, busy: true, error: false, ...(action === 'save' ? { status: 'saving' as const } : {}) });
    try {
      const cookie = await host.getCookie();
      if (!current()) return;
      const binding = await readSessionContext(settings, expected.identity.sessionId, cookie, request);
      if (!current()) return;
      if (!binding.ok) {
        if (binding.error !== 'transport_error') { host.block('auth_required'); reset(); return; }
        throw new Error('retry');
      }
      if (!sameDateContext(expected.context, binding.value)) { reset(); await host.refresh(); return; }
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      const context = binding.value;
      if (context.state !== 'ready') return;
      const save = action === 'save';
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/arrival-plan'
        + (save ? '' : '?membership_epoch=' + context.membershipEpoch), {
        method: save ? 'PUT' : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(save ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(save ? { body: JSON.stringify({ command_id: command!.id, membership_epoch: context.membershipEpoch,
          expected_version: command!.version, label: command!.fields.label, local_date: command!.fields.localDate,
          local_time: command!.fields.localTime, timezone: command!.fields.timezone, offset: command!.fields.offset }) } : {}),
        credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if ([401, 403].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (response.status === 404) { publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true }); return; }
      const body = await readBoundedJson(response, 262144);
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if (response.status === 409 && record(body) && body.ok === false) {
        if (body.error === 'stale_membership') { host.block('access_required'); reset(); return; }
        if (['version_conflict', 'idempotency_conflict'].includes(String(body.error))) {
          pending = null;
          publish({ ...view, pending: null, status: 'conflict', requiresRefresh: true, error: true }); return;
        }
      }
      if (save && response.status === 400 && record(body) && body.ok === false && body.error === 'invalid_request') {
        pending = null; publish({ ...view, pending: null, status: 'invalid', error: true }); return;
      }
      if (response.status !== 200 || !record(body) || body.ok !== true || !record(body.value)) throw new Error('retry');
      const value = body.value;
      if (Object.keys(body).sort().join(',') !== 'ok,value' || !instant(value.asOf)
        || (view.asOf !== null && value.asOf < view.asOf)
        || Object.keys(value).sort().join(',') !== (save ? 'asOf,commandId,plan,replay' : 'asOf,plan')) throw new Error('retry');
      const plan = value.plan;
      if (plan !== null && !validArrival(plan, context)) throw new Error('retry');
      if (view.plan && (!plan || plan.id !== view.plan.id || plan.creatorId !== view.plan.creatorId
        || plan.createdAt !== view.plan.createdAt || plan.version < view.plan.version
        || (plan.version === view.plan.version && !sameArrival(plan, view.plan)))) throw new Error('retry');
      if (save) {
        if (!plan || typeof value.replay !== 'boolean' || value.commandId !== command!.id
          || plan.version < Math.max(1, command!.version)
          || (command!.version === 0 && plan.creatorId !== context.userId)
          || ((!value.replay || (command!.version === 0 && plan.version === 1)) && (![Math.max(1, command!.version), command!.version + 1].includes(plan.version)
            || Object.keys(command!.fields).some(key => plan[key as keyof ArrivalPlan] !== command!.fields[key as keyof ArrivalFields])))) throw new Error('retry');
        pending = null;
        publish({ ...view, plan, checked: true, asOf: value.asOf, pending: null, status: 'saved',
          ...(revision === command!.revision ? { fields: blankArrival, editingVersion: null } : {}) });
      } else {
        publish({ ...view, plan, checked: true, asOf: value.asOf, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(action === 'save' ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { activeAction = null; publish({ ...view, busy: false }); } }
  }
  function prepare() {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    if (view.editingVersion !== null && view.editingVersion !== (view.plan?.version ?? 0)) {
      publish({ ...view, status: 'conflict', requiresRefresh: true, error: true }); return Promise.resolve();
    }
    const fields = parseArrivalFields(view.fields), id = commandId();
    if (!fields || !uuid(id) || (view.plan !== null && view.editingVersion === null)) {
      publish({ ...view, status: 'invalid' }); return Promise.resolve();
    }
    pending = Object.freeze({ id, fields: Object.freeze(fields), version: view.editingVersion ?? 0, revision });
    publish({ ...view, pending: fields }); return run('save');
  }
  return { reset, sync, actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setField(key: keyof ArrivalFields, value: string) {
      if (view.available) { revision++; publish({ ...view, fields: { ...view.fields, [key]: value.slice(0, key === 'label' ? 800 : key === 'timezone' ? 100 : key === 'localDate' ? 10 : key === 'offset' ? 6 : 5) } }); }
    },
    beginEdit() {
      if (!view.available || view.busy || pending || view.requiresRefresh || !view.checked) return;
      revision++;
      const p = view.plan;
      publish({ ...view, editingVersion: p?.version ?? 0, fields: p ? { label: p.label, localDate: p.localDate,
        localTime: p.localTime, timezone: p.timezone, offset: p.offset } : blankArrival, status: 'idle', error: false });
    },
    save: prepare, retry: () => run('save'), load: () => run('list'),
    cancel() {
      revision++;
      if (activeAction === 'list') { sequence++; activeAction = null; publish({ ...view, busy: false }); }
      publish({ ...view, editingVersion: null, fields: blankArrival });
    },
  } };
}
