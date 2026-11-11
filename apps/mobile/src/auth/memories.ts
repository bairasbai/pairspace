import { isLocalDate } from '../../../../packages/domain/dates/calendar';
import { normalizeMemoryBody } from '../../../../packages/domain/memories/text';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyMemories, record, sameMemoryContext, memoryOrder, uuid, validMemory, type MemoriesView } from './memories-state';
export type { SharedMemory, MemoriesView } from './memories-state';
type Pending = Readonly<{ id: string; title: string; body: string; localDate: string; revision: number }>;
/** Drafts and unresolved immutable commands exist only in RAM, scoped to the verified session/pair. */
export function createMemoriesController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyMemories;
  let bound: InvitationHostSnapshot | null = null;
  let pending: Pending | null = null;
  let revision = 0, sequence = 0;
  let activeAction: 'save' | 'list' | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: MemoriesView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; revision++; activeAction = null; bound = null; pending = null; publish(emptyMemories); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && sameMemoryContext(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...emptyMemories, available: true }); }
  }
  async function run(action: 'save' | 'list') {
    if (view.busy || !view.available || !bound || (action === 'save' && (!pending || view.requiresRefresh))) return;
    const command = pending, expected = bound, id = ++sequence;
    const current = () => {
      const next = host.capture();
      return sequence === id && next !== null && next.generation === expected.generation
        && next.identity === expected.identity && sameMemoryContext(next.context, expected.context);
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
      if (!sameMemoryContext(expected.context, binding.value)) { reset(); await host.refresh(); return; }
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      const context = binding.value;
      if (context.state !== 'ready') return;
      const save = action === 'save';
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/memories'
        + (save ? '' : '?membership_epoch=' + context.membershipEpoch), {
        method: save ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(save ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(save ? { body: JSON.stringify({ command_id: command!.id, membership_epoch: context.membershipEpoch,
          title: command!.title, body: command!.body, local_date: command!.localDate }) } : {}),
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
        if (body.error === 'idempotency_conflict') {
          pending = null;
          publish({ ...view, pending: null, status: 'conflict', requiresRefresh: true, error: true }); return;
        }
      }
      if (save && response.status === 400 && record(body) && body.ok === false && body.error === 'invalid_request') {
        pending = null; publish({ ...view, pending: null, status: 'invalid', error: true }); return;
      }
      if (![200, 201].includes(response.status) || !record(body) || body.ok !== true || !record(body.value) || Object.keys(body).sort().join(',') !== 'ok,value') throw new Error('retry');
      const value = body.value;
      if (Object.keys(value).sort().join(',') !== (save ? 'commandId,memory,replay' : 'limit,memories')) throw new Error('retry');
      if (save) {
        const memory = value.memory;
        if (!validMemory(memory, context) || typeof value.replay !== 'boolean' || value.commandId !== command!.id
          || memory.creatorId !== context.userId || memory.title !== command!.title
          || memory.body !== command!.body || memory.localDate !== command!.localDate) throw new Error('retry');
        pending = null;
        publish({ ...view, pending: null, status: 'saved',
          ...(revision === command!.revision ? { draft: '', body: '', localDate: '', consent: false } : {}),
          memories: [memory, ...view.memories.filter(item => item.id !== memory.id)].sort(memoryOrder).slice(0, 50) });
      } else {
        const memories = value.memories;
        if (value.limit !== 50 || !Array.isArray(memories) || memories.length > 50
          || memories.some(item => !validMemory(item, context)) || new Set(memories.map(item => item.id)).size !== memories.length
          || memories.some((item, index) => index > 0 && memoryOrder(memories[index - 1], item) >= 0)) throw new Error('retry');
        publish({ ...view, memories, checked: true, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(action === 'save' ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { activeAction = null; publish({ ...view, busy: false }); } }
  }
  function prepare() {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    if (!view.consent) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    const title = normalizeTaskTitle(view.draft), body = normalizeMemoryBody(view.body), id = commandId().toLowerCase();
    if (!title.ok || !body.ok || !isLocalDate(view.localDate) || !uuid(id)) {
      publish({ ...view, status: 'invalid' }); return Promise.resolve();
    }
    pending = Object.freeze({ id, title: title.text, body: body.text, localDate: view.localDate, revision });
    publish({ ...view, pending: { title: title.text, body: body.text, localDate: view.localDate }, consent: false });
    return run('save');
  }
  return { reset, sync, actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) { if (view.available) { revision++; publish({ ...view, draft: draft.slice(0, 800), consent: false }); } },
    setBody(body: string) { if (view.available) { revision++; publish({ ...view, body: body.slice(0, 8000), consent: false }); } },
    setLocalDate(localDate: string) { if (view.available) { revision++; publish({ ...view, localDate: localDate.slice(0, 10), consent: false }); } },
    setConsent(consent: boolean) { if (view.available) publish({ ...view, consent }); },
    create: prepare,
    retry: () => run('save'), list: () => run('list'),
    cancel() {
      revision++;
      // Cancel only the unsent draft/read. An already submitted command may have committed.
      if (activeAction === 'list') { sequence++; activeAction = null; publish({ ...view, busy: false }); }
      publish({ ...view, draft: '', body: '', localDate: '', consent: false });
    },
  } };
}
