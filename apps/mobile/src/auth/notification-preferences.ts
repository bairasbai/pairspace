import { evaluateNotificationPolicy } from '../../../../packages/domain/notifications/preferences';
import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyNotifications, defaultNotificationFields, record, sameDateContext, instant, uuid, validPreferences, sameFields, validFields, validPreview, copyFields, category,
  type NotificationView, type NotificationFields, type Quiet, type Category } from './notification-preferences-state';
type Pending = Readonly<{ id: string; fields: NotificationFields; version: number; revision: number }>;
export function createNotificationPreferencesController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyNotifications;
  let bound: InvitationHostSnapshot | null = null;
  let pending: Pending | null = null;
  let revision = 0, sequence = 0;
  let activeAction: 'save' | 'list' | 'preview' | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: NotificationView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; revision++; activeAction = null; bound = null; pending = null; publish(emptyNotifications); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && sameDateContext(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...emptyNotifications, available: true }); }
  }
  async function run(action: 'save' | 'list' | 'preview', requested: Category = 'care') {
    if (view.busy || !view.available || !bound || (action === 'save' && (!pending || view.requiresRefresh))) return;
    const command = pending, expected = bound, id = ++sequence;
    const current = () => {
      const next = host.capture();
      return sequence === id && next !== null && next.generation === expected.generation
        && next.identity === expected.identity && sameDateContext(next.context, expected.context);
    };
    activeAction = action;
    publish({ ...view, busy: true, error: false, policyPreview: null, ...(action === 'save' ? { status: 'saving' as const } : {}) });
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
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/notification-preferences'
        + (save ? '' : (action === 'preview' ? '/preview' : '') + '?membership_epoch=' + context.membershipEpoch + (action === 'preview' ? '&category=' + requested : '')), {
        method: save ? 'PUT' : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(save ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(save ? { body: JSON.stringify({ command_id: command!.id, membership_epoch: context.membershipEpoch,
          expected_version: command!.version, ...command!.fields }) } : {}),
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
        || (view.asOf !== null && value.asOf < view.asOf)) throw new Error('retry');
      if (action === 'preview') {
        if (!validPreview(value, requested) || (view.preferences && value.preferenceVersion < view.preferences.version)) throw new Error('retry');
        if (view.preferences && value.preferenceVersion === view.preferences.version) {
          const expectedPolicy = evaluateNotificationPolicy(view.preferences, requested, new Date(value.asOf));
          if (value.reason !== expectedPolicy.reason || value.allowedByPreferences !== expectedPolicy.allowedByPreferences) throw new Error('retry');
        }
        publish({ ...view, policyPreview: value }); return;
      }
      if (Object.keys(value).sort().join(',') !== (save ? 'asOf,commandId,preferences,replay' : 'asOf,preferences')) throw new Error('retry');
      const preferences = value.preferences;
      if (!validPreferences(preferences, context) || (view.preferences && (preferences.version < view.preferences.version
        || (preferences.version === view.preferences.version && !sameFields(preferences, view.preferences))))) throw new Error('retry');
      if (save) {
        if (typeof value.replay !== 'boolean' || value.commandId !== command!.id || preferences.version < Math.max(1, command!.version)
          || ((!value.replay || (command!.version === 0 && preferences.version === 1)) && (![Math.max(1, command!.version), command!.version + 1].includes(preferences.version)
            || !sameFields(preferences, command!.fields)))) throw new Error('retry');
        pending = null;
        publish({ ...view, preferences, checked: true, asOf: value.asOf, pending: null, status: 'saved',
          ...(revision === command!.revision ? { fields: copyFields(preferences), editingVersion: preferences.version } : {}) });
      } else {
        publish({ ...view, preferences, checked: true, asOf: value.asOf, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(action === 'save' ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { activeAction = null; publish({ ...view, busy: false }); } }
  }
  function prepare() {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    if (view.editingVersion !== null && view.editingVersion !== (view.preferences?.version ?? 0)) {
      publish({ ...view, status: 'conflict', requiresRefresh: true, error: true }); return Promise.resolve();
    }
    const id = commandId();
    if (!validFields(view.fields) || !uuid(id) || (view.preferences !== null && view.editingVersion === null)) {
      publish({ ...view, status: 'invalid' }); return Promise.resolve();
    }
    const fields = copyFields(view.fields);
    pending = Object.freeze({ id, fields, version: view.editingVersion ?? 0, revision });
    publish({ ...view, pending: fields }); return run('save');
  }
  return { reset, sync, actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setCategory(key: Category, value: boolean) {
      if (view.available && category(key) && typeof value === 'boolean') { revision++; publish({ ...view, fields: copyFields({ ...view.fields, [key]: value }), policyPreview: null }); }
    },
    setQuiet(quiet: Quiet | null) {
      if (view.available) { revision++; publish({ ...view, fields: copyFields({ ...view.fields, quiet }), policyPreview: null }); }
    },
    beginEdit() {
      if (!view.available || view.busy || pending || view.requiresRefresh || !view.checked) return;
      revision++;
      const p = view.preferences!;
      publish({ ...view, editingVersion: p.version, fields: copyFields(p), status: 'idle', error: false, policyPreview: null });
    },
    save: prepare, retry: () => run('save'), load: () => run('list'),
    preview(requested: Category) { return category(requested) ? run('preview', requested) : Promise.resolve(); },
    cancel() {
      revision++;
      if (activeAction === 'list' || activeAction === 'preview') { sequence++; activeAction = null; publish({ ...view, busy: false }); }
      publish({ ...view, editingVersion: null, fields: defaultNotificationFields, policyPreview: null });
    },
  } };
}
