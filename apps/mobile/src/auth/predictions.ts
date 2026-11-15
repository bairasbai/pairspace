import type { SyntheticConfig } from './config';
import { validateSyntheticConfig } from './config';
import { readSessionContext } from './context';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { sameDateContext } from './dates-state';
import { readBoundedJson } from '../chat/transport';
import { acknowledgePrediction, canReadPrediction, declinePrediction, emptyPredictions, emptyPredictionSchedule, exact, followsPrediction,
  instant, mergePrediction, normalizePredictionBody, parsePredictionSchedule, predictionOrder, record, removePrediction, uuid,
  validPrediction, type Prediction, type PredictionScheduleInput, type PredictionView } from './predictions-state';

type Kind = 'create' | 'open' | 'decline' | 'remove';
type Pending = Readonly<{ id: string; kind: Kind; base: Prediction | null; text: string | null;
  schedule: PredictionScheduleInput | null; floor: string | null; knownIds: readonly string[]; revision: number; readerGeneration: number | null }>;
type ReadTarget = Readonly<{ id: string; version: number; generation: number }>;
let nextGeneration = 0;
export function createPredictionsController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyPredictions, bound: InvitationHostSnapshot | null = null, pending: Pending | null = null;
  let sequence = 0, draftRevision = 0, readerGeneration = 0;
  let activeMode: 'list' | 'mutate' | 'read' | null = null, readAbort: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: PredictionView) => {
    view = Object.freeze({ ...next, schedule: Object.freeze({ ...next.schedule }),
      predictions: Object.freeze(next.predictions.map(q => Object.freeze({ ...q }))),
      reader: next.reader ? Object.freeze({ ...next.reader, prediction: Object.freeze({ ...next.reader.prediction }) }) : null });
    for (const listener of listeners) listener();
  };
  function reset() {
    sequence++; draftRevision++; readerGeneration++;
    readAbort?.abort(); readAbort = null; activeMode = null; bound = null; pending = null;
    publish({ ...emptyPredictions, generation: ++nextGeneration });
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
  async function run(mode: 'list' | 'mutate' | 'read', target?: ReadTarget): Promise<void> {
    if (view.busy || !view.available || !bound || (mode === 'mutate' && (!pending || view.requiresRefresh))) return;
    const expected = bound, command = pending, seq = ++sequence;
    let followRead: ReadTarget | null = null;
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
      const suffix = mode === 'read' ? '/' + target!.id + '/text' : !mutating || !command!.base ? ''
        : '/' + command!.base.id + (kind === 'remove' ? '' : '/' + kind);
      const payload = mutating ? { membership_epoch: context.membershipEpoch, command_id: command!.id, confirm: true,
        ...(kind === 'create' ? { text: command!.text, schedule: command!.schedule } : { expected_version: command!.base!.version }) } : null;
      const response = await send(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/predictions' + suffix
        + (mutating ? '' : '?membership_epoch=' + context.membershipEpoch), {
        method: !mutating ? 'GET' : kind === 'remove' ? 'DELETE' : 'POST',
        headers: { Cookie: cookie, Origin: settings.baseURL, ...(mutating ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(mutating ? { body: JSON.stringify(payload) } : {}), credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (obsolete() || !await cookieMatches()) { void response.body?.cancel().catch(() => {}); return; }
      if ([401, 403].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (!/\bno-store\b/i.test(response.headers.get('cache-control') ?? '') || response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') throw Error('private_response_required');
      if (response.status === 404) { publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true,
        ...(mode === 'read' || openingDesired() ? { reader: null, readerStatus: 'error' as const } : {}) }); return; }
      const body = await readBoundedJson(response, mode === 'list' ? 262144 : mode === 'read' ? 32768 : 16384);
      if (obsolete() || !await cookieMatches()) return;
      if (record(body) && exact(body, 'ok,error') && body.ok === false) {
        if (response.status === 409 && body.error === 'stale_membership') { host.block('access_required'); reset(); return; }
        if (mode === 'mutate' && response.status === 409 && ['version_conflict', 'idempotency_conflict', 'capacity_reached', 'not_due'].includes(String(body.error))) {
          pending = null; publish({ ...view, pending: false, requiresRefresh: true, checked: false, reader: null, readerStatus: 'closed',
            status: body.error === 'capacity_reached' ? 'limit' : body.error === 'not_due' ? 'not_due' : 'conflict', error: true }); return;
        }
        if (mode === 'mutate' && response.status === 400 && body.error === 'invalid_request') {
          pending = null; publish({ ...view, pending: false, status: 'invalid', error: true,
            ...(openingDesired() ? { reader: null, readerStatus: 'error' as const } : {}) }); return;
        }
      }
      if (response.status !== 200 || !record(body) || !exact(body, 'ok,value') || body.ok !== true || !record(body.value)) throw Error('retry');
      const value = body.value;
      const validClock = (clock: unknown, q: Prediction) => instant(clock) && (view.checkedAt === null || clock >= view.checkedAt)
        && q.createdAt <= clock && (q.openedAt === null || q.openedAt <= clock) && (q.declinedAt === null || q.declinedAt <= clock);
      if (mode === 'list') {
        if (!exact(value, 'predictions,checkedAt,capacity,used') || !instant(value.checkedAt) || (view.checkedAt !== null && value.checkedAt < view.checkedAt)
          || value.capacity !== 100 || !Array.isArray(value.predictions) || value.predictions.length > 100 || value.used !== value.predictions.length || Number(value.used) < view.used) throw Error('retry');
        const predictions: Prediction[] = [];
        for (const q of value.predictions) {
          if (!validPrediction(q, context) || !validClock(value.checkedAt, q) || predictions.some(old => old.id === q.id)) throw Error('retry');
          predictions.push(q);
        }
        if (view.predictions.some(old => { const next = predictions.find(q => q.id === old.id); return !next || !followsPrediction(old, next, context); })) throw Error('retry');
        const reader = view.reader && predictions.some(q => q.id === view.reader!.prediction.id && q.version === view.reader!.prediction.version
          && canReadPrediction(q, context.userId, value.checkedAt as string)) ? view.reader : null;
        publish({ ...view, predictions: predictions.sort(predictionOrder), used: Number(value.used), checked: true, checkedAt: value.checkedAt,
          requiresRefresh: false, reader, readerStatus: reader ? 'opened' : 'closed', status: pending ? 'retry' : 'idle' });
      } else if (mode === 'read') {
        const q = value.prediction;
        if (!validPrediction(q, context) || q.id !== target!.id || !validClock(value.checkedAt, q)) throw Error('retry');
        const allowed = canReadPrediction(q, context.userId, value.checkedAt as string);
        if (!exact(value, 'prediction,checkedAt' + (allowed ? ',text' : ''))
          || (allowed && (typeof value.text !== 'string' || normalizePredictionBody(value.text) !== value.text))) throw Error('retry');
        const latest = view.predictions.find(old => old.id === q.id);
        if (!latest || !followsPrediction(latest, q, context)) throw Error('retry');
        const merged = mergePrediction(view, q, value.checkedAt as string), show = q.version === target!.version && allowed;
        publish({ ...view, ...merged, checked: false, checkedAt: value.checkedAt as string,
          reader: show ? { prediction: q, text: value.text as string, checkedAt: value.checkedAt as string } : null,
          readerStatus: show ? 'opened' : 'changed' });
      } else {
        const q = value.prediction;
        if (!exact(value, 'prediction,commandId,replay,checkedAt') || !validPrediction(q, context) || !validClock(value.checkedAt, q)
          || value.commandId !== command!.id || typeof value.replay !== 'boolean') throw Error('retry');
        let applied: Prediction | null;
        if (kind === 'create') {
          const schedule = parsePredictionSchedule(command!.schedule, q.createdAt);
          applied = { ...q, contentState: 'active', openedAt: null, declinedAt: null, version: 1 };
          if (q.authorId !== context.userId || command!.knownIds.includes(q.id) || (command!.floor !== null && q.createdAt < command!.floor) || !schedule || !Object.entries(schedule).every(([key, v]) => q[key as keyof Prediction] === v)) throw Error('retry');
        } else {
          const base = command!.base!;
          applied = kind === 'open' ? (q.openedAt === null ? null : acknowledgePrediction(base, context, q.openedAt, base.version, true))
            : kind === 'decline' ? (q.declinedAt === null ? null : declinePrediction(base, context, q.declinedAt, base.version, true))
              : removePrediction(base, context, base.version, true);
        }
        if (!applied || (command!.floor !== null && ((kind === 'open' && q.openedAt! < command!.floor) || (kind === 'decline' && q.declinedAt! < command!.floor)))
          || !followsPrediction(applied, q, context) || (!value.replay && !followsPrediction(q, applied, context))) throw Error('retry');
        const merged = mergePrediction(view, q, value.checkedAt as string), desired = openingDesired();
        pending = null;
        if (desired && canReadPrediction(q, context.userId, value.checkedAt as string)) followRead = { id: q.id, version: q.version, generation: readerGeneration };
        publish({ ...view, ...merged, pending: false, checked: false, checkedAt: value.checkedAt as string, status: 'saved',
          reader: desired ? null : merged.reader, readerStatus: desired ? (followRead ? 'loading' : 'changed') : merged.reader ? 'opened' : 'closed',
          ...(kind === 'create' && draftRevision === command!.revision ? { draft: '', schedule: emptyPredictionSchedule } : {}) });
      }
    } catch {
      if (current()) publish({ ...view, error: true, ...(mode === 'mutate' ? { status: 'retry' as const,
        ...(openingDesired() ? { reader: null, readerStatus: 'error' as const } : {}) }
        : { reader: null, readerStatus: mode === 'read' ? 'error' as const : 'closed' as const }) });
      else sync();
    } finally {
      if (sequence === seq) { activeMode = null; readAbort = null; if (boundMatches()) publish({ ...view, busy: false }); else sync(); }
    }
    // Opening consent never carries a body. Fetch separately only for the still-current explicit reader intent.
    if (followRead && sequence === seq && boundMatches() && followRead.generation === readerGeneration && !pending) await run('read', followRead);
  }
  function prepare(kind: Kind, target: string | null = null, confirmed = false): Promise<void> {
    if (!view.available || view.busy || pending || view.requiresRefresh || confirmed !== true) return Promise.resolve();
    const q = view.predictions.find(q => q.id === target);
    let schedule: PredictionScheduleInput | null = null;
    if (kind === 'create') {
      if (!view.checked || !view.checkedAt) { publish({ ...view, status: 'conflict', requiresRefresh: true, error: true }); return Promise.resolve(); }
      if (view.used >= 100) { publish({ ...view, status: 'limit' }); return Promise.resolve(); }
      const parsed = parsePredictionSchedule(view.schedule, view.checkedAt);
      if (!parsed) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
      schedule = Object.freeze({ localDate: parsed.localDate, localTime: parsed.localTime, timezone: parsed.timezone, offset: parsed.offset });
    } else {
      if (!q || q.contentState !== 'active') return Promise.resolve();
      if (kind === 'remove' ? q.authorId !== view.userId : q.recipientId !== view.userId || q.openedAt !== null || q.declinedAt !== null) return Promise.resolve();
      if (kind === 'open' && (!view.checkedAt || view.checkedAt < q.releaseAt)) { publish({ ...view, status: 'not_due' }); return Promise.resolve(); }
    }
    const text = kind === 'create' ? normalizePredictionBody(view.draft) : null, generated = commandId();
    if (!uuid(generated) || (kind === 'create' && text === null)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    if (kind === 'open' || (kind === 'remove' && view.reader?.prediction.id === target)) close();
    pending = Object.freeze({ id: generated.toLowerCase(), kind, base: q ? Object.freeze({ ...q }) : null, text, schedule,
      floor: view.checkedAt, knownIds: Object.freeze(view.predictions.map(q => q.id)), revision: draftRevision, readerGeneration: kind === 'open' ? readerGeneration : null });
    publish({ ...view, pending: true }); return run('mutate');
  }
  function read(id: string) {
    if (!view.available || pending || view.requiresRefresh || (activeMode !== null && activeMode !== 'read')) return Promise.resolve();
    const q = view.predictions.find(q => q.id === id);
    if (!q || !canReadPrediction(q, view.userId, view.checkedAt)) return Promise.resolve();
    close(); return run('read', { id, version: q.version, generation: readerGeneration });
  }
  return { reset, sync, actions: {
    getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: () => run('list'), retry: () => run('mutate'), create: (confirm: boolean) => prepare('create', null, confirm),
    open: (id: string, confirm: boolean) => prepare('open', id, confirm), decline: (id: string, confirm: boolean) => prepare('decline', id, confirm),
    remove: (id: string, confirm: boolean) => prepare('remove', id, confirm), read, close,
    setDraft(text: string) { if (view.available) { draftRevision++; publish({ ...view, draft: text.slice(0, 8000) }); } },
    cancelDraft() { draftRevision++; publish({ ...view, draft: '', schedule: emptyPredictionSchedule }); },
    setSchedule(field: keyof PredictionScheduleInput, value: string) {
      if (!view.available || !['localDate', 'localTime', 'timezone', 'offset'].includes(field)) return;
      draftRevision++; publish({ ...view, schedule: { ...view.schedule, [field]: value.slice(0, 100) } });
    },
  } };
}
export type PredictionsActions = ReturnType<typeof createPredictionsController>['actions'];
export type { PredictionView, PredictionScheduleInput } from './predictions-state';
