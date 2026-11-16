import type { SyntheticConfig } from './config';
import { validateSyntheticConfig } from './config';
import { readSessionContext } from './context';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { sameDateContext } from './dates-state';
import { readBoundedJson } from '../chat/transport';
import { emptyDailyQuestions, parseDailyPage, parseDailyAck, parseDailyRead, mergeDailyEntries,
  checkDailyPageContinuity, canReadDailyMetadata, type DailyView, type DailyEntry, type DailyToday } from './daily-questions-state';
import { provesDailyCommand } from './daily-questions-proof';
import { exact, record, uuid, normalizeDailyAnswerText } from '../../../../packages/domain/daily-question/validation';
import { rewriteDailyAnswerMetadata, removeDailyAnswerMetadata, type DailyAnswerMetadata } from '../../../../packages/domain/daily-question/metadata';
import type { DailySlot } from '../../../../packages/domain/daily-question/slot';
type Kind = 'create' | 'rewrite' | 'remove';
type Pending = Readonly<{ id: string; kind: Kind; base: DailyAnswerMetadata | null; slot: DailySlot | null;
  expectedDay: string; today: DailyToday; text: string | null; floor: string; knownIds: readonly string[]; revision: number }>;
type ReadTarget = Readonly<{ id: string; version: number; generation: number }>;
let nextGeneration = 0;
export function createDailyQuestionsController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyDailyQuestions, bound: InvitationHostSnapshot | null = null, pending: Pending | null = null;
  let sequence = 0, draftRevision = 0, readerGeneration = 0;
  let activeMode: 'list' | 'mutate' | 'read' | null = null, readAbort: AbortController | null = null, activeAbort: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: DailyView) => {
    view = Object.freeze({ ...next, revision: draftRevision,
      slots: Object.freeze(next.slots.map(entry => Object.freeze({ slot: Object.freeze({ ...entry.slot,
        participantIds: Object.freeze([...entry.slot.participantIds]) as readonly [string, string] }),
        answers: Object.freeze(entry.answers.map(answer => Object.freeze({ ...answer }))) }))),
      today: next.today ? Object.freeze({ ...next.today }) : null,
      reader: next.reader ? Object.freeze({ ...next.reader, answer: Object.freeze({ ...next.reader.answer }),
        slot: Object.freeze({ ...next.reader.slot, participantIds: Object.freeze([...next.reader.slot.participantIds]) as readonly [string, string] }) }) : null });
    for (const listener of listeners) listener();
  };
  function reset() {
    sequence++; draftRevision++; readerGeneration++;
    activeAbort?.abort(); activeAbort = null; readAbort = null; activeMode = null; bound = null; pending = null;
    publish({ ...emptyDailyQuestions, generation: ++nextGeneration });
  }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity && sameDateContext(current.context, bound.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...view, available: true, userId: current.context.userId }); }
  }
  function close() {
    readerGeneration++; readAbort?.abort(); readAbort = null;
    if (activeMode === 'read') { sequence++; activeMode = null; publish({ ...view, reader: null, readerStatus: 'closed', busy: false }); }
    else publish({ ...view, reader: null, readerStatus: 'closed' });
  }
  async function run(mode: 'list' | 'mutate' | 'read', target?: ReadTarget, beforeDay: string | null = null): Promise<void> {
    if (view.busy || !view.available || !bound || (mode === 'mutate' && (!pending || view.requiresRefresh))) return;
    const expected = bound, command = pending, seq = ++sequence;
    activeMode = mode;
    const abort = new AbortController(); activeAbort = abort;
    if (mode === 'read') readAbort = abort;
    const boundMatches = () => { const c = host.capture(); return c !== null && c.generation === expected.generation && c.identity === expected.identity && sameDateContext(c.context, expected.context); };
    const current = () => sequence === seq && boundMatches() && (mode !== 'read' || target?.generation === readerGeneration);
    const obsolete = () => { if (current()) return false; sync(); return true; };
    const send = (input: Request) => request(abort ? new Request(input, { signal: abort.signal }) : input);
    publish({ ...view, busy: true, error: false, ...(mode === 'mutate' ? { status: 'saving' as const }
      : mode === 'list' ? { checked: false, reader: null, readerStatus: 'closed' as const } : { readerStatus: 'loading' as const, reader: null }) });
    try {
      const cookie = await host.getCookie();
      if (obsolete()) return;
      const binding = await readSessionContext(settings, expected.identity.sessionId, cookie, send);
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
      const kind = command?.kind, mutating = mode === 'mutate';
      const suffix = mode === 'read' ? '/answers/' + target!.id + '/text'
        : mutating && command!.base ? '/answers/' + command!.base.id : '';
      const payload = mutating ? { membership_epoch: context.membershipEpoch, command_id: command!.id, confirm: true,
        ...(kind === 'create' ? { expected_day: command!.expectedDay } : { expected_version: command!.base!.version }),
        ...(kind !== 'remove' ? { text: command!.text } : {}) } : null;
      const response = await send(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/daily-questions' + suffix
        + (mutating ? '' : '?membership_epoch=' + context.membershipEpoch + (beforeDay ? '&before_day=' + beforeDay : '')), {
        method: !mutating ? 'GET' : kind === 'create' ? 'POST' : kind === 'rewrite' ? 'PUT' : 'DELETE',
        headers: { Cookie: cookie, Origin: settings.baseURL, ...(mutating ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(mutating ? { body: JSON.stringify(payload) } : {}), credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (obsolete() || !await cookieMatches()) { void response.body?.cancel().catch(() => {}); return; }
      if (response.status === 401) { host.block('auth_required'); reset(); return; }
      if (!/\bno-store\b/i.test(response.headers.get('cache-control') ?? '') || response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') throw Error('private_response_required');
      const body = await readBoundedJson(response, mode === 'list' ? 262144 : 32768);
      if (obsolete() || !await cookieMatches()) return;
      if (record(body) && exact(body, 'ok,error') && body.ok === false) {
        if (response.status === 409 && body.error === 'stale_membership') { host.block('access_required'); reset(); return; }
        if (mode === 'mutate' && response.status === 409
          && ['version_conflict', 'idempotency_conflict', 'day_changed'].some(code => body.error === code)) {
          pending = null; publish({ ...view, pending: false, requiresRefresh: true, checked: false,
            reader: null, readerStatus: 'closed', status: 'conflict', error: true }); return;
        }
        if (mode === 'mutate' && response.status === 400 && body.error === 'invalid_request') {
          pending = null; publish({ ...view, pending: false, checked: false, requiresRefresh: true,
            status: 'invalid', error: true, reader: null, readerStatus: 'closed' }); return;
        }
        if (!mutating && (response.status === 403 || response.status === 404)) {
          publish({ ...view, checked: false, requiresRefresh: true, status: 'unavailable', error: true,
            reader: null, readerStatus: mode === 'read' ? 'error' : 'closed' }); return;
        }
      }
      if (response.status !== 200 || !record(body) || !exact(body, 'ok,value') || body.ok !== true) throw Error('retry');
      if (mode === 'list') {
        const page = parseDailyPage(body.value, context, view.checkedAt, beforeDay);
        if (!page || !checkDailyPageContinuity(view.slots, page, beforeDay, view.today)) throw Error('invalid_page');
        const slots = mergeDailyEntries(view.slots, page.slots, context);
        // Only an explicit newest-page response establishes absence for today's create.
        // Older pages never establish newest-page completeness.
        publish({ ...view, slots, today: page.today, checkedAt: page.checkedAt, checked: beforeDay === null,
          hasMore: page.hasMore, nextBeforeDay: page.nextBeforeDay, requiresRefresh: false,
          reader: null, readerStatus: 'closed', status: pending ? 'retry' : 'idle' });
      } else if (mode === 'read') {
        const detail = parseDailyRead(body.value, context, view.checkedAt, target!.id);
        if (!detail) throw Error('invalid_read');
        const entry = view.slots.find(item => item.slot.id === detail.slot.id);
        if (!entry || !entry.answers.some(answer => answer.id === detail.answer.id)) throw Error('unknown_read');
        const slots = mergeDailyEntries(view.slots, [{ slot: detail.slot, answers: [detail.answer] }], context);
        const merged = slots.find(item => item.slot.id === detail.slot.id)!;
        const show = detail.answer.version === target!.version && typeof detail.text === 'string'
          && canReadDailyMetadata(merged, detail.answer, context.userId, detail.checkedAt);
        publish({ ...view, slots, checked: false, checkedAt: detail.checkedAt,
          reader: show ? { ...detail, text: detail.text!, generation: view.generation } : null,
          readerStatus: show ? 'opened' : 'changed' });
      } else {
        const ack = parseDailyAck(body.value, context, view.checkedAt, command!.id);
        if (!ack || (command!.kind === 'create' && (ack.slot.timezone !== command!.today.timezone
          || ack.slot.catalogVersion !== command!.today.catalogVersion || ack.slot.promptId !== command!.today.promptId))
          || !provesDailyCommand(command!, ack, context)) throw Error('invalid_ack');
        const slots = mergeDailyEntries(view.slots, [{ slot: ack.slot, answers: [ack.answer] }], context);
        pending = null;
        publish({ ...view, slots, checked: false, checkedAt: ack.checkedAt, pending: false,
          status: 'saved', reader: null, readerStatus: 'closed' });
      }
    } catch {
      if (current()) publish({ ...view, error: true, checked: false,
        ...(mode === 'mutate' ? { status: 'retry' as const } : {}),
        reader: null, readerStatus: mode === 'read' ? 'error' : 'closed' });
      else sync();
    } finally {
      if (sequence === seq) { activeMode = null; readAbort = null; activeAbort = null; if (boundMatches()) publish({ ...view, busy: false }); else sync(); }
    }
  }
  function prepare(kind: Kind, target: string | null, confirmed: boolean): Promise<void> {
    if (!view.available || view.busy || pending || view.requiresRefresh || confirmed !== true
      || !bound || bound.context.state !== 'ready' || !view.checkedAt) return Promise.resolve();
    const context = bound.context;
    let entry: DailyEntry | undefined, base: DailyAnswerMetadata | null = null;
    const text = kind === 'remove' ? null : normalizeDailyAnswerText(view.draft);
    if (kind !== 'remove' && text === null) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    if (kind === 'create') {
      if (!view.checked || !view.today) { publish({ ...view, status: 'conflict', requiresRefresh: true }); return Promise.resolve(); }
      entry = view.slots.find(item => item.slot.day === view.today!.day);
      if (entry?.answers.some(answer => answer.authorId === context.userId)) return Promise.resolve();
    } else {
      entry = view.slots.find(item => item.answers.some(answer => answer.id === target));
      base = entry?.answers.find(answer => answer.id === target) ?? null;
      if (!entry || !base) return Promise.resolve();
      if (kind === 'rewrite' && (view.readerStatus !== 'opened' || !view.reader
        || view.reader.generation !== view.generation || view.reader.answer.id !== base.id
        || view.reader.answer.version !== base.version)) return Promise.resolve();
      const changed = kind === 'rewrite' ? rewriteDailyAnswerMetadata(base, entry.slot, context, view.checkedAt, base.version, true)
        : removeDailyAnswerMetadata(base, entry.slot, context, view.checkedAt, base.version, true);
      if (!changed) { publish({ ...view, status: 'conflict' }); return Promise.resolve(); }
    }
    const id = commandId();
    if (!uuid(id)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    // Removal immediately closes an already-read partner answer. All command outcomes
    // keep readers closed; an uncertain deletion never restores previously cached text.
    close();
    if (kind !== 'remove') draftRevision++;
    pending = Object.freeze({ id, kind, base, slot: entry?.slot ?? null,
      expectedDay: entry?.slot.day ?? view.today!.day, today: view.today!, text, floor: view.checkedAt,
      knownIds: Object.freeze(view.slots.flatMap(item => item.answers.map(answer => answer.id))), revision: draftRevision });
    publish({ ...view, pending: true, ...(kind !== 'remove' ? { draft: '' } : {}) });
    return run('mutate');
  }
  function read(id: string) {
    if (!view.available || pending || view.requiresRefresh || (activeMode !== null && activeMode !== 'read')) return Promise.resolve();
    const entry = view.slots.find(item => item.answers.some(answer => answer.id === id));
    const answer = entry?.answers.find(value => value.id === id);
    if (!entry || !answer || !view.userId || !view.checkedAt || !canReadDailyMetadata(entry, answer, view.userId, view.checkedAt)) return Promise.resolve();
    close(); return run('read', { id, version: answer.version, generation: readerGeneration });
  }
  return { reset, sync, actions: {
    getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => run('list'), loadMore: () => view.hasMore && view.nextBeforeDay && !pending && !view.requiresRefresh
      ? run('list', undefined, view.nextBeforeDay) : Promise.resolve(),
    retry: () => run('mutate'), create: (confirm: boolean) => prepare('create', null, confirm),
    rewrite: (id: string, confirm: boolean) => prepare('rewrite', id, confirm),
    remove: (id: string, confirm: boolean) => prepare('remove', id, confirm), read, close,
    leaveScreen() {
      const uncertain = pending !== null;
      reset(); sync();
      if (view.available) publish({ ...view, requiresRefresh: true, status: uncertain ? 'conflict' : 'idle' });
    },
    setDraft(text: string) { if (view.available) { draftRevision++; publish({ ...view, draft: text.slice(0, 8000) }); } },
    cancelDraft() { draftRevision++; publish({ ...view, draft: '' }); },
  } };
}
export type DailyQuestionsActions = ReturnType<typeof createDailyQuestionsController>['actions'];
export type { DailyView } from './daily-questions-state';
