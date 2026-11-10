import { blindQuestion } from '../../../../packages/domain/blind/catalog';
import { normalizeAnswer } from '../../../../packages/domain/blind/answer';
import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { record, sameTaskContext, uuid } from './tasks-state';
import { emptyBlind, validRound, type BlindView } from './blind-state';
export type { BlindView, BlindRound } from './blind-state';
type Pending = Readonly<{ id: string; operation: 'open' | 'answer'; roundId: string | null; answer: string | null }>;
/** Drafts and unresolved immutable commands exist only in RAM, scoped to the verified session/pair. */
export function createBlindController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptyBlind;
  let bound: InvitationHostSnapshot | null = null;
  let pending: Pending | null = null;
  let sequence = 0;
  const listeners = new Set<() => void>();
  const publish = (next: BlindView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; bound = null; pending = null; publish(emptyBlind); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && sameTaskContext(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...emptyBlind, available: true }); }
  }
  async function run(action: 'save' | 'list') {
    if (view.busy || !view.available || !bound || (action === 'save' && (!pending || view.requiresRefresh))) return;
    const command = pending, expected = bound, id = ++sequence;
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
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/blind-round'
        + (save ? (command!.roundId ? '/' + command!.roundId + '/answer' : '') : '?membership_epoch=' + context.membershipEpoch), {
        method: save ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(save ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(save ? { body: JSON.stringify({ command_id: command!.id, membership_epoch: context.membershipEpoch,
          question_id: blindQuestion.id, catalog_version: blindQuestion.catalogVersion,
          ...(command!.operation === 'answer' ? { answer: command!.answer, confirm: true } : {}) }) } : {}),
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
        if (body.error === 'already_submitted' || body.error === 'idempotency_conflict') {
          pending = null;
          publish({ ...view, pending: null, status: 'conflict', requiresRefresh: true, error: true }); return;
        }
      }
      if (save && response.status === 400 && record(body) && body.ok === false && body.error === 'invalid_request') {
        pending = null; publish({ ...view, pending: null, status: 'invalid', error: true }); return;
      }
      if (![200, 201].includes(response.status) || !record(body) || body.ok !== true || !record(body.value)) throw new Error('retry');
      const value = body.value;
      const round = value.round;
      if ((round !== null && !validRound(round, context)) || (save && round === null)) throw new Error('retry');
      // A response must not replace an already opened round or retract a reveal.
      if (view.round && (!round || round.id !== view.round.id || (view.round.revealed && (!round.revealed || round.partnerAnswer !== view.round.partnerAnswer))
        || (view.round.ownAnswer !== null && round.ownAnswer !== view.round.ownAnswer))) throw new Error('retry');
      if (save) {
        if (typeof value.replay !== 'boolean' || value.commandId !== command!.id
          || (command!.operation === 'answer' && (round!.id !== command!.roundId || round!.ownAnswer !== command!.answer))) throw new Error('retry');
        pending = null;
        publish({ ...view, round, checked: true, pending: null, status: 'saved',
          draft: round!.ownAnswer !== null ? '' : view.draft, consent: false });
      } else {
        publish({ ...view, round, checked: true, requiresRefresh: false,
          draft: round?.ownAnswer != null ? '' : view.draft, consent: false, status: pending ? 'retry' : 'idle' });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(action === 'save' ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { publish({ ...view, busy: false }); } }
  }
  function prepare(operation: Pending['operation']) {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    if (operation === 'answer' && (!view.round || view.round.ownAnswer !== null || !view.consent)) return Promise.resolve();
    const answer = normalizeAnswer(view.draft), id = commandId();
    if (!uuid(id) || (operation === 'answer' && !answer.ok)) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    pending = Object.freeze({ id, operation, roundId: operation === 'answer' ? view.round!.id : null,
      answer: operation === 'answer' && answer.ok ? answer.text : null });
    publish({ ...view, pending: operation, consent: false });
    return run('save');
  }
  return { reset, sync, actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) {
      if (view.available && view.round?.ownAnswer == null && pending?.operation !== 'answer')
        publish({ ...view, draft: draft.slice(0, 4000), consent: false });
    },
    setConsent(consent: boolean) { if (!view.busy && !pending) publish({ ...view, consent }); },
    open: () => prepare('open'), submit: () => prepare('answer'), retry: () => run('save'), read: () => run('list'),
  } };
}
