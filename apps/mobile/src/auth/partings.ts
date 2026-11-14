import { isLocalDate, validatedTimezone } from '../../../../packages/domain/dates/calendar';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyPartings, record, sameDateContext, instant, isPartingDates, partingOrder, uuid, validParting, type PartingsView } from './partings-state';
export type { Parting, PartingsView } from './partings-state';
type Pending = Readonly<{ editing: PartingsView['editing']; id: string; title: string; startDate: string; timezone: string; endDate: string; revision: number }>;
/** Drafts and unresolved immutable commands exist only in RAM, scoped to the verified session/pair. */
export function createPartingsController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyPartings;
  let bound: InvitationHostSnapshot | null = null;
  let pending: Pending | null = null;
  let revision = 0, sequence = 0;
  let activeAction: 'save' | 'list' | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: PartingsView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; revision++; activeAction = null; bound = null; pending = null; publish(emptyPartings); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && sameDateContext(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...emptyPartings, available: true }); }
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
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/partings'
        + (save ? (command!.editing ? '/' + command!.editing.id : '') : '?membership_epoch=' + context.membershipEpoch), {
        method: save ? (command!.editing ? 'PATCH' : 'POST') : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(save ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(save ? { body: JSON.stringify({ command_id: command!.id, membership_epoch: context.membershipEpoch,
          ...(command!.editing ? { expected_version: command!.editing.version } : {}),
          title: command!.title, start_date: command!.startDate, timezone: command!.timezone, end_date: command!.endDate }) } : {}),
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
        if (['version_conflict', 'idempotency_conflict', 'overlap', 'capacity_limit'].includes(String(body.error))) {
          pending = null;
          publish({ ...view, pending: null, status: 'conflict', requiresRefresh: true, error: true }); return;
        }
      }
      if (save && response.status === 400 && record(body) && body.ok === false && body.error === 'invalid_request') {
        pending = null; publish({ ...view, pending: null, status: 'invalid', error: true }); return;
      }
      if (![200, 201].includes(response.status) || !record(body) || body.ok !== true || !record(body.value)) throw new Error('retry');
      const value = body.value;
      if (save) {
        const date = value.parting;
        if (!instant(value.asOf)) throw new Error('retry');
        if (!validParting(date, context) || typeof value.replay !== 'boolean' || value.commandId !== command!.id
          || (command!.editing ? date.id !== command!.editing.id || date.version < command!.editing.version
            : date.creatorId !== context.userId)
          || ((!value.replay || date.version === 1) && (date.title !== command!.title || date.startDate !== command!.startDate
            || date.endDate !== command!.endDate
            || date.timezone !== command!.timezone || (command!.editing ? ![command!.editing.version, command!.editing.version + 1].includes(date.version) : date.version !== 1)))) throw new Error('retry');
        const known = view.partings.find(item => item.id === date.id);
        if (known && known.version === date.version && Object.keys(known).some(key => known[key as keyof typeof known] !== date[key as keyof typeof date])) throw new Error('retry');
        if (!known && view.partings.length >= 100) throw new Error('retry');
        const canonical = known && known.version > date.version ? known : date;
        pending = null;
        publish({ ...view, pending: null, status: 'saved', checked: false, asOf: null,
          ...(revision === command!.revision ? { editing: null, draft: '', startDate: '', timezone: '', endDate: '' } : {}),
          partings: [canonical, ...view.partings.filter(item => item.id !== date.id)].sort(partingOrder) });
      } else {
        const dates = value.partings;
        if (!instant(value.asOf) || value.limit !== 100 || !Array.isArray(dates) || dates.length > 100
          || dates.some(item => !validParting(item, context)) || new Set(dates.map(item => item.id)).size !== dates.length
          || dates.some((item, index) => index > 0 && partingOrder(dates[index - 1], item) >= 0)) throw new Error('retry');
        if (view.partings.some(known => !dates.some(item => item.id === known.id && item.version >= known.version
          && (item.version !== known.version || Object.keys(known).every(key => known[key as keyof typeof known] === item[key as keyof typeof item]))))) throw new Error('retry');
        publish({ ...view, partings: dates, asOf: value.asOf, checked: true, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(action === 'save' ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { activeAction = null; publish({ ...view, busy: false }); } }
  }
  function prepare() {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    if (view.editing && !view.partings.some(item => item.id === view.editing!.id && item.version === view.editing!.version)) {
      publish({ ...view, status: 'conflict', requiresRefresh: true, error: true }); return Promise.resolve();
    }
    const title = normalizeTaskTitle(view.draft), timezone = validatedTimezone(view.timezone), id = commandId();
    if (!title.ok || !isLocalDate(view.startDate) || !timezone || !uuid(id)
      || !isPartingDates(view.startDate, view.endDate)) {
      publish({ ...view, status: 'invalid' }); return Promise.resolve();
    }
    pending = Object.freeze({ editing: view.editing, id, title: title.text, startDate: view.startDate, timezone, endDate: view.endDate, revision });
    publish({ ...view, pending: { title: title.text, startDate: view.startDate, timezone, endDate: view.endDate } });
    return run('save');
  }
  return { reset, sync, actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) { if (view.available) { revision++; publish({ ...view, draft: draft.slice(0, 800) }); } },
    setStartDate(startDate: string) { if (view.available) { revision++; publish({ ...view, startDate: startDate.slice(0, 10) }); } },
    setEndDate(endDate: string) { if (view.available) { revision++; publish({ ...view, endDate: endDate.slice(0, 10) }); } },
    setTimezone(timezone: string) { if (view.available) { revision++; publish({ ...view, timezone: timezone.slice(0, 100) }); } },
    beginEdit(id: string) {
      if (!view.available || view.busy || pending || view.requiresRefresh) return;
      const date = view.partings.find(item => item.id === id);
      if (!date) return;
      revision++;
      publish({ ...view, editing: Object.freeze({ id: date.id, version: date.version }), draft: date.title,
        startDate: date.startDate, timezone: date.timezone, endDate: date.endDate, status: 'idle', error: false });
    },
    create: prepare,
    retry: () => run('save'), list: () => run('list'),
    cancel() {
      revision++;
      // Cancel only the unsent draft/read. An already submitted command may have committed.
      if (activeAction === 'list') { sequence++; activeAction = null; publish({ ...view, busy: false }); }
      publish({ ...view, editing: null, draft: '', startDate: '', timezone: '', endDate: '' });
    },
  } };
}
