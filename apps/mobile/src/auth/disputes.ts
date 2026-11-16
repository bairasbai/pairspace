import { provesDisputeCommand } from './disputes-proof';
import type { SyntheticConfig } from './config';
import { validateSyntheticConfig } from './config';
import { readSessionContext } from './context';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { sameDateContext } from './dates-state';
import { readBoundedJson } from '../chat/transport';
import { emptyDisputes, exact, followsDisputeMetadata, instant, mergeDispute,
  normalizeDisputeClaim, normalizeDisputeCondition, parseDisputeSchedule, disputeOrder, record, uuid,
  validDisputeMetadata, canReadDisputeMetadata, latestDisputeEvent, joinDisputeMetadata, declineDisputeMetadata,
  resolveDisputeMetadata, removeDisputeMetadata, type DisputeMetadata, type DisputeView } from './disputes-state';

type Kind = 'create' | 'join' | 'decline' | 'resolve' | 'remove';
type Pending = Readonly<{ id: string; kind: Kind; base: DisputeMetadata | null; claim: string | null; condition: string | null;
  judgeDate: string; timezone: string; winnerId: string | null; floor: string | null; knownIds: readonly string[]; revision: number }>;
type ReadTarget = Readonly<{ id: string; version: number; generation: number }>;
let nextGeneration = 0;
export function createDisputesController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyDisputes, bound: InvitationHostSnapshot | null = null, pending: Pending | null = null;
  let sequence = 0, draftRevision = 0, readerGeneration = 0;
  let activeMode: 'list' | 'mutate' | 'read' | null = null, readAbort: AbortController | null = null, activeAbort: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: DisputeView) => {
    view = Object.freeze({ ...next, revision: draftRevision,
      disputes: Object.freeze(next.disputes.map(q => Object.freeze({ ...q }))),
      reader: next.reader ? Object.freeze({ ...next.reader, dispute: Object.freeze({ ...next.reader.dispute }) }) : null });
    for (const listener of listeners) listener();
  };
  function reset() {
    sequence++; draftRevision++; readerGeneration++;
    activeAbort?.abort(); activeAbort = null; readAbort = null; activeMode = null; bound = null; pending = null;
    publish({ ...emptyDisputes, generation: ++nextGeneration });
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
    activeMode = mode;
    const abort = new AbortController(); activeAbort = abort;
    if (mode === 'read') readAbort = abort;
    const boundMatches = () => { const c = host.capture(); return c !== null && c.generation === expected.generation && c.identity === expected.identity && sameDateContext(c.context, expected.context); };
    const current = () => sequence === seq && boundMatches() && (mode !== 'read' || target?.generation === readerGeneration);
    const obsolete = () => { if (current()) return false; sync(); return true; };
    const send = (input: Request) => request(abort ? new Request(input, { signal: abort.signal }) : input);
    publish({ ...view, busy: true, error: false, ...(mode === 'mutate' ? { status: 'saving' as const }
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
      const suffix = mode === 'read' ? '/' + target!.id + '/text' : !mutating || !command!.base ? '' : '/' + command!.base.id + (kind === 'remove' ? '' : '/' + kind);
      const payload = mutating ? { membership_epoch: context.membershipEpoch, command_id: command!.id, confirm: true,
        ...(kind !== 'create' ? { expected_version: command!.base!.version } : {}),
        ...(kind === 'create' ? { claim: command!.claim, condition: command!.condition, judge_date: command!.judgeDate, timezone: command!.timezone } : {}),
        ...(kind === 'resolve' ? { winner_id: command!.winnerId } : {}) } : null;
      const response = await send(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/disputes' + suffix
        + (mutating ? '' : '?membership_epoch=' + context.membershipEpoch), {
        method: !mutating ? 'GET' : kind === 'remove' ? 'DELETE' : 'POST',
        headers: { Cookie: cookie, Origin: settings.baseURL, ...(mutating ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(mutating ? { body: JSON.stringify(payload) } : {}), credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (obsolete() || !await cookieMatches()) { void response.body?.cancel().catch(() => {}); return; }
      if ([401, 403].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (!/\bno-store\b/i.test(response.headers.get('cache-control') ?? '') || response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') throw Error('private_response_required');
      if (response.status === 404) { publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true,
        ...(mode === 'read' ? { reader: null, readerStatus: 'error' as const } : {}) }); return; }
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
            reader: null, readerStatus: 'closed' }); return;
        }
      }
      if (response.status !== 200 || !record(body) || !exact(body, 'ok,value') || body.ok !== true || !record(body.value)) throw Error('retry');
      const value = body.value;
      const validClock = (clock: unknown, q: DisputeMetadata) => instant(clock) && (view.checkedAt === null || clock >= view.checkedAt) && latestDisputeEvent(q) <= clock;
      if (mode === 'list') {
        if (!exact(value, 'disputes,checkedAt,capacity,used') || !instant(value.checkedAt) || (view.checkedAt !== null && value.checkedAt < view.checkedAt)
          || value.capacity !== 100 || !Array.isArray(value.disputes) || value.disputes.length > 100 || value.used !== value.disputes.length || Number(value.used) < view.used) throw Error('retry');
        const disputes: DisputeMetadata[] = [];
        for (const q of value.disputes) {
          if (!validDisputeMetadata(q, context) || !validClock(value.checkedAt, q) || disputes.some(old => old.id === q.id)) throw Error('retry');
          disputes.push(q);
        }
        if (view.disputes.some(old => { const next = disputes.find(q => q.id === old.id); return !next || !followsDisputeMetadata(old, next, context); })) throw Error('retry');
        const reader = view.reader && disputes.some(q => q.id === view.reader!.dispute.id && q.version === view.reader!.dispute.version
          && canReadDisputeMetadata(q, context, value.checkedAt as string)) ? view.reader : null;
        publish({ ...view, disputes: disputes.sort(disputeOrder), used: Number(value.used), checked: true, checkedAt: value.checkedAt,
          requiresRefresh: false, reader, readerStatus: reader ? 'opened' : 'closed', status: pending ? 'retry' : 'idle' });
      } else if (mode === 'read') {
        const q = value.dispute;
        if (!validDisputeMetadata(q, context) || q.id !== target!.id || !validClock(value.checkedAt, q)) throw Error('retry');
        const allowed = canReadDisputeMetadata(q, context, value.checkedAt as string);
        if (!exact(value, 'dispute,checkedAt' + (allowed ? ',claim,condition' : ''))
          || (allowed && (typeof value.claim !== 'string' || normalizeDisputeClaim(value.claim) !== value.claim || normalizeDisputeCondition(value.condition) !== value.condition || value.condition === undefined))) throw Error('retry');
        const latest = view.disputes.find(old => old.id === q.id);
        if (!latest || !followsDisputeMetadata(latest, q, context)) throw Error('retry');
        const merged = mergeDispute(view, q, value.checkedAt as string), show = q.version === target!.version && allowed;
        publish({ ...view, ...merged, checked: false, checkedAt: value.checkedAt as string,
          reader: show ? { dispute: q, claim: value.claim as string, condition: value.condition as string | null, checkedAt: value.checkedAt as string, generation: view.generation } : null,
          readerStatus: show ? 'opened' : 'changed' });
      } else {
        const q = value.dispute;
        if (!exact(value, 'dispute,commandId,replay,checkedAt') || !validDisputeMetadata(q, context) || !validClock(value.checkedAt, q)
          || value.commandId !== command!.id || typeof value.replay !== 'boolean') throw Error('retry');
        if (!provesDisputeCommand(command!, q, value.replay, context)) throw Error('retry');
        const merged = mergeDispute(view, q, value.checkedAt as string);
        pending = null;
        const clearDraft = kind === 'create' && draftRevision === command!.revision;
        if (clearDraft) draftRevision++;
        publish({ ...view, ...merged, pending: false, checked: false, checkedAt: value.checkedAt as string, status: 'saved',
          reader: merged.reader, readerStatus: merged.reader ? 'opened' : 'closed',
          ...(clearDraft ? { draftClaim: '', draftCondition: '', judgeDate: '', timezone: '' } : {}) });
      }
    } catch {
      if (current()) publish({ ...view, error: true, ...(mode === 'mutate' ? { status: 'retry' as const,
        reader: null, readerStatus: 'closed' as const }
        : { reader: null, readerStatus: mode === 'read' ? 'error' as const : 'closed' as const }) });
      else sync();
    } finally {
      if (sequence === seq) { activeMode = null; readAbort = null; activeAbort = null; if (boundMatches()) publish({ ...view, busy: false }); else sync(); }
    }
  }
  function prepare(kind: Kind, target: string | null = null, confirmed = false, winnerId: string | null = null): Promise<void> {
    if (!view.available || view.busy || pending || view.requiresRefresh || confirmed !== true || !bound || bound.context.state !== 'ready') return Promise.resolve();
    const q = view.disputes.find(q => q.id === target), context = bound.context;
    if (!view.checkedAt || (kind === 'create' && !view.checked)) {
      publish({ ...view, status: 'conflict', requiresRefresh: true, error: true }); return Promise.resolve();
    }
    if (kind === 'create' && view.used >= 100) { publish({ ...view, status: 'limit' }); return Promise.resolve(); }
    let claim: string | null = null, condition: string | null = null, judgeDate = '', timezone = '';
    if (kind === 'create') {
      const schedule = parseDisputeSchedule({ judgeDate: view.judgeDate, timezone: view.timezone }, view.checkedAt);
      claim = normalizeDisputeClaim(view.draftClaim); const normalized = normalizeDisputeCondition(view.draftCondition);
      if (!schedule || claim === null || normalized === undefined) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
      condition = normalized; judgeDate = schedule.judgeDate; timezone = schedule.timezone;
    } else {
      if (!q) return Promise.resolve();
      // Consent and verdict can only follow explicit successful reading of these exact terms.
      if ((kind === 'join' || kind === 'resolve') && (view.readerStatus !== 'opened' || !view.reader || view.reader.generation !== view.generation
        || view.reader.dispute.id !== q.id || view.reader.dispute.version !== q.version)) return Promise.resolve();
      const changed = kind === 'join' ? joinDisputeMetadata(q, context, view.checkedAt, q.version, true)
        : kind === 'decline' ? declineDisputeMetadata(q, context, view.checkedAt, q.version, true)
          : kind === 'resolve' ? resolveDisputeMetadata(q, context, view.checkedAt, q.version, winnerId, true)
            : removeDisputeMetadata(q, context, view.checkedAt, q.version, true);
      if (!changed) { publish({ ...view, status: kind === 'resolve' || kind === 'join' ? 'not_due' : 'conflict' }); return Promise.resolve(); }
    }
    const generated = commandId();
    if (!uuid(generated)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    if (view.reader?.dispute.id === target) close();
    // Only the private mounted retry command keeps the submitted canonical terms.
    if (kind === 'create') draftRevision++;
    pending = Object.freeze({ id: generated.toLowerCase(), kind, base: q ? Object.freeze({ ...q }) : null, claim, condition,
      judgeDate, timezone, winnerId, floor: view.checkedAt, knownIds: Object.freeze(view.disputes.map(q => q.id)), revision: draftRevision });
    publish({ ...view, pending: true, ...(kind === 'create' ? { draftClaim: '', draftCondition: '' } : {}) }); return run('mutate');
  }
  function read(id: string) {
    if (!view.available || pending || view.requiresRefresh || (activeMode !== null && activeMode !== 'read')) return Promise.resolve();
    const q = view.disputes.find(q => q.id === id);
    if (!q || !bound || bound.context.state !== 'ready' || !view.checkedAt || !canReadDisputeMetadata(q, bound.context, view.checkedAt)) return Promise.resolve();
    close(); return run('read', { id, version: q.version, generation: readerGeneration });
  }
  return { reset, sync, actions: {
    getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => run('list'), retry: () => run('mutate'), create: (confirm: boolean) => prepare('create', null, confirm),
    join: (id: string, confirm: boolean) => prepare('join', id, confirm),
    decline: (id: string, confirm: boolean) => prepare('decline', id, confirm),
    resolve: (id: string, winnerId: string | null, confirm: boolean) => prepare('resolve', id, confirm, winnerId),
    remove: (id: string, confirm: boolean) => prepare('remove', id, confirm), read, close,
    leaveScreen() {
      const uncertain = pending !== null;
      // Screen/background boundary discards ALL private RAM, including unknown payloads.
      // A later visit must load metadata; it cannot reconstruct or retry scrubbed text.
      reset(); sync();
      if (view.available) publish({ ...view, requiresRefresh: true, status: uncertain ? 'conflict' : 'idle' });
    },
    setClaim(text: string) { if (view.available) { draftRevision++; publish({ ...view, draftClaim: text.slice(0, 8000) }); } },
    setCondition(text: string) { if (view.available) { draftRevision++; publish({ ...view, draftCondition: text.slice(0, 2000) }); } },
    setJudgeDate(text: string) { if (view.available) { draftRevision++; publish({ ...view, judgeDate: text.slice(0, 10) }); } },
    setTimezone(text: string) { if (view.available) { draftRevision++; publish({ ...view, timezone: text.slice(0, 100) }); } },
  } };
}
export type DisputesActions = ReturnType<typeof createDisputesController>['actions'];
export type { DisputeView } from './disputes-state';
