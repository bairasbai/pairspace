import { normalizeMessageText } from '../chat/text';
import { keys, uuid } from '../chat/reply-model';
import type { InvitationHostSnapshot } from './invitations-controller';
import type { MorningResult } from './morning-request';
import type { MorningSlot } from './morning-model';
import type { V2DiscussionMessage } from './morning-discussion-v2-model';

type Target = Omit<V2DiscussionMessage, 'body'>;
export type DiscussionEditor = Readonly<{
  targetId?: string; slotId?: string; version?: number; draft: string;
  needsReload: boolean;
  draftPreserved?: boolean;
  status: 'idle' | 'editing' | 'sending' | 'unknown' | 'saved' | 'conflict' | 'deleted' | 'error';
  error?: string;
}>;
export type DiscussionDelete = Readonly<{
  status: 'idle' | 'confirming' | 'sending' | 'unknown' | 'deleted' | 'error';
  confirmation?: { token: string; id: string; slotId: string; seq: number; createdAt: string };
  pendingId?: string; error?: string;
}>;
type Command = { id: string; target: Target; slot: MorningSlot; kind: 'edit' | 'delete'; body?: string; revision: number; noOp?: boolean };
export type DiscussionMutationHost = {
  capture(): InvitationHostSnapshot | null;
  current(token: InvitationHostSnapshot): boolean;
  busy(): boolean;
  digest(body: string): Promise<string>;
  find(id: string): { message: V2DiscussionMessage; slot: MorningSlot } | null;
  exchange(slot: MorningSlot, method: 'PATCH' | 'DELETE' | 'GET', id: string,
    commandId?: string, body?: Record<string, unknown>): Promise<MorningResult>;
  parse(raw: unknown, slot: MorningSlot): V2DiscussionMessage | null;
  accept(message: V2DiscussionMessage, cookie: string, valid: () => boolean): Promise<V2DiscussionMessage | null>;
  publish(editor: DiscussionEditor, deletion: DiscussionDelete): void;
};
const emptyEditor: DiscussionEditor = { draft: '', needsReload: false, status: 'idle' };
const emptyDelete: DiscussionDelete = { status: 'idle' };
const metadata = ({ body: _body, ...rest }: V2DiscussionMessage): Target => rest;
const identity = (a: Target, b: V2DiscussionMessage) => a.id === b.id && a.slotId === b.slotId
  && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch && a.authorId === b.authorId
  && a.clientId === b.clientId && a.seq === b.seq && a.createdAt === b.createdAt;

