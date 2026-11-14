import { normalizeMessageText } from '../chat/text';
import { historyReadId } from '../chat/read-identity';
import { uuid } from '../chat/reply-model';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { requestMorning, sameMorningContext } from './morning-request';
import { canonicalMorningSlot, parseMorningSlot, type MorningSlot } from './morning-model';
import { parseSavedMorningDraft, type SavedMorningDraft } from './morning-draft-model';
export type MorningDraftView = Readonly<{
  available: boolean; target: MorningSlot | null; busy: boolean;
  status: 'idle' | 'loading' | 'ready' | 'sending' | 'saved' | 'unknown' | 'conflict' | 'error' | 'deleted';
  state: SavedMorningDraft['state'] | null; draft: string; version: number | null; needsReload: boolean; draftPreserved: boolean; error?: string;
  confirmation?: { token: string; slotId: string; version: number };
}>;
const empty: MorningDraftView = { available: false, target: null, busy: false, status: 'idle',
  state: null, draft: '', version: null, needsReload: true, draftPreserved: false };
type Command = { kind: 'save' | 'delete'; id: string; body: string; expectedVersion: number; baseBody: string | null; revision: number };
/** Explicit private storage; terminal metadata survives form navigation, never authentication changes. */
export function createMorningDraftController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string, terminalLimit = 500) {
  if (!Number.isSafeInteger(terminalLimit) || terminalLimit < 1) throw Error('invalid_terminal_limit');
  const settings = Object.freeze({ ...config }); validateSyntheticConfig(settings);
  let view = empty, bound: InvitationHostSnapshot | null = null, serial = 0, revision = 0;
  let pending: Command | null = null, canonical: SavedMorningDraft | null = null, confirmation: Command | null = null;
  const terminal = new Map<string, SavedMorningDraft>();
  let saturated = false;
  const listeners = new Set<() => void>();
  const publish = (next: MorningDraftView) => { view = next; listeners.forEach(fn => fn()); };
  function reset() { serial++; revision++; bound = null; pending = null; canonical = null; confirmation = null; terminal.clear(); saturated = false; publish(empty); }
  function sync() {
    const next = host.capture();
    if (bound && next && next.generation === bound.generation && next.identity === bound.identity
      && sameMorningContext(next.context, bound.context)) return;
    reset();
    if (next?.context.state === 'ready') { bound = next; publish({ ...empty, available: true }); }
  }
  async function run(write: boolean) {
    if (!bound || bound.context.state !== 'ready' || !view.target || view.busy || saturated || (write && !pending)) return;
    const expected = bound, scope = bound.context, target = view.target, command = pending;
    const sequence = ++serial, draftRevision = revision, oldCanonical = canonical, readId = historyReadId();
    const current = () => {
      const next = host.capture();
      return bound === expected && next !== null && next.generation === expected.generation && next.identity === expected.identity
        && sameMorningContext(next.context, expected.context);
    };
    confirmation = null;
    publish({ ...view, busy: true, status: write ? 'sending' : 'loading', error: undefined, confirmation: undefined });
    const result = await requestMorning(settings, host, expected, current, request, {
      path: `/slots/${target.id}/draft-v2`, canonicalDraftDeleted: true,
      ...(write ? { method: command!.kind === 'delete' ? 'DELETE' : 'PUT', commandId: command!.id,
        body: { expected_version: command!.expectedVersion, ...(command!.kind === 'delete' ? { confirm: true } : { body: command!.body }) } } : { readId }),
    });
    if (!current()) return;
    // Revocation wins even when the form cancelled an in-flight read.
    if (!result.ok && ['auth_required', 'access_required', 'scope_changed'].includes(result.error)) {
      reset();
      if (result.error === 'scope_changed') await host.refresh(); else host.block(result.error);
      return;
    }
    const raw = result.ok ? result.value : result.error === 'draft_deleted' ? result.canonical : null;
    const parsed = raw ? parseSavedMorningDraft(raw, scope, target, write ? { commandId: command!.id } : { readId }) : null;
    const validTerminal = parsed?.state === 'deleted' && (!write || (parsed.version > command!.expectedVersion
      && (!result.ok || raw!.replay === true || (command!.kind === 'delete' && parsed.version === command!.expectedVersion + 1))));
    if (validTerminal) {
      const known = terminal.get(target.id);
      if (!known && terminal.size >= terminalLimit) saturated = true;
      else if (!known || (known.version === parsed.version && canonicalMorningSlot(known.slot, parsed.slot))) terminal.set(target.id, parsed);
      else saturated = true;
    }
    if (saturated) {
      pending = null; canonical = null; confirmation = null;
      publish({ ...view, busy: false, status: 'error', draft: '', needsReload: true, error: 'terminal_knowledge_limit', confirmation: undefined }); return;
    }
    if (sequence !== serial) {
      const learned = view.target && terminal.get(view.target.id);
      if (learned) {
        const preserve = view.draft !== (canonical?.body ?? '');
        serial++; canonical = learned; pending = null; confirmation = null;
        publish({ ...view, target: learned.slot, state: 'deleted', status: 'deleted', busy: false,
          version: learned.version, draft: preserve ? view.draft : '', draftPreserved: preserve,
          needsReload: false, confirmation: undefined, error: undefined });
      }
      return;
    }
    const dead = terminal.get(target.id);
    if (dead) {
      canonical = dead; pending = null;
      const preserve = revision !== (write ? command!.revision : draftRevision) || view.draft !== (oldCanonical?.body ?? '');
      publish({ ...view, target: dead.slot, busy: false, status: 'deleted', state: 'deleted', version: dead.version,
        draft: preserve ? view.draft : '', draftPreserved: preserve, needsReload: false, error: undefined }); return;
    }
    if (!result.ok && !raw) {
      const definitive = ['invalid_request', 'version_conflict', 'idempotency_conflict', 'slot_filled', 'draft_missing'].includes(result.error);
      if (write && definitive) pending = null;
      publish({ ...view, busy: false, error: result.error, needsReload: true,
        status: result.error === 'version_conflict' ? 'conflict' : write && !definitive ? 'unknown' : 'error' }); return;
    }
    const backwards = parsed && canonical && (parsed.version < canonical.version || (parsed.version === canonical.version && parsed.body !== canonical.body));
    const invalidAck = write && parsed && (parsed.version < command!.expectedVersion || command!.kind === 'delete'
      || (!raw!.replay && (parsed.version !== command!.expectedVersion + (command!.body === command!.baseBody ? 0 : 1) || parsed.body !== command!.body)));
    if (!parsed || parsed.state === 'deleted' || backwards || invalidAck || !result.ok) {
      publish({ ...view, busy: false, status: write ? 'unknown' : 'error', error: 'invalid_response', needsReload: true }); return;
    }
    canonical = parsed;
    const preserve = write ? revision !== command!.revision : revision !== draftRevision || view.draft !== (oldCanonical?.body ?? '');
    pending = null;
    publish({ ...view, target: parsed.slot, state: parsed.state, busy: false, status: write ? 'saved' : 'ready',
      draft: preserve ? view.draft : (parsed.body ?? ''), version: parsed.version, needsReload: false, draftPreserved: preserve, error: undefined });
  }
  function writable() { return view.available && canonical && view.target && !view.busy && !pending && !view.needsReload && !saturated && canonical.state !== 'deleted'; }
  return { sync, reset, actions: {
    getSnapshot: () => view,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async begin(slot: MorningSlot) {
      if (!view.available || !bound || bound.context.state !== 'ready' || view.busy || pending || saturated) return;
      if (view.target) { publish({ ...view, error: 'cancel_edit_first' }); return; }
      const target = parseMorningSlot(slot, bound.context);
      if (!target || target.senderId !== bound.context.userId) return;
      canonical = terminal.get(target.id) ?? null; revision++;
      publish({ ...empty, available: true, target }); await run(false);
    },
    setDraft(text: string) {
      if (!view.available || !view.target || typeof text !== 'string' || text.length > 16000 || saturated) return;
      revision++; confirmation = null; publish({ ...view, draft: text, confirmation: undefined });
    },
    async reload() { if (!view.target || pending) return; await run(false); },
    async save() {
      if (!writable()) return;
      const body = normalizeMessageText(view.draft), id = commandId();
      if (!body.ok || !uuid(id)) { publish({ ...view, error: 'invalid_request' }); return; }
      pending = { kind: 'save', id, body: body.text, expectedVersion: canonical!.version, baseBody: canonical!.body, revision }; await run(true);
    },
    beginDelete() {
      if (!writable() || canonical!.state !== 'live') return;
      const id = commandId(); if (!uuid(id)) { publish({ ...view, error: 'invalid_request' }); return; }
      confirmation = { kind: 'delete', id, body: '', expectedVersion: canonical!.version, baseBody: canonical!.body, revision };
      publish({ ...view, confirmation: { token: id, slotId: view.target!.id, version: canonical!.version } });
    },
    cancelDelete() { confirmation = null; publish({ ...view, confirmation: undefined }); },
    async confirmDelete(token: string) {
      if (!writable() || !confirmation || token !== confirmation.id || confirmation.expectedVersion !== canonical!.version || confirmation.revision !== revision) return;
      pending = confirmation; confirmation = null; await run(true);
    },
    retry: () => pending ? run(true) : Promise.resolve(),
    cancel() {
      if (pending) return;
      serial++; revision++; canonical = null; confirmation = null;
      publish({ ...empty, available: view.available, ...(saturated ? { status: 'error', error: 'terminal_knowledge_limit' } : {}) });
    },
  } };
}
