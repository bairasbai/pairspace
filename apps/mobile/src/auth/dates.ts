import { isLocalDate, validatedTimezone } from '../../../../packages/domain/dates/calendar';
import { isDateSchedule, type Recurrence, type LeapDayPolicy } from '../../../../packages/domain/dates/recurrence';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyDates, record, sameDateContext, dateOrder, uuid, validDate, type DatesView } from './dates-state';
export type { SharedDate, DatesView } from './dates-state';
type Pending = Readonly<{ editing: DatesView['editing']; id: string; title: string; localDate: string; timezone: string; recurrence: Recurrence; leapDayPolicy: LeapDayPolicy | null; revision: number }>;
/** Drafts and unresolved immutable commands exist only in RAM, scoped to the verified session/pair. */
export function createDatesController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyDates;
  let bound: InvitationHostSnapshot | null = null;
  let pending: Pending | null = null;
  let revision = 0, sequence = 0;
  let activeAction: 'save' | 'list' | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: DatesView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; revision++; activeAction = null; bound = null; pending = null; publish(emptyDates); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && sameDateContext(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...emptyDates, available: true }); }
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
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/dates'
        + (save ? (command!.editing ? '/' + command!.editing.id : '') : '?membership_epoch=' + context.membershipEpoch), {
        method: save ? (command!.editing ? 'PATCH' : 'POST') : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(save ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(save ? { body: JSON.stringify({ command_id: command!.id, membership_epoch: context.membershipEpoch,
          ...(command!.editing ? { expected_version: command!.editing.version } : {}),
          title: command!.title, local_date: command!.localDate, timezone: command!.timezone, recurrence: command!.recurrence, leap_day_policy: command!.leapDayPolicy }) } : {}),
        credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if ([401, 403].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (response.status === 404) { publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true }); return; }
      const body = await readBoundedJson(response, 131072);
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if (response.status === 409 && record(body) && body.ok === false) {
        if (body.error === 'stale_membership') { host.block('access_required'); reset(); return; }
        if (body.error === 'version_conflict' || body.error === 'idempotency_conflict') {
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
        const date = value.date;
        if (!validDate(date, context) || typeof value.replay !== 'boolean' || value.commandId !== command!.id
          || (command!.editing ? date.id !== command!.editing.id || date.version <= command!.editing.version
            : date.creatorId !== context.userId)
          || ((!value.replay || date.version === 1) && (date.title !== command!.title || date.localDate !== command!.localDate
            || date.recurrence !== command!.recurrence || date.leapDayPolicy !== command!.leapDayPolicy
            || date.timezone !== command!.timezone || date.version !== (command!.editing ? command!.editing.version + 1 : 1)))) throw new Error('retry');
        const known = view.dates.find(item => item.id === date.id);
        const canonical = known && known.version > date.version ? known : date;
        pending = null;
        publish({ ...view, pending: null, status: 'saved',
          ...(revision === command!.revision ? { editing: null, draft: '', localDate: '', timezone: '', recurrence: 'once' as const, leapDayPolicy: null } : {}),
          dates: [canonical, ...view.dates.filter(item => item.id !== date.id)].sort(dateOrder).slice(0, 50) });
      } else {
        const dates = value.dates;
        if (value.limit !== 50 || !Array.isArray(dates) || dates.length > 50
          || dates.some(item => !validDate(item, context)) || new Set(dates.map(item => item.id)).size !== dates.length
          || dates.some((item, index) => index > 0 && dateOrder(dates[index - 1], item) >= 0)) throw new Error('retry');
        publish({ ...view, dates, checked: true, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(action === 'save' ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { activeAction = null; publish({ ...view, busy: false }); } }
  }
  function prepare() {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    if (view.editing && !view.dates.some(item => item.id === view.editing!.id && item.version === view.editing!.version)) {
      publish({ ...view, status: 'conflict', requiresRefresh: true, error: true }); return Promise.resolve();
    }
    const title = normalizeTaskTitle(view.draft), timezone = validatedTimezone(view.timezone), id = commandId();
    if (!title.ok || !isLocalDate(view.localDate) || !timezone || !uuid(id)
      || !isDateSchedule(view.localDate, view.recurrence, view.leapDayPolicy)) {
      publish({ ...view, status: 'invalid' }); return Promise.resolve();
    }
    pending = Object.freeze({ editing: view.editing, id, title: title.text, localDate: view.localDate, timezone, recurrence: view.recurrence, leapDayPolicy: view.leapDayPolicy, revision });
    publish({ ...view, pending: { title: title.text, localDate: view.localDate, timezone, recurrence: view.recurrence, leapDayPolicy: view.leapDayPolicy } });
    return run('save');
  }
  return { reset, sync, actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) { if (view.available) { revision++; publish({ ...view, draft: draft.slice(0, 800) }); } },
    setLocalDate(localDate: string) { if (view.available) { revision++; publish({ ...view, localDate: localDate.slice(0, 10),
      leapDayPolicy: localDate === view.localDate ? view.leapDayPolicy : null }); } },
    setTimezone(timezone: string) { if (view.available) { revision++; publish({ ...view, timezone: timezone.slice(0, 100) }); } },
    setRecurrence(recurrence: Recurrence) { if (view.available) { revision++;
      publish({ ...view, recurrence, leapDayPolicy: recurrence === view.recurrence ? view.leapDayPolicy : null }); } },
    setLeapDayPolicy(leapDayPolicy: LeapDayPolicy) { if (view.available && view.recurrence === 'annual' && view.localDate.endsWith('-02-29')) {
      revision++; publish({ ...view, leapDayPolicy });
    } },
    beginEdit(id: string) {
      if (!view.available || view.busy || pending || view.requiresRefresh) return;
      const date = view.dates.find(item => item.id === id);
      if (!date) return;
      revision++;
      publish({ ...view, editing: Object.freeze({ id: date.id, version: date.version }), draft: date.title,
        localDate: date.localDate, timezone: date.timezone, recurrence: date.recurrence,
        leapDayPolicy: date.leapDayPolicy, status: 'idle', error: false });
    },
    create: prepare,
    retry: () => run('save'), list: () => run('list'),
    cancel() {
      revision++;
      // Cancel only the unsent draft/read. An already submitted command may have committed.
      if (activeAction === 'list') { sequence++; activeAction = null; publish({ ...view, busy: false }); }
      publish({ ...view, editing: null, draft: '', localDate: '', timezone: '', recurrence: 'once', leapDayPolicy: null });
    },
  } };
}
