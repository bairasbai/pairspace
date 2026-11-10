import { normalizeMessageText } from './text';

/** Synthetic-only seam. No production/native implementation or automatic restore is shipped. */
export interface SyntheticDraftStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}
export type VerifiedDraftContext = Readonly<{
  origin: string; userId: string; coupleId: string; membershipEpoch: number;
  /** Fresh local incarnation; never serialized, never an auth token. */
  sessionId: string;
}>;
export const MAX_DRAFT_BYTES = 2048;
type Binding = Omit<VerifiedDraftContext, 'sessionId'>;
type Envelope = { version: 1; binding: Binding; text: string };
export type DraftResult =
  | { ok: true; text: string | null }
  | { ok: false; error: 'inactive' | 'invalid' | 'too_large' | 'storage' | 'stale' };
const failure = (error: Extract<DraftResult, { ok: false }>['error']): DraftResult => ({ ok: false, error });
const success = (text: string | null): DraftResult => ({ ok: true, text });
const owners = new WeakSet<SyntheticDraftStore>();
const keys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(',') === expected.sort().join(',');
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
// UTF-8 byte length without a platform TextEncoder dependency. JSON escapes lone surrogates.
export const draftBytes = (value: string) => Array.from(value).reduce((total, char) => {
  const point = char.codePointAt(0)!;
  return total + (point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4);
}, 0);

function decode(raw: string, binding: Binding): string | null {
  if (raw.length > MAX_DRAFT_BYTES || draftBytes(raw) > MAX_DRAFT_BYTES) return null;
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !keys(value, ['version', 'binding', 'text']) || value.version !== 1 ||
      !record(value.binding) || !keys(value.binding, ['origin', 'userId', 'coupleId', 'membershipEpoch']) ||
      Object.entries(binding).some(([key, entry]) => (value.binding as Record<string, unknown>)[key] !== entry)) return null;
  const text = normalizeMessageText(value.text);
  return text.ok && text.text === value.text ? text.text : null;
}

/**
 * Caller must first obtain a CURRENT authenticated, active membership context from its verifier.
 * A typed object is NOT authentication. This contract has no verifier and is not wired into App.
 * One owner per store object. close() is required on logout/revocation/scope change/unmount.
 * Store methods must be linearizable and settled operations must not mutate later.
 */
export function createSyntheticDraftContract(store: SyntheticDraftStore, context: VerifiedDraftContext, isCurrent: () => boolean) {
  if (owners.has(store)) throw new Error('draft_store_owned');
  if (![context.origin, context.userId, context.coupleId, context.sessionId].every(
    value => typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,128}$/.test(value)) ||
    !Number.isSafeInteger(context.membershipEpoch) || context.membershipEpoch < 1) throw new Error('invalid_draft_context');
  owners.add(store);
  const binding: Binding = {
    origin: context.origin, userId: context.userId, coupleId: context.coupleId,
    membershipEpoch: context.membershipEpoch,
  };
  let active = true;
  let revision = 0;
  let text: string | null = null;
  let tail = Promise.resolve();
  let closing: Promise<DraftResult> | null = null;
  const current = () => active && isCurrent();
  const enqueue = (work: () => Promise<DraftResult>): Promise<DraftResult> => {
    const result = tail.then(work).catch(() => {
      active = false;
      text = null;
      return failure('storage');
    });
    tail = result.then(() => undefined);
    return result;
  };
  const removeVerified = async () => {
    await store.remove();
    if (await store.read() !== null) throw new Error('draft_delete_unconfirmed');
  };
  return {
    restore(): Promise<DraftResult> {
      if (!current()) return Promise.resolve(failure('inactive'));
      const ticket = revision;
      return enqueue(async () => {
        if (!current() || revision !== ticket) return failure('stale');
        const raw = await store.read();
        if (!current() || revision !== ticket) return failure('stale');
        if (raw === null) return success(null);
        let restored: string | null;
        try { restored = decode(raw, binding); } catch { restored = null; }
        if (restored === null) {
          await removeVerified();
          return failure('invalid');
        }
        text = restored;
        return success(text);
      });
    },
    edit(input: unknown): Promise<DraftResult> {
      if (!current()) return Promise.resolve(failure('inactive'));
      // Even an invalid/oversized edit supersedes any older asynchronous restore/write.
      const ticket = ++revision;
      text = null;
      const normalized = normalizeMessageText(input);
      const candidate = normalized.ok ? normalized.text : null;
      const encoded = candidate === null ? null : JSON.stringify({ version: 1, binding, text: candidate } satisfies Envelope);
      const error = !normalized.ok && normalized.error !== 'empty_text' ? 'invalid'
        : encoded !== null && draftBytes(encoded) > MAX_DRAFT_BYTES ? 'too_large' : null;
      if (error === null) text = candidate;
      return enqueue(async () => {
        if (!current() || revision !== ticket) return failure('stale');
        if (error !== null || encoded === null) await removeVerified();
        else {
          await store.write(encoded);
          if (await store.read() !== encoded) throw new Error('draft_write_unconfirmed');
        }
        if (!current() || revision !== ticket) return failure('stale');
        return error === null ? success(candidate) : failure(error);
      });
    },
    /** Terminal consume. No send callback is called. Caller may enqueue only after ok.
     * Remains disabled even after unknown ACK, so the consumed text cannot be re-persisted.
     * Start another lifecycle only after command reconciliation and verified context refresh.
     */
    consume(): Promise<DraftResult> {
      if (!current()) return Promise.resolve(failure('inactive'));
      active = false;
      ++revision;
      const ticket = revision;
      const consumed = text;
      text = null;
      return enqueue(async () => {
        await removeVerified();
        return revision === ticket && isCurrent() ? success(consumed) : failure('stale');
      });
    },
    /** Invalidate synchronously; serialize purge after every outstanding read/write. */
    close(): Promise<DraftResult> {
      if (closing) return closing;
      active = false;
      ++revision;
      text = null;
      closing = enqueue(async () => {
        await removeVerified();
        owners.delete(store);
        return success(null);
      });
      return closing;
    },
  };
}