/** One protected edit draft. Pending mutations retain only their exact command, never target plaintext. */
export function createMorningDiscussionMutations(host: DiscussionMutationHost, commandId: () => string) {
  let editor = emptyEditor, deletion = emptyDelete;
  let target: Target | null = null, slot: MorningSlot | null = null;
  let pending: Command | null = null, confirmation: { token: string; target: Target; slot: MorningSlot } | null = null;
  let baselineDigest: Promise<string | null> | null = null;
  let revision = 0, baseline = 0, serial = 0, tokenSerial = 0, busy = false;
  const publish = () => host.publish(editor, deletion);
  function reset() {
    serial++; revision++; busy = false; pending = null; confirmation = null; target = null; slot = null;
    baselineDigest = null; editor = emptyEditor; deletion = emptyDelete; publish();
  }
  function observe(message: V2DiscussionMessage) {
    if (confirmation?.target.id === message.id && (message.deletedAt || message.version !== confirmation.target.version)) {
      confirmation = null; deletion = { status: message.deletedAt ? 'deleted' : 'error', error: 'version_conflict' };
    }
    if (target?.id === message.id) {
      if (message.deletedAt) {
        const unchanged = revision === baseline || (pending?.kind === 'edit' && pending.target.id === message.id && revision === pending.revision);
        editor = { ...editor, status: 'deleted', draft: unchanged ? '' : editor.draft, version: message.version, needsReload: true };
        target = metadata(message);
      } else if (message.version > target.version) editor = { ...editor, needsReload: true };
    }
    if (message.deletedAt && pending?.target.id === message.id) {
      pending = null; busy = false; serial++;
      deletion = { status: 'deleted' };
    }
    publish();
  }
  function own(id: string) {
    const context = host.capture()?.context, found = host.find(id);
    return context?.state === 'ready' && found && found.message.authorId === context.userId && !found.message.deletedAt ? found : null;
  }
  function beginEdit(id: string) {
    if (busy || pending || host.busy()) return;
    const found = own(id);
    if (!found) return;
    if (target && target.id !== id) { editor = { ...editor, error: 'cancel_edit_first' }; publish(); return; }
    if (target) return;
    serial++; revision++; baseline = revision;
    target = metadata(found.message); slot = found.slot;
    baselineDigest = host.digest(found.message.body!).then(hash => /^[0-9a-f]{64}$/.test(hash) ? hash : null).catch(() => null);
    editor = { status: 'editing', targetId: id, slotId: slot.id, version: target.version, draft: found.message.body!, needsReload: false };
    publish();
  }
  function cancelEdit() {
    if (pending?.kind === 'edit' || busy) return;
    serial++; revision++; target = null; slot = null; baselineDigest = null; editor = emptyEditor; publish();
  }
  function setEditDraft(text: string) {
    if (!host.capture() || !target || typeof text !== 'string' || [...text].length > 8000) return;
    if (text !== editor.draft) { revision++; editor = { ...editor, draft: text, error: undefined }; publish(); }
  }
  async function run() {
    const command = pending, expected = host.capture();
    if (!command || !expected || busy || host.busy()) return;
    const operation = ++serial;
    const valid = () => host.current(expected) && pending === command && serial === operation;
    busy = true;
    if (command.kind === 'edit') editor = { ...editor, status: 'sending', error: undefined };
    else deletion = { status: 'sending', pendingId: command.id };
    publish();
    try {
      const result = await host.exchange(command.slot, command.kind === 'edit' ? 'PATCH' : 'DELETE', command.target.id,
        command.id, command.kind === 'edit' ? { expected_version: command.target.version, body: command.body }
          : { expected_version: command.target.version, confirm: true });
      if (!valid()) return;
      const canonicalDeleted = !result.ok && result.error === 'message_deleted';
      if (!result.ok && !canonicalDeleted) {
        const definitive = ['version_conflict', 'invalid_request', 'idempotency_conflict'].includes(result.error);
        if (definitive) pending = null;
        if (command.kind === 'edit') editor = { ...editor, status: definitive ? 'conflict' : 'unknown',
          needsReload: definitive || editor.needsReload, error: result.error };
        else deletion = { status: definitive ? 'error' : 'unknown', error: result.error, ...(definitive ? {} : { pendingId: command.id }) };
        publish(); return;
      }
      const value = result.ok ? result.value : result.canonical;
      const message = value && host.parse(value.message, command.slot);
      if (!value || !keys(value, canonicalDeleted ? 'commandId,message' : 'commandId,replay,message')
        || value.commandId !== command.id || (!canonicalDeleted && typeof value.replay !== 'boolean') || !message
        || !identity(command.target, message) || message.version < command.target.version + (command.kind === 'edit' && command.noOp ? 0 : 1)
        || ((canonicalDeleted || command.kind === 'delete') && !message.deletedAt)
        || (message.deletedAt && message.version <= command.target.version)
        || (!canonicalDeleted && value.replay === false && command.kind === 'edit'
          && (message.deletedAt || message.body !== command.body
            || !(message.version === command.target.version + 1 || (command.noOp && message.version === command.target.version))))) throw Error('invalid_response');
      const accepted = await host.accept(message, result.cookie!, valid);
      if (!host.current(expected) || serial !== operation || (pending && pending !== command)) return;
      // Acceptance can observe a terminal row and resolve this pending command itself.
      if (!pending && message.deletedAt) return;
      if (!valid()) return;
      if (!accepted) throw Error('invalid_response');
      pending = null;
      if (command.kind === 'edit' && target?.id === message.id && !accepted.deletedAt) {
        target = metadata(accepted);
        baselineDigest = host.digest(accepted.body!).then(hash => /^[0-9a-f]{64}$/.test(hash) ? hash : null).catch(() => null);
        const unchanged = revision === command.revision;
        editor = { ...editor, status: 'saved', version: accepted.version, needsReload: !unchanged, draftPreserved: !unchanged,
          ...(unchanged ? { draft: accepted.body! } : {}) };
        if (unchanged) baseline = revision;
      } else if (command.kind === 'delete') deletion = { status: 'deleted' };
      publish();
    } catch {
      if (valid()) {
        if (command.kind === 'edit') editor = { ...editor, status: 'unknown', error: 'invalid_response' };
        else deletion = { status: 'unknown', pendingId: command.id, error: 'invalid_response' };
        publish();
      }
    } finally {
      if (host.current(expected) && serial === operation) { busy = false; publish(); }
    }
  }
  async function reloadEdit() {
    const expected = host.capture(), chosen = target, chosenSlot = slot;
    if (!expected || !chosen || !chosenSlot || pending || busy || host.busy() || chosen.deletedAt) return;
    const operation = ++serial, valid = () => host.current(expected) && serial === operation && target?.id === chosen.id;
    busy = true;
    try {
      const result = await host.exchange(chosenSlot, 'GET', chosen.id);
      if (!valid()) return;
      const message = result.ok ? host.parse(result.value.message, chosenSlot) : null;
      if (!result.ok || !message || !identity(chosen, message) || message.version < chosen.version) {
        editor = { ...editor, status: 'error', needsReload: true, error: result.ok ? 'invalid_response' : result.error }; publish(); return;
      }
      const accepted = await host.accept(message, result.cookie, valid);
      if (!valid()) return;
      if (!accepted) { editor = { ...editor, status: 'error', needsReload: true, error: 'invalid_response' }; publish(); return; }
      target = metadata(accepted);
      baselineDigest = accepted.body === null ? null : host.digest(accepted.body).then(hash => /^[0-9a-f]{64}$/.test(hash) ? hash : null).catch(() => null);
      const privateDraft = revision !== baseline;
      editor = { ...editor, version: accepted.version, status: accepted.deletedAt ? 'deleted' : 'editing',
        needsReload: !!accepted.deletedAt, draftPreserved: privateDraft,
        ...(!privateDraft && accepted.body !== null ? { draft: accepted.body } : {}) };
      publish();
    } catch { if (valid()) { editor = { ...editor, status: 'error', needsReload: true, error: 'transport_error' }; publish(); } }
    finally { if (host.current(expected) && serial === operation) { busy = false; publish(); } }
  }
  const actions = {
    beginEdit, setEditDraft, cancelEdit, reloadEdit,
    async saveEdit() {
      if (!target || !slot || pending || busy || host.busy() || editor.needsReload || target.deletedAt) return;
      const body = normalizeMessageText(editor.draft), id = commandId();
      if (!body.ok || !uuid(id)) { editor = { ...editor, status: 'error', error: 'invalid_body' }; publish(); return; }
      const expected = host.capture(), chosen = target, chosenSlot = slot, chosenRevision = revision;
      const oldHash = await baselineDigest;
      const newHash = await host.digest(body.text).catch(() => null);
      if (!expected || !host.current(expected) || target !== chosen || revision !== chosenRevision || pending || busy || host.busy()) return;
      if (!oldHash || !newHash || !/^[0-9a-f]{64}$/.test(newHash)) {
        editor = { ...editor, status: 'error', error: 'invalid_digest' }; publish(); return;
      }
      pending = { kind: 'edit', id, target: { ...chosen }, slot: chosenSlot, body: body.text, revision, noOp: oldHash === newHash };
      await run();
    },
    beginDelete(id: string) {
      if (pending || busy || host.busy()) return;
      const found = own(id); if (!found) return;
      confirmation = { token: `discussion-delete-${++tokenSerial}`, target: metadata(found.message), slot: found.slot };
      deletion = { status: 'confirming', confirmation: { token: confirmation.token, id, slotId: found.slot.id,
        seq: found.message.seq, createdAt: found.message.createdAt } }; publish();
    },
    cancelDelete() { confirmation = null; if (!pending || pending.kind !== 'delete') { deletion = emptyDelete; publish(); } },
    async confirmDelete(token: string) {
      const chosen = confirmation;
      if (!chosen || chosen.token !== token || pending || busy || host.busy()) return;
      const id = commandId(); if (!uuid(id)) return;
      pending = { kind: 'delete', id, target: chosen.target, slot: chosen.slot, revision };
      confirmation = null; await run();
    },
    retryEdit: run, retryDelete: run,
  };
  function suspend() {
    confirmation = null;
    deletion = { ...deletion, confirmation: undefined };
    editor = { ...editor, draft: revision === baseline || (pending?.kind === 'edit' && revision === pending.revision) ? '' : editor.draft, needsReload: true, error: 'relogin_required' };
    publish();
  }
  return { actions, reset, observe, suspend, unresolved: () => !!pending, busy: () => busy };
}
