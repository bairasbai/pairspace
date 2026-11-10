import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyTasks, record, sameTaskContext, taskOrder, uuid, validTask, type TasksView } from './tasks-state';
export type { SharedTask, TasksView } from './tasks-state';
type Pending = Readonly<{ id: string; operation: 'create' | 'complete' | 'reopen'; title: string;
  taskId: string | null; version: number; revision: number }>;
/** Drafts and unresolved immutable commands exist only in RAM, scoped to the verified session/pair. */
export function createTasksController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyTasks;
  let bound: InvitationHostSnapshot | null = null;
  let pending: Pending | null = null;
  let revision = 0, sequence = 0;
  let activeAction: 'save' | 'list' | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: TasksView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; revision++; activeAction = null; bound = null; pending = null; publish(emptyTasks); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && sameTaskContext(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...emptyTasks, available: true }); }
  }
  async function run(action: 'save' | 'list') {
    if (view.busy || !view.available || !bound || (action === 'save' && (!pending || view.requiresRefresh))) return;
    const command = pending, expected = bound, id = ++sequence;
    const current = () => {
      const next = host.capture();
      return sequence === id && next !== null && next.generation === expected.generation
        && next.identity === expected.identity && sameTaskContext(next.context, expected.context);
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
      if (!sameTaskContext(expected.context, binding.value)) { reset(); await host.refresh(); return; }
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      const context = binding.value;
      if (context.state !== 'ready') return;
      const save = action === 'save';
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/tasks'
        + (save ? (command!.taskId ? '/' + command!.taskId : '') : '?membership_epoch=' + context.membershipEpoch), {
        method: save ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(save ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(save ? { body: JSON.stringify({ command_id: command!.id, membership_epoch: context.membershipEpoch,
          ...(command!.operation === 'create' ? { title: command!.title }
            : { operation: command!.operation, expected_version: command!.version }) }) } : {}),
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
        const task = value.task;
        const appliedVersion = command!.operation === 'create' ? 1 : command!.version + 1;
        if (!validTask(task, context) || typeof value.replay !== 'boolean' || value.commandId !== command!.id
          || value.appliedVersion !== appliedVersion || task.version < appliedVersion
          || (task.version > appliedVersion && value.replay !== true)
          || (command!.taskId !== null && task.id !== command!.taskId) || task.title !== command!.title
          || (command!.operation === 'create' && task.creatorId !== context.userId)
          || (task.version === appliedVersion && task.state !== (command!.operation === 'complete' ? 'completed' : 'open'))) throw new Error('retry');
        pending = null;
        // Never report a historical completion: render the server's current version/state.
        publish({ ...view, pending: null, status: 'saved',
          draft: command!.operation === 'create' && revision === command!.revision ? '' : view.draft,
          tasks: [task, ...view.tasks.filter(item => item.id !== task.id)].sort(taskOrder).slice(0, 50) });
      } else {
        const tasks = value.tasks;
        if (value.limit !== 50 || !Array.isArray(tasks) || tasks.length > 50
          || tasks.some(item => !validTask(item, context)) || new Set(tasks.map(item => item.id)).size !== tasks.length
          || tasks.some((item, index) => index > 0 && taskOrder(tasks[index - 1], item) >= 0)) throw new Error('retry');
        publish({ ...view, tasks, checked: true, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(action === 'save' ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { activeAction = null; publish({ ...view, busy: false }); } }
  }
  function prepare(operation: Pending['operation'], taskId: string | null = null) {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    const task = view.tasks.find(item => item.id === taskId);
    if (operation !== 'create' && (!task || task.state !== (operation === 'complete' ? 'open' : 'completed'))) return Promise.resolve();
    const title = normalizeTaskTitle(operation === 'create' ? view.draft : task!.title), id = commandId();
    if (!title.ok || !uuid(id)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    pending = Object.freeze({ id, operation, taskId, title: title.text, version: task?.version ?? 0, revision });
    publish({ ...view, pending: { operation, title: title.text } });
    return run('save');
  }
  return { reset, sync, actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) { if (view.available) { revision++; publish({ ...view, draft: draft.slice(0, 800) }); } },
    create: () => prepare('create'), complete: (id: string) => prepare('complete', id), reopen: (id: string) => prepare('reopen', id),
    retry: () => run('save'), list: () => run('list'),
    cancel() {
      revision++;
      // Cancel only the unsent draft/read. An already submitted command may have committed.
      if (activeAction === 'list') { sequence++; activeAction = null; publish({ ...view, busy: false }); }
      publish({ ...view, draft: '' });
    },
  } };
}
