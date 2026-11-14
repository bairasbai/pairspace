import type { SyntheticConfig } from './config';
import { validateSyntheticConfig } from './config';
import { readSessionContext } from './context';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { sameDateContext } from './dates-state';
import { readBoundedJson } from '../chat/transport';
import { canAdvanceDoing, emptyDoings, exact, followsDoing, freshDoingDraft, instant, integer, kind as validKind,
  mayChooseDoing, mergeDoing, normalizeDoingTitle, orderDoings, record, uuid, validDoing,
  type DoingKind, type DoingsView, type SharedDoing } from './shared-doings-state';

type Kind = 'propose' | 'join' | 'decline' | 'advance' | 'remove';
type Pending = Readonly<{ id: string; kind: Kind; before: SharedDoing | null; revision: number;
  title: string | null; doingKind: DoingKind | null; parts: number | null; part: number | null }>;
/** A canonical retry must follow the requested operation's result, not just its input. */
function applied(command: Pending, canonical: SharedDoing, actor: string): SharedDoing {
  const before = command.before, source = before ?? canonical;
  const identity = { id: source.id, coupleId: source.coupleId, authorId: source.authorId, recipientId: source.recipientId,
    membershipEpoch: source.membershipEpoch, sequence: source.sequence, createdAt: source.createdAt };
  if (command.kind === 'propose') return { ...identity, version: 1, contentState: 'active', decisionState: 'invited',
    title: command.title!, kind: command.doingKind!, parts: command.parts!, authorAt: 0 };
  if (!before || before.contentState !== 'active') throw Error('invalid_shared_doing_command');
  if (command.kind === 'remove') return { ...identity, version: before.version + 1, contentState: 'removed',
    decisionState: before.decisionState === 'invited' ? 'withdrawn' : before.decisionState };
  const base = { ...identity, version: before.version + 1, contentState: 'active' as const,
    title: before.title, kind: before.kind, parts: before.parts, authorAt: before.authorAt };
  if (command.kind === 'join') return { ...base, decisionState: 'joined', recipientAt: 0 };
  if (command.kind === 'decline') return { ...base, decisionState: 'declined' };
  if (before.decisionState === 'joined') return { ...base, decisionState: 'joined',
    authorAt: actor === before.authorId ? command.part! : before.authorAt,
    recipientAt: actor === before.recipientId ? command.part! : before.recipientAt };
  return { ...base, decisionState: 'invited', authorAt: command.part! };
}
let nextGeneration = 0;
export function createSharedDoingsController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyDoings, bound: InvitationHostSnapshot | null = null, pending: Pending | null = null;
  let sequence = 0, draftRevision = 0;
  const listeners = new Set<() => void>();
  const publish = (next: DoingsView) => { view = Object.freeze(next); for (const listener of listeners) listener(); };
  function reset() {
    sequence++; draftRevision++; bound = null; pending = null;
    publish({ ...emptyDoings, draft: freshDoingDraft(), generation: ++nextGeneration });
  }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity && sameDateContext(current.context, bound.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...view, available: true, userId: current.context.userId }); }
  }
  async function run(mutating: boolean) {
    if (view.busy || !view.available || !bound || (mutating && (!pending || view.requiresRefresh))) return;
    const expected = bound, command = pending, seq = ++sequence;
    const boundMatches = () => { const c = host.capture(); return c !== null && c.generation === expected.generation && c.identity === expected.identity && sameDateContext(c.context, expected.context); };
    const current = () => sequence === seq && boundMatches();
    const obsolete = () => { if (current()) return false; sync(); return true; };
    publish({ ...view, busy: true, error: false, ...(mutating ? { status: 'saving' as const } : { checked: false }) });
    try {
      const cookie = await host.getCookie();
      if (obsolete()) return;
      const binding = await readSessionContext(settings, expected.identity.sessionId, cookie, request);
      if (obsolete()) return;
      if (!binding.ok) {
        if (binding.error !== 'transport_error') { host.block('auth_required'); reset(); return; }
        throw Error('retry');
      }
      if (!sameDateContext(expected.context, binding.value)) { reset(); await host.refresh(); return; }
      const cookieMatches = async () => {
        const matches = await host.getCookie() === cookie;
        if (current() && !matches) { host.block('auth_required'); reset(); }
        return matches && current();
      };
      if (!await cookieMatches()) return;
      const context = binding.value;
      if (context.state !== 'ready') return;
      const operation = command?.kind;
      const suffix = !mutating || !command!.before ? '' : '/' + command!.before.id + (operation === 'remove' ? '' : '/' + operation);
      const payload = mutating ? { membership_epoch: context.membershipEpoch, command_id: command!.id, confirm: true,
        ...(operation === 'propose' ? { title: command!.title, kind: command!.doingKind, parts: command!.parts }
          : { expected_version: command!.before!.version, ...(operation === 'advance' ? { part: command!.part } : {}) }) } : null;
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/shared-doings' + suffix
        + (mutating ? '' : '?membership_epoch=' + context.membershipEpoch), {
        method: !mutating ? 'GET' : operation === 'remove' ? 'DELETE' : 'POST',
        headers: { Cookie: cookie, Origin: settings.baseURL, ...(mutating ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(mutating ? { body: JSON.stringify(payload) } : {}), credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (obsolete() || !await cookieMatches()) { void response.body?.cancel().catch(() => {}); return; }
      if ([401, 403].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (response.status === 404) { publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true }); return; }
      const body = await readBoundedJson(response, mutating ? 16384 : 262144);
      if (obsolete() || !await cookieMatches()) return;
      if (record(body) && exact(body, 'ok,error') && body.ok === false) {
        if (response.status === 409 && body.error === 'stale_membership') { host.block('access_required'); reset(); return; }
        if (mutating && response.status === 409 && ['version_conflict', 'idempotency_conflict', 'capacity_reached'].includes(String(body.error))) {
          pending = null; publish({ ...view, pending: false, requiresRefresh: true, checked: false,
            status: body.error === 'capacity_reached' ? 'limit' : 'conflict', error: true }); return;
        }
        if (mutating && response.status === 400 && body.error === 'invalid_request') {
          pending = null; publish({ ...view, pending: false, status: 'invalid', error: true }); return;
        }
      }
      if (response.status !== 200 || !record(body) || !exact(body, 'ok,value') || body.ok !== true || !record(body.value)) throw Error('retry');
      const value = body.value;
      if (!mutating) {
        if (!exact(value, 'doings,checkedAt,capacity,used') || !instant(value.checkedAt) || (view.checkedAt !== null && value.checkedAt < view.checkedAt)
          || value.capacity !== 100 || !Array.isArray(value.doings) || value.doings.length > 100 || value.used !== value.doings.length || Number(value.used) < view.used) throw Error('retry');
        const doings: SharedDoing[] = [];
        for (const d of value.doings) {
          if (!validDoing(d, context) || d.createdAt > value.checkedAt || d.sequence > Number(value.used)
            || doings.some(old => old.id === d.id || old.sequence === d.sequence)
            || (doings.length > 0 && orderDoings(doings[doings.length - 1], d) > 0)) throw Error('retry');
          doings.push(Object.freeze(d));
        }
        if (view.doings.some(old => { const next = doings.find(d => d.id === old.id); return !next || !followsDoing(old, next); })) throw Error('retry');
        publish({ ...view, doings, used: Number(value.used), checked: true, checkedAt: value.checkedAt,
          requiresRefresh: false, status: pending ? 'retry' : 'idle' });
      } else {
        const d = value.doing, before = command!.before;
        if (!exact(value, 'doing,commandId,replay') || !validDoing(d, context) || value.commandId !== command!.id || typeof value.replay !== 'boolean'
          || (before && (d.id !== before.id || d.version < before.version + 1 || !followsDoing(before, d)))
          || (operation === 'propose' || operation === 'remove' ? d.authorId : operation === 'advance' ? context.userId : d.recipientId) !== context.userId) throw Error('retry');
        if (operation === 'propose' && d.contentState === 'active'
          && (d.title !== command!.title || d.kind !== command!.doingKind || d.parts !== command!.parts)) throw Error('retry');
        const expectedResult = applied(command!, d, context.userId);
        if (!validDoing(expectedResult, context) || !followsDoing(expectedResult, d)
          || (!value.replay && d.version !== expectedResult.version)) throw Error('retry');
        const merged = mergeDoing(view, Object.freeze(d)); pending = null;
        publish({ ...view, ...merged, pending: false, checked: false, status: 'saved',
          ...(operation === 'propose' && draftRevision === command!.revision ? { draft: freshDoingDraft() } : {}) });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(mutating ? { status: 'retry' as const } : {}) }); else sync(); }
    finally { if (sequence === seq) { if (boundMatches()) publish({ ...view, busy: false }); else sync(); } }
  }
  function prepare(operation: Kind, id: string | null, confirm: boolean, part: number | null = null) {
    if (!view.available || view.busy || pending || view.requiresRefresh || !confirm) return Promise.resolve();
    const doing = view.doings.find(d => d.id === id);
    let title: string | null = null, parts: number | null = null, doingKind: DoingKind | null = null;
    if (operation === 'propose') {
      if (!view.checked) { publish({ ...view, status: 'conflict', requiresRefresh: true, error: true }); return Promise.resolve(); }
      if (view.used >= 100) { publish({ ...view, status: 'limit' }); return Promise.resolve(); }
      title = normalizeDoingTitle(view.draft.title); parts = Number(view.draft.parts); doingKind = view.draft.kind;
      if (title === null || !validKind(doingKind) || !/^[1-9][0-9]{0,3}$/.test(view.draft.parts) || !integer(parts, 1, 1000)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    } else {
      if (!doing || (operation === 'advance' ? !canAdvanceDoing(doing, view.userId!) : !mayChooseDoing(doing, view.userId, operation))) return Promise.resolve();
      if (operation === 'advance' && doing.contentState === 'active') {
        const at = doing.authorId === view.userId ? doing.authorAt : doing.decisionState === 'joined' ? doing.recipientAt : 0;
        if (!integer(part, at + 1, doing.parts)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
      }
    }
    const generated = commandId();
    if (!uuid(generated)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    pending = Object.freeze({ id: generated.toLowerCase(), kind: operation, before: doing ?? null, title, doingKind, parts, part, revision: draftRevision });
    publish({ ...view, pending: true }); return run(true);
  }
  function draft(change: Partial<DoingsView['draft']>) { if (view.available) { draftRevision++; publish({ ...view, draft: Object.freeze({ ...view.draft, ...change }) }); } }
  return { reset, sync, actions: {
    getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: () => run(false), retry: () => run(true), propose: (confirm: boolean) => prepare('propose', null, confirm),
    join: (id: string, confirm: boolean) => prepare('join', id, confirm), decline: (id: string, confirm: boolean) => prepare('decline', id, confirm),
    remove: (id: string, confirm: boolean) => prepare('remove', id, confirm), advance: (id: string, part: number, confirm: boolean) => prepare('advance', id, confirm, part),
    setTitle: (title: string) => draft({ title: title.slice(0, 800) }), setKind: (kind: DoingKind) => draft({ kind }),
    setParts: (parts: string) => draft({ parts: parts.slice(0, 4) }),
    cancelDraft() { draftRevision++; publish({ ...view, draft: freshDoingDraft() }); },
  } };
}
export type SharedDoingsActions = ReturnType<typeof createSharedDoingsController>['actions'];
