import type { SyntheticConfig } from './config';
import { validateSyntheticConfig } from './config';
import { readSessionContext } from './context';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { sameDateContext } from './dates-state';
import { readBoundedJson } from '../chat/transport';
import { canReadQuestion, emptyHard, exact, followsQuestion, instant, mergeQuestion, normalizeHardText, orderQuestions, record, uuid,
  validQuestion, type HardView } from './hard-questions-state';

type Kind = 'seal' | 'open' | 'decline' | 'remove';
type Pending = Readonly<{ id: string; kind: Kind; target: string | null; version: number; text: string | null; revision: number; readerGeneration: number | null }>;
type ReadTarget = Readonly<{ id: string; version: number; generation: number }>;
let nextGeneration = 0;
export function createHardQuestionsController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyHard, bound: InvitationHostSnapshot | null = null, pending: Pending | null = null;
  let sequence = 0, draftRevision = 0, readerGeneration = 0;
  let activeMode: 'list' | 'mutate' | 'read' | null = null, readAbort: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: HardView) => { view = Object.freeze(next); for (const listener of listeners) listener(); };
  function reset() {
    sequence++; draftRevision++; readerGeneration++;
    readAbort?.abort(); readAbort = null; activeMode = null; bound = null; pending = null;
    publish({ ...emptyHard, generation: ++nextGeneration });
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
  async function run(mode: 'list' | 'mutate' | 'read', target?: ReadTarget) {
    if (view.busy || !view.available || !bound || (mode === 'mutate' && (!pending || view.requiresRefresh))) return;
    const expected = bound, command = pending, seq = ++sequence;
    activeMode = mode;
    const abort = mode === 'read' ? new AbortController() : null;
    if (abort) readAbort = abort;
    const boundMatches = () => { const c = host.capture(); return c !== null && c.generation === expected.generation && c.identity === expected.identity && sameDateContext(c.context, expected.context); };
    const current = () => sequence === seq && boundMatches() && (mode !== 'read' || target?.generation === readerGeneration);
    const obsolete = () => { if (current()) return false; sync(); return true; };
    const send = (input: Request) => request(abort ? new Request(input, { signal: abort.signal }) : input);
    const openingDesired = () => mode === 'mutate' && command?.kind === 'open' && command.readerGeneration === readerGeneration;
    publish({ ...view, busy: true, error: false, ...(mode === 'mutate' ? { status: 'saving' as const,
      ...(openingDesired() ? { readerStatus: 'loading' as const, reader: null } : {}) }
      : mode === 'list' ? { checked: false } : { readerStatus: 'loading' as const, reader: null }) });
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
      const suffix = mode === 'read' ? '/' + target!.id + '/text' : !mutating || !command!.target ? ''
        : '/' + command!.target + (kind === 'remove' ? '' : '/' + kind);
      const payload = mutating ? { membership_epoch: context.membershipEpoch, command_id: command!.id,
        ...(kind === 'seal' ? { text: command!.text } : { expected_version: command!.version, confirm: true }) } : null;
      const response = await send(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/hard-questions' + suffix
        + (mutating ? '' : '?membership_epoch=' + context.membershipEpoch), {
        method: !mutating ? 'GET' : kind === 'remove' ? 'DELETE' : 'POST',
        headers: { Cookie: cookie, Origin: settings.baseURL, ...(mutating ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(mutating ? { body: JSON.stringify(payload) } : {}), credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (obsolete() || !await cookieMatches()) { void response.body?.cancel().catch(() => {}); return; }
      if ([401, 403].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (response.status === 404) { publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true,
        ...(mode === 'read' || openingDesired() ? { reader: null, readerStatus: 'error' as const } : {}) }); return; }
      const body = await readBoundedJson(response, mode === 'list' ? 262144 : mode === 'read' || kind === 'open' ? 32768 : 16384);
      if (obsolete() || !await cookieMatches()) return;
      if (record(body) && exact(body, 'ok,error') && body.ok === false) {
        if (response.status === 409 && body.error === 'stale_membership') { host.block('access_required'); reset(); return; }
        if (mode === 'mutate' && response.status === 409 && ['version_conflict', 'idempotency_conflict', 'capacity_reached'].includes(String(body.error))) {
          pending = null; publish({ ...view, pending: false, requiresRefresh: true, checked: false, reader: null, readerStatus: 'closed',
            status: body.error === 'capacity_reached' ? 'limit' : 'conflict', error: true }); return;
        }
        if (mode === 'mutate' && response.status === 400 && body.error === 'invalid_request') {
          pending = null; publish({ ...view, pending: false, status: 'invalid', error: true,
            ...(openingDesired() ? { reader: null, readerStatus: 'error' as const } : {}) }); return;
        }
      }
      if (response.status !== 200 || !record(body) || !exact(body, 'ok,value') || body.ok !== true || !record(body.value)) throw Error('retry');
      const value = body.value;
      const validClock = (clock: unknown, q: { createdAt: string; openedAt?: string }) => instant(clock)
        && (view.checkedAt === null || clock >= view.checkedAt) && q.createdAt <= clock && (!q.openedAt || q.openedAt <= clock);
      if (mode === 'list') {
        if (!exact(value, 'questions,checkedAt,capacity,used') || !instant(value.checkedAt) || (view.checkedAt !== null && value.checkedAt < view.checkedAt)
          || value.capacity !== 100 || !Array.isArray(value.questions) || value.questions.length > 100 || value.used !== value.questions.length || Number(value.used) < view.used) throw Error('retry');
        const questions: HardView['questions'][number][] = [];
        for (const q of value.questions) {
          if (!validQuestion(q, context) || !validClock(value.checkedAt, q) || q.sequence > Number(value.used)
            || questions.some(old => old.id === q.id || old.sequence === q.sequence)
            || (questions.length > 0 && orderQuestions(questions[questions.length - 1], q) > 0)) throw Error('retry');
          questions.push(q);
        }
        if (view.questions.some(old => { const next = questions.find(q => q.id === old.id); return !next || !followsQuestion(old, next); })) throw Error('retry');
        const reader = view.reader && questions.some(q => q.id === view.reader!.question.id && q.version === view.reader!.question.version && canReadQuestion(q, context.userId)) ? view.reader : null;
        publish({ ...view, questions, used: Number(value.used), checked: true, checkedAt: value.checkedAt,
          requiresRefresh: false, reader, readerStatus: reader ? 'opened' : 'closed', status: pending ? 'retry' : 'idle' });
      } else if (mode === 'read') {
        const q = value.question;
        if (!validQuestion(q, context) || q.id !== target!.id) throw Error('retry');
        const allowed = canReadQuestion(q, context.userId);
        if (!exact(value, 'question,checkedAt' + (allowed ? ',text' : '')) || !validClock(value.checkedAt, q)
          || (allowed && (typeof value.text !== 'string' || normalizeHardText(value.text) !== value.text))) throw Error('retry');
        const latest = view.questions.find(old => old.id === q.id);
        if (!latest || !followsQuestion(latest, q)) throw Error('retry');
        const merged = mergeQuestion(view, q), show = q.version === target!.version && allowed;
        publish({ ...view, ...merged, checked: false, reader: show ? { question: q, text: value.text as string, checkedAt: value.checkedAt as string } : null,
          readerStatus: show ? 'opened' : 'changed' });
      } else {
        const q = value.question;
        if (!validQuestion(q, context) || value.commandId !== command!.id || typeof value.replay !== 'boolean'
          || (command!.target !== null && q.id !== command!.target) || q.version < Math.max(1, command!.version)
          || (kind === 'seal' || kind === 'remove' ? q.authorId : q.recipientId) !== context.userId) throw Error('retry');
        const textAllowed = kind === 'open' && q.contentState === 'active';
        if (!exact(value, 'question,commandId,replay' + (kind === 'open' ? ',checkedAt' + (textAllowed ? ',text' : '') : ''))
          || (kind === 'open' && (q.decisionState !== 'opened' || !validClock(value.checkedAt, q)
            || (textAllowed && (typeof value.text !== 'string' || normalizeHardText(value.text) !== value.text))))
          || (kind === 'decline' && q.decisionState !== 'declined') || (kind === 'remove' && q.contentState !== 'removed')) throw Error('retry');
        if (!value.replay && (q.version !== (kind === 'seal' ? 1 : command!.version + 1)
          || (kind === 'seal' && (q.contentState !== 'active' || q.decisionState !== 'sealed'))
          || (kind === 'open' && q.contentState !== 'active'))) throw Error('retry');
        // Always merge against latest known metadata BEFORE using any OpenACK text.
        const merged = mergeQuestion(view, q), desired = openingDesired();
        pending = null;
        const reader = desired ? (textAllowed ? { question: q, text: value.text as string, checkedAt: value.checkedAt as string } : null) : merged.reader;
        publish({ ...view, ...merged, pending: false, checked: false, status: 'saved', reader,
          readerStatus: reader ? 'opened' : desired ? 'changed' : 'closed',
          ...(kind === 'seal' && draftRevision === command!.revision ? { draft: '' } : {}) });
      }
    } catch {
      if (current()) publish({ ...view, error: true, ...(mode === 'mutate' ? { status: 'retry' as const,
        ...(openingDesired() ? { reader: null, readerStatus: 'error' as const } : {}) }
        : { reader: null, readerStatus: mode === 'read' ? 'error' as const : 'closed' as const }) });
      else sync();
    } finally {
      if (sequence === seq) { activeMode = null; readAbort = null; if (boundMatches()) publish({ ...view, busy: false }); else sync(); }
    }
  }
  function prepare(kind: Kind, target: string | null = null, confirmed = false) {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    const q = view.questions.find(q => q.id === target);
    if (kind === 'seal') {
      if (!view.checked) { publish({ ...view, status: 'conflict', requiresRefresh: true, error: true }); return Promise.resolve(); }
      if (view.used >= 100) { publish({ ...view, status: 'limit' }); return Promise.resolve(); }
    } else {
      if (!q || !confirmed || q.contentState !== 'active') return Promise.resolve();
      if (kind === 'remove' ? q.authorId !== view.userId : q.recipientId !== view.userId || q.decisionState !== 'sealed') return Promise.resolve();
    }
    const text = kind === 'seal' ? normalizeHardText(view.draft) : null, generated = commandId();
    if (!uuid(generated) || (kind === 'seal' && text === null)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    if (kind === 'open' || (kind === 'remove' && view.reader?.question.id === target)) close();
    pending = Object.freeze({ id: generated.toLowerCase(), kind, target, version: q?.version ?? 0, text,
      revision: draftRevision, readerGeneration: kind === 'open' ? readerGeneration : null });
    publish({ ...view, pending: true }); return run('mutate');
  }
  function read(id: string) {
    if (!view.available || pending || view.requiresRefresh || (activeMode !== null && activeMode !== 'read')) return Promise.resolve();
    const q = view.questions.find(q => q.id === id);
    if (!q || !canReadQuestion(q, view.userId!)) return Promise.resolve();
    close(); return run('read', { id, version: q.version, generation: readerGeneration });
  }
  return { reset, sync, actions: {
    getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: () => run('list'), retry: () => run('mutate'), seal: () => prepare('seal'),
    open: (id: string, confirm: boolean) => prepare('open', id, confirm), decline: (id: string, confirm: boolean) => prepare('decline', id, confirm),
    remove: (id: string, confirm: boolean) => prepare('remove', id, confirm), read, close,
    setDraft(text: string) { if (view.available) { draftRevision++; publish({ ...view, draft: text.slice(0, 8000) }); } },
    cancelDraft() { draftRevision++; publish({ ...view, draft: '' }); },
  } };
}
export type HardQuestionsActions = ReturnType<typeof createHardQuestionsController>['actions'];
