import { normalizeWishExplanation } from '../../../../packages/domain/wishes/text';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyWishes, record, sameWishContext, wishOrder, uuid, validWish, type WishesView } from './wishes-state';
export type { SharedWish, WishesView } from './wishes-state';
type Pending = Readonly<{ id: string; operation: 'create' | 'fulfill' | 'reopen'; title: string; explanation: string;
  wishId: string | null; version: number; revision: number }>;
/** Drafts and unresolved immutable commands exist only in RAM, scoped to the verified session/pair. */
export function createWishesController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyWishes;
  let bound: InvitationHostSnapshot | null = null;
  let pending: Pending | null = null;
  let revision = 0, sequence = 0;
  let activeAction: 'save' | 'list' | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: WishesView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; revision++; activeAction = null; bound = null; pending = null; publish(emptyWishes); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && sameWishContext(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...emptyWishes, available: true }); }
  }
  async function run(action: 'save' | 'list') {
    if (view.busy || !view.available || !bound || (action === 'save' && (!pending || view.requiresRefresh))) return;
    const command = pending, expected = bound, id = ++sequence;
    const current = () => {
      const next = host.capture();
      return sequence === id && next !== null && next.generation === expected.generation
        && next.identity === expected.identity && sameWishContext(next.context, expected.context);
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
      if (!sameWishContext(expected.context, binding.value)) { reset(); await host.refresh(); return; }
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      const context = binding.value;
      if (context.state !== 'ready') return;
      const save = action === 'save';
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/wishes'
        + (save ? (command!.wishId ? '/' + command!.wishId : '') : '?membership_epoch=' + context.membershipEpoch), {
        method: save ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(save ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(save ? { body: JSON.stringify({ command_id: command!.id, membership_epoch: context.membershipEpoch,
          ...(command!.operation === 'create' ? { title: command!.title, explanation: command!.explanation }
            : { operation: command!.operation, expected_version: command!.version }) }) } : {}),
        credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if ([401, 403].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (response.status === 404) { publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true }); return; }
      const body = await readBoundedJson(response, 1048576);
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if (response.status === 409 && record(body) && body.ok === false) {
        if (body.error === 'stale_membership') { host.block('access_required'); reset(); return; }
        if (body.error === 'version_conflict' || body.error === 'idempotency_conflict') {
          pending = null;
          publish({ ...view, pending: null, status: 'conflict', requiresRefresh: true, consent: false, error: true }); return;
        }
      }
      if (save && response.status === 400 && record(body) && body.ok === false && body.error === 'invalid_request') {
        pending = null; publish({ ...view, pending: null, status: 'invalid', error: true }); return;
      }
      if (![200, 201].includes(response.status) || !record(body) || body.ok !== true || !record(body.value) || Object.keys(body).sort().join(',') !== 'ok,value') throw new Error('retry');
      const value = body.value;
      if (Object.keys(value).sort().join(',') !== (save ? 'appliedVersion,commandId,replay,wish' : 'limit,wishes')) throw new Error('retry');
      if (save) {
        const wish = value.wish;
        const appliedVersion = command!.operation === 'create' ? 1 : command!.version + 1;
        if (!validWish(wish, context) || typeof value.replay !== 'boolean' || value.commandId !== command!.id
          || value.appliedVersion !== appliedVersion || wish.version < appliedVersion
          || (wish.version > appliedVersion && value.replay !== true)
          || (command!.wishId !== null && wish.id !== command!.wishId) || wish.title !== command!.title || wish.explanation !== command!.explanation
          || (command!.operation === 'create' && wish.creatorId !== context.userId)
          || (wish.version === appliedVersion && wish.state !== (command!.operation === 'fulfill' ? 'fulfilled' : 'open'))) throw new Error('retry');
        const known = view.wishes.find(item => item.id === wish.id);
        const canonical = known && known.version > wish.version ? known : wish;
        pending = null;
        // Never report a historical completion: render the server's current version/state.
        publish({ ...view, pending: null, status: 'saved',
          ...(command!.operation === 'create' && revision === command!.revision ? { draft: '', explanation: '', consent: false } : {}),
          wishes: [canonical, ...view.wishes.filter(item => item.id !== wish.id)].sort(wishOrder).slice(0, 50) });
      } else {
        const wishes = value.wishes;
        if (value.limit !== 50 || !Array.isArray(wishes) || wishes.length > 50
          || wishes.some(item => !validWish(item, context)) || new Set(wishes.map(item => item.id)).size !== wishes.length
          || wishes.some((item, index) => index > 0 && wishOrder(wishes[index - 1], item) >= 0)) throw new Error('retry');
        publish({ ...view, wishes, checked: true, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(action === 'save' ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { activeAction = null; publish({ ...view, busy: false }); } }
  }
  function prepare(operation: Pending['operation'], wishId: string | null = null) {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    const wish = view.wishes.find(item => item.id === wishId);
    if (operation !== 'create' && (!wish || wish.version >= 2147483647 || wish.state !== (operation === 'fulfill' ? 'open' : 'fulfilled'))) return Promise.resolve();
    if (operation === 'create' && !view.consent) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    const explanation = normalizeWishExplanation(operation === 'create' ? view.explanation : wish!.explanation);
    const title = normalizeTaskTitle(operation === 'create' ? view.draft : wish!.title), id = commandId().toLowerCase();
    if (!title.ok || !explanation.ok || !uuid(id)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    pending = Object.freeze({ id, operation, wishId, title: title.text, explanation: explanation.text, version: wish?.version ?? 0, revision });
    publish({ ...view, pending: { operation, title: title.text, explanation: explanation.text }, ...(operation === 'create' ? { consent: false } : {}) });
    return run('save');
  }
  return { reset, sync, actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) { if (view.available) { revision++; publish({ ...view, draft: draft.slice(0, 1600), consent: false }); } },
    setExplanation(explanation: string) { if (view.available) { revision++; publish({ ...view, explanation: explanation.slice(0, 1201), consent: false }); } },
    setConsent(consent: boolean) { if (view.available) publish({ ...view, consent }); },
    create: () => prepare('create'), fulfill: (id: string) => prepare('fulfill', id), reopen: (id: string) => prepare('reopen', id),
    retry: () => run('save'), list: () => run('list'),
    cancel() {
      revision++;
      // Cancel only the unsent draft/read. An already submitted command may have committed.
      if (activeAction === 'list') { sequence++; activeAction = null; publish({ ...view, busy: false }); }
      publish({ ...view, draft: '', explanation: '', consent: false });
    },
  } };
}
