import { blindQuestion, findBlindQuestion } from '../../../../packages/domain/blind/catalog';
import { normalizeAnswer } from '../../../../packages/domain/blind/answer';
import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { record, sameTaskContext, uuid } from './tasks-state';
import { emptyBlind, validRound, validWindow, type BlindView } from './blind-state';
export type { BlindView, BlindRound } from './blind-state';
type Pending = Readonly<{ id: string; operation: 'open' | 'answer' | 'next'; roundId: string | null; answer: string | null; questionId: string; catalogVersion: number }>;
/** Drafts and unresolved immutable commands exist only in RAM, scoped to the verified session/pair. */
export function createBlindController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyBlind;
  let bound: InvitationHostSnapshot | null = null;
  let pending: Pending | null = null;
  let sequence = 0;
  const commands = new Map<string | null, Pending>();
  const known = new Map<string, NonNullable<BlindView['round']>>();
  const listeners = new Set<() => void>();
  const publish = (next: BlindView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; bound = null; pending = null; commands.clear(); known.clear(); publish(emptyBlind); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && sameTaskContext(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...emptyBlind, available: true }); }
  }
  async function run(action: 'save' | 'list' | 'window') {
    if (view.busy || !view.available || !bound || (action === 'save' && (!pending || view.requiresRefresh))) return;
    const command = pending, expected = bound, id = ++sequence, selected = view.selectedRoundId;
    const current = () => {
      const next = host.capture();
      return sequence === id && next !== null && next.generation === expected.generation
        && next.identity === expected.identity && sameTaskContext(next.context, expected.context);
    };
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
      const path = action === 'window' ? '/blind-rounds'
        : save && command!.operation === 'next' ? '/blind-rounds/next'
        : save && command!.operation === 'answer' ? '/blind-round/' + command!.roundId + '/answer'
        : !save && selected ? '/blind-rounds/' + selected : '/blind-round';
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + path
        + (save ? '' : '?membership_epoch=' + context.membershipEpoch), {
        method: save ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(save ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(save ? { body: JSON.stringify({ command_id: command!.id, membership_epoch: context.membershipEpoch,
          question_id: command!.questionId, catalog_version: command!.catalogVersion,
          ...(command!.operation === 'answer' ? { answer: command!.answer, confirm: true } : {}),
          ...(command!.operation === 'next' ? { expected_predecessor_round_id: command!.roundId, confirm: true } : {}) }) } : {}),
        credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if ([401, 403].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (response.status === 404) { publish({ ...view, status: pending ? 'retry' : 'idle', error: true }); return; }
      const body = await readBoundedJson(response, 131072);
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if (response.status === 409 && record(body) && body.ok === false) {
        if (body.error === 'stale_membership') { host.block('access_required'); reset(); return; }
        if (body.error === 'already_submitted' || body.error === 'idempotency_conflict' || body.error === 'round_conflict') {
          commands.delete(selected); pending = null;
          publish({ ...view, pending: null, status: 'conflict', requiresRefresh: true, error: true }); return;
        }
      }
      if (save && response.status === 400 && record(body) && body.ok === false && body.error === 'invalid_request') {
        commands.delete(selected); pending = null; publish({ ...view, pending: null, status: 'invalid', error: true }); return;
      }
      if (![200, 201].includes(response.status) || !record(body) || body.ok !== true || !record(body.value)) throw new Error('retry');
      const value = body.value;
      if (action === 'window') {
        if (!validWindow(value)) throw new Error('retry');
        for (const item of value.rounds) {
          const prior = known.get(item.id);
          if (prior && (prior.questionId !== item.questionId || prior.catalogVersion !== item.catalogVersion)) throw new Error('retry');
        }
        const retained = new Set(value.rounds.map(r => r.id));
        for (const key of known.keys()) if (!retained.has(key) && key !== selected && !commands.has(key)) known.delete(key);
        publish({ ...view, rounds: value.rounds, currentRoundId: value.currentRoundId }); return;
      }
      const round = value.round;
      if ((round !== null && !validRound(round, context)) || (save && round === null)) throw new Error('retry');
      // A response must not replace an already opened round or retract a reveal.
      const previous = save && command!.operation === 'next' ? known.get(round!.id) : view.round;
      if (selected && !save && (!round || round.id !== selected)) throw new Error('retry');
      if (previous && (!round || round.id !== previous.id || round.questionId !== previous.questionId || round.catalogVersion !== previous.catalogVersion || (previous.revealed && (!round.revealed || round.partnerAnswer !== previous.partnerAnswer))
        || (previous.ownAnswer !== null && round.ownAnswer !== previous.ownAnswer))) throw new Error('retry');
      if (save && command!.operation === 'next' && (round!.id === command!.roundId || round!.questionId !== command!.questionId || round!.catalogVersion !== command!.catalogVersion)) throw new Error('retry');
      const summary = view.rounds.find(r => r.id === round?.id);
      if (summary && (summary.questionId !== round!.questionId || summary.catalogVersion !== round!.catalogVersion)) throw new Error('retry');
      if (save) {
        if (typeof value.replay !== 'boolean' || value.commandId !== command!.id
          || (command!.operation === 'answer' && (round!.id !== command!.roundId || round!.questionId !== command!.questionId || round!.catalogVersion !== command!.catalogVersion || round!.ownAnswer !== command!.answer))) throw new Error('retry');
        commands.delete(selected); pending = null;
        known.set(round!.id, round!);
        publish({ ...view, round, selectedRoundId: round!.id, currentRoundId: command!.operation === 'next' ? null : view.currentRoundId, checked: true, pending: null, status: 'saved',
          draft: command!.operation === 'next' || round!.ownAnswer !== null ? '' : view.draft, consent: false });
      } else {
        if (round) known.set(round.id, round);
        publish({ ...view, selectedRoundId: round?.id ?? selected, round, checked: true, requiresRefresh: false,
          draft: round?.ownAnswer != null ? '' : view.draft, consent: false, status: pending ? 'retry' : 'idle' });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(action === 'save' ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { publish({ ...view, busy: false }); } }
  }
  function prepare(operation: Pending['operation'], questionId: string = blindQuestion.id, catalogVersion: number = blindQuestion.catalogVersion, confirm = false) {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    if (operation === 'answer' && (!view.round || ((view.currentRoundId !== null || view.rounds.length > 0) && view.currentRoundId !== view.round.id) || view.round.ownAnswer !== null || !view.consent)) return Promise.resolve();
    if (operation === 'next' && (!confirm || !view.round?.revealed || view.round.id !== view.currentRoundId || !findBlindQuestion(questionId, catalogVersion))) return Promise.resolve();
    const answer = normalizeAnswer(view.draft), id = commandId();
    if (!uuid(id) || (operation === 'answer' && !answer.ok)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    pending = Object.freeze({ id, operation, roundId: operation !== 'open' ? view.round!.id : null,
      questionId: operation === 'answer' ? view.round!.questionId : questionId,
      catalogVersion: operation === 'answer' ? view.round!.catalogVersion : catalogVersion,
      answer: operation === 'answer' && answer.ok ? answer.text : null });
    commands.set(view.selectedRoundId, pending);
    publish({ ...view, pending: operation, consent: false });
    return run('save');
  }
  return { reset, sync, actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) {
      if (view.available && (view.currentRoundId === null || view.currentRoundId === view.selectedRoundId) && view.round?.ownAnswer == null && pending?.operation !== 'answer')
        publish({ ...view, draft: draft.slice(0, 4000), consent: false });
    },
    setConsent(consent: boolean) { if (!view.busy && !pending) publish({ ...view, consent }); },
    listRounds: () => run('window'),
    selectRound(roundId: string) {
      if (!view.available || !view.rounds.some(r => r.id === roundId)) return Promise.resolve();
      sequence++;
      pending = commands.get(roundId) ?? null;
      publish({ ...view, selectedRoundId: roundId, round: known.get(roundId) ?? null,
        busy: false, draft: '', consent: false, error: false, requiresRefresh: false,
        pending: pending?.operation ?? null, status: pending ? 'retry' : 'idle' });
      return run('list');
    },
    next: (questionId: string, catalogVersion: number, confirm: boolean) => prepare('next', questionId, catalogVersion, confirm),
    open: () => prepare('open'), submit: () => prepare('answer'), retry: () => run('save'), read: () => run('list'),
  } };
}
