import { parseLetterSchedule } from '../../../../packages/domain/letters/schedule';
import { normalizeMessageText } from '../chat/text';
import { readBoundedJson } from '../chat/transport';
import { readSessionContext, type SessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
export type LetterMetadata = Readonly<{ id: string; coupleId: string; senderId: string; recipientId: string;
  clientId: string; membershipEpoch: number; createdAt: string; releaseAt: string | null; releaseTimezone: string | null; availability: 'sealed' | 'available' }>;
export type LettersView = Readonly<{ available: boolean; busy: boolean; status: 'idle' | 'sending' | 'retry' | 'sent' | 'invalid' | 'unavailable';
  draft: string; releaseAtInput: string; releaseTimezoneInput: string; letters: readonly LetterMetadata[]; opened: (LetterMetadata & { body: string }) | null; checked: boolean; error: boolean }>;
const empty: LettersView = { available: false, busy: false, status: 'idle', draft: '', releaseAtInput: '', releaseTimezoneInput: '', letters: [], opened: null, checked: false, error: false };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function same(a: SessionContext, b: SessionContext) {
  return a.state === 'ready' && b.state === 'ready' && a.sessionId === b.sessionId
    && a.userId === b.userId && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch;
}
function validReleaseMetadata(instant: unknown, zone: unknown): boolean {
  if (typeof instant !== 'string' || typeof zone !== 'string' || zone.length > 100
    || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false;
  try {
    return new Date(instant).toISOString() === instant
      && Boolean(new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone);
  } catch { return false; }
}
function validLetter(v: unknown, context: SessionContext, clientId: string | null, withBody = false): v is LetterMetadata {
  if (!record(v) || context.state !== 'ready') return false;
  const fields = 'availability,clientId,coupleId,createdAt,id,membershipEpoch,recipientId,releaseAt,releaseTimezone,senderId';
  if (Object.keys(v).sort().join(',') !== (withBody ? fields.replace('clientId', 'body,clientId') : fields)) return false;
  const scheduled = validReleaseMetadata(v.releaseAt, v.releaseTimezone);
  if (!(v.releaseAt === null && v.releaseTimezone === null && v.availability === 'available')
    && !(scheduled && (v.availability === 'sealed' || v.availability === 'available'))) return false;
  return uuid(v.id) && uuid(v.clientId) && uuid(v.senderId) && uuid(v.recipientId)
    && v.senderId !== v.recipientId && v.coupleId === context.coupleId
    && v.membershipEpoch === context.membershipEpoch
    && typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt))
    && (clientId === null ? v.recipientId === context.userId && v.senderId !== context.userId
      : v.clientId === clientId && v.senderId === context.userId && v.recipientId !== context.userId);
}
/** Ephemeral explicit actions only. An unknown acknowledgement keeps its command ID until scope reset. */
export function createLettersController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = empty;
  let bound: InvitationHostSnapshot | null = null;
  let pending: { id: string; body: string; revision: number; schedule: ReturnType<typeof parseLetterSchedule>; releaseAtInput: string } | null = null;
  let revision = 0;
  let activeAction: 'send' | 'list' | 'open' | null = null;
  let sequence = 0;
  const listeners = new Set<() => void>();
  const publish = (next: LettersView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; revision++; activeAction = null; bound = null; pending = null; publish(empty); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && same(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...empty, available: true }); }
  }
  async function run(action: 'send' | 'list' | 'open', letterId?: string, scheduled = false) {
    if (view.busy || !view.available || !bound) return;
    const send = action === 'send';
    if (action === 'open' && (!uuid(letterId) || !view.letters.some(letter => letter.id === letterId && letter.availability === 'available'))) return;
    if (send && !pending) {
      const text = normalizeMessageText(view.draft);
      const id = commandId();
      const schedule = scheduled ? parseLetterSchedule(view.releaseAtInput, view.releaseTimezoneInput) : null;
      if (!text.ok || !uuid(id) || (scheduled && !schedule)) { publish({ ...view, status: 'invalid' }); return; }
      pending = { id, body: text.text, revision, schedule, releaseAtInput: view.releaseAtInput };
    }
    const command = pending;
    activeAction = action;
    const expected = bound;
    const id = ++sequence;
    const current = () => {
      const next = host.capture();
      return sequence === id && next !== null && next.generation === expected.generation
        && next.identity === expected.identity && same(next.context, expected.context);
    };
    publish({ ...view, busy: true, error: false, ...(send ? { status: 'sending' as const } : {}) });
    try {
      const cookie = await host.getCookie();
      if (!current()) return;
      const binding = await readSessionContext(settings, expected.identity.sessionId, cookie, request);
      if (!current()) return;
      if (!binding.ok) {
        if (binding.error !== 'transport_error') { host.block('auth_required'); reset(); return; }
        throw new Error('retry');
      }
      if (!same(expected.context, binding.value)) { reset(); await host.refresh(); return; }
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      const context = binding.value;
      if (context.state !== 'ready') return;
      const clientId = send ? command!.id : null;
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/letters'
        + (action === 'open' ? '/' + letterId : '')
        + (send ? '' : '?membership_epoch=' + context.membershipEpoch), {
        method: send ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(send ? { 'Content-Type': 'application/json', 'Idempotency-Key': clientId! } : {}) },
        ...(send ? { body: JSON.stringify({ client_letter_id: clientId, membership_epoch: context.membershipEpoch, body: command!.body,
          ...(command!.schedule ? { release_at: command!.releaseAtInput, release_timezone: command!.schedule.releaseTimezone } : {}) }) } : {}),
        credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if ([401, 403, 409].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (response.status === 404) {
        publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true }); return;
      }
      if (send && response.status === 400) {
        const rejection = await readBoundedJson(response, 65536);
        if (!current()) return;
        if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
        if (!current()) return;
        if (!record(rejection) || Object.keys(rejection).sort().join(',') !== 'error,ok'
          || rejection.ok !== false || rejection.error !== 'invalid_request') throw new Error('retry');
        pending = null; publish({ ...view, status: 'invalid', error: true }); return;
      }
      if (![200, 201].includes(response.status)) throw new Error('retry');
      const body = await readBoundedJson(response, 65536);
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if (!record(body) || body.ok !== true || !record(body.value)) throw new Error('invalid_response');
      const letter = body.value.letter;
      if (send) {
        if (typeof body.value.replay !== 'boolean' || !validLetter(letter, context, clientId, true)
          || !('body' in letter) || letter.body !== command!.body
          || letter.releaseAt !== (command!.schedule?.releaseAt ?? null)
          || letter.releaseTimezone !== (command!.schedule?.releaseTimezone ?? null)) throw new Error('invalid_response');
        pending = null; publish({ ...view, status: 'sent', draft: revision === command!.revision ? '' : view.draft });
      } else if (action === 'list') {
        const letters = body.value.letters;
        if (!Array.isArray(letters) || letters.length > 30
          || letters.some(item => !validLetter(item, context, null) || 'body' in item)
          || new Set(letters.map(item => item.id)).size !== letters.length) throw new Error('invalid_response');
        publish({ ...view, letters, opened: null, checked: true });
      } else {
        if (!validLetter(letter, context, null, true) || letter.availability !== 'available' || letter.id !== letterId || !('body' in letter)) throw new Error('invalid_response');
        const text = normalizeMessageText(letter.body);
        if (!text.ok || text.text !== letter.body) throw new Error('invalid_response');
        publish({ ...view, opened: { ...letter, body: text.text } });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(send ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { activeAction = null; publish({ ...view, busy: false }); } }
  }
  return { reset, sync, actions: { getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) { if (view.available) { revision++; publish({ ...view, draft: draft.slice(0, 16000) }); } },
    setReleaseAt(releaseAtInput: string) { if (view.available) { revision++; publish({ ...view, releaseAtInput: releaseAtInput.slice(0, 80) }); } },
    setReleaseTimezone(releaseTimezoneInput: string) { if (view.available) { revision++; publish({ ...view, releaseTimezoneInput: releaseTimezoneInput.slice(0, 100) }); } },
    sendLater: () => run('send', undefined, true), send: () => run('send'), list: () => run('list'), open: (id: string) => run('open', id),
    close() {
      if (activeAction === 'open') { sequence++; activeAction = null; publish({ ...view, busy: false, opened: null }); }
      else publish({ ...view, opened: null });
    },
  } };
}
