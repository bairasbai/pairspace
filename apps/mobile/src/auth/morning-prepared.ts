import { normalizeMessageText } from '../chat/text';
import { historyReadId } from '../chat/read-identity';
import { uuid } from '../chat/reply-model';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { requestMorning, sameMorningContext } from './morning-request';
import { parseMorningSlot, type MorningSlot } from './morning-model';
import { parsePreparedMorning, type PreparedMorning } from './morning-prepared-model';
export type PreparedEditorView = Readonly<{
  available: boolean; target: MorningSlot | null; busy: boolean;
  status: 'idle' | 'loading' | 'ready' | 'sending' | 'saved' | 'unknown' | 'conflict' | 'closed' | 'error';
  draft: string; version: number | null; needsReload: boolean; draftPreserved: boolean; error?: string;
}>;
const empty: PreparedEditorView = { available: false, target: null, busy: false, status: 'idle',
  draft: '', version: null, needsReload: true, draftPreserved: false };
type Command = { id: string; body: string; expectedVersion: number; baseBody: string; revision: number };
/** One separate RAM editor; never shares/persists the fill composer or silently sends on reload. */
export function createMorningPreparedController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ ...config }); validateSyntheticConfig(settings);
  let view = empty, bound: InvitationHostSnapshot | null = null, serial = 0, revision = 0;
  let pending: Command | null = null, canonical: PreparedMorning | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: PreparedEditorView) => { view = next; listeners.forEach(fn => fn()); };
  function reset() { serial++; revision++; bound = null; pending = null; canonical = null; publish(empty); }
  function sync() {
    const next = host.capture();
    if (bound && next && next.generation === bound.generation && next.identity === bound.identity
      && sameMorningContext(next.context, bound.context)) return;
    reset();
    if (next?.context.state === 'ready') { bound = next; publish({ ...empty, available: true }); }
  }
  async function run(write: boolean) {
    if (!bound || bound.context.state !== 'ready' || !view.target || view.busy || (write && !pending)) return;
    const expected = bound, scope = bound.context, target = view.target, command = pending;
    const sequence = ++serial, draftRevision = revision, oldCanonical = canonical, readId = historyReadId();
    const current = () => {
      const next = host.capture();
      return bound === expected && next !== null && next.generation === expected.generation && next.identity === expected.identity
        && sameMorningContext(next.context, expected.context);
    };
    publish({ ...view, busy: true, status: write ? 'sending' : 'loading', error: undefined });
    const result = await requestMorning(settings, host, expected, current, request, {
      path: `/slots/${target.id}/prepared`, ...(write ? { method: 'PUT', commandId: command!.id,
        body: { expected_version: command!.expectedVersion, body: command!.body } } : { readId }),
    });
    if (!current()) return;
    // Current-session revocation wins even after local cancellation of a pending GET.
    if (!result.ok && ['auth_required', 'access_required', 'scope_changed'].includes(result.error)) {
      reset();
      if (result.error === 'scope_changed') await host.refresh(); else host.block(result.error);
      return;
    }
    if (sequence !== serial) return;
    if (!result.ok) {
      const definitive = ['invalid_request', 'version_conflict', 'idempotency_conflict', 'slot_closed'].includes(result.error);
      if (write && definitive) pending = null;
      publish({ ...view, busy: false, error: result.error, needsReload: true,
        status: result.error === 'slot_closed' ? 'closed' : result.error === 'version_conflict' ? 'conflict'
          : write && !definitive ? 'unknown' : 'error' });
      return;
    }
    const next = parsePreparedMorning(result.value, scope, target, write ? { commandId: command!.id } : { readId });
    const backwards = next && canonical && (next.version < canonical.version || (next.version === canonical.version && next.body !== canonical.body));
    const invalidAck = write && next && (next.version < command!.expectedVersion
      || (!result.value.replay && (next.version !== command!.expectedVersion + (command!.body === command!.baseBody ? 0 : 1) || next.body !== command!.body)));
    if (!next || backwards || invalidAck) {
      publish({ ...view, busy: false, status: write ? 'unknown' : 'error', error: 'invalid_response', needsReload: true }); return;
    }
    canonical = next;
    // An untouched reload adopts current text; edited drafts and edits typed while awaiting ACK survive.
    const preserve = write ? revision !== command!.revision
      : revision !== draftRevision || view.draft !== (oldCanonical?.body ?? '');
    pending = null;
    const closed = next.slot.state !== 'sealed';
    publish({ ...view, target: next.slot, busy: false, status: closed ? 'closed' : write ? 'saved' : 'ready',
      draft: preserve ? view.draft : next.body, version: next.version, needsReload: closed,
      draftPreserved: preserve, error: undefined });
  }
  return { sync, reset, actions: {
    getSnapshot: () => view,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    async begin(slot: MorningSlot) {
      if (!view.available || !bound || bound.context.state !== 'ready' || view.busy || pending) return;
      if (view.target) {
        publish({ ...view, error: 'cancel_edit_first' }); return;
      }
      const target = parseMorningSlot(slot, bound.context);
      if (!target || target.senderId !== bound.context.userId || !target.prepared || target.state !== 'sealed') return;
      canonical = null; revision++;
      publish({ ...empty, available: true, target });
      await run(false);
    },
    setDraft(text: string) {
      if (!view.available || !view.target || typeof text !== 'string' || text.length > 16000) return;
      revision++; publish({ ...view, draft: text });
    },
    async reload() {
      if (!view.target || pending || view.status === 'closed') return;
      await run(false);
    },
    async save() {
      if (!view.available || !canonical || !view.target || view.busy || pending || view.needsReload || view.status === 'closed') return;
      const body = normalizeMessageText(view.draft), id = commandId();
      if (!body.ok || !uuid(id)) { publish({ ...view, error: 'invalid_request' }); return; }
      pending = { id, body: body.text, expectedVersion: canonical.version, baseBody: canonical.body, revision };
      await run(true);
    },
    retry: () => pending ? run(true) : Promise.resolve(),
    cancel() {
      if (pending) return;
      serial++; revision++; canonical = null;
      publish({ ...empty, available: view.available });
    },
  } };
}
