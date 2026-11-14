import { replyAnchor, type ReplyAnchor } from '../chat/reconciliation';
import { createChatReconciliation } from './chat-reconciliation';
import { redactUnavailable } from './reconciliation-redaction';
import { createPairFeatures } from './pair-features';
import { createChatJournal } from './chat-journal';
import { verifyJournalReply } from './journal-reply';
import type { JournalPort } from '../chat/journal/types';
import { createOutgoingFlow, type PendingOutgoing } from './outgoing-flow';
import type { AuthView } from './auth-view';
import { historyReadId } from '../chat/read-identity';
import { createReceiptVerifier } from './verify-chat-receipt';
import { createChatVisibility } from './chat-visibility';
import { createVisibilityFence } from '../chat/visibility-fence';
import { createBoundedRequest } from './bounded-request';
import { redactChatView, redactQueue } from './visibility-redaction';
import { reconcileVisible } from '../chat/reconcile-visible';
import { createChatEdit } from './chat-edit';
import { createEditKnowledge, type BodyDigest } from '../chat/edit-knowledge';
import { createChatDelete } from './chat-delete';
import type { HistoryWindowOptions } from '../chat/history-window';
import { readReplyWindow, readReplyDetail, sendChatReply } from '../chat/reply-transport';
import { displayMessage, createReplyKnowledge, selectReply, type DisplayMessage } from '../chat/reply-view';
import { createQueue, beginSend, failSend, acknowledge, acknowledgeHidden, deleteConfirmed } from '../chat/queue';
import { createChatTransport, type TransportSession } from '../chat/transport';
import type { QueueState } from '../chat/types';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import { readSessionContext, type SessionContext } from './context';
import { provisionProfile } from './profile';
import { requestWaitingSpace } from './waiting';
import type { AuthIdentity, SessionClient } from './official-client';

export type { AuthView } from './auth-view';
const empty: AuthView = { phase: 'signed_out', error: null, draft: '', messages: [] };
/** Ephemeral UI state; never persists credentials, drafts or message bodies. */
export function createSessionController(config: SyntheticConfig, client: SessionClient,
  request: (request: Request) => Promise<Response>, commandId: () => string, digest?: BodyDigest, journalPort?: JournalPort | Promise<JournalPort>) {
  const contextConfig: SyntheticConfig = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(contextConfig);
  let view = empty;
  let generation = 0;
  let refreshSequence = 0;
  let historyBusy = false;
  let detailSequence = 0;
  const replyKnowledge = createReplyKnowledge();
  const editKnowledge = createEditKnowledge(digest);
  let discoverySequence = 0;
  let authIdentity: AuthIdentity | null = null;
  let waitingUserId: string | null = null;
  let verifiedContext: SessionContext | null = null;
  let session: TransportSession | null = null;
  let queue: QueueState | null = null;
  let abort = new AbortController();
  let authTail = Promise.resolve();
  let sending = false;
  let draftRevision = 0;
  let outgoingClientId: string | null = null;
  let pending: PendingOutgoing | null = null;
  let selectedReplyAnchor: ReplyAnchor | undefined;
  let restoredReplyId: string | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: AuthView) => { view = next; for (const notify of listeners) notify(); };
  const invalidate = (preserveLeave = false) => {
    generation++; selectedReplyAnchor = undefined; reconciliation.reset(); journal.suspend(); restoredReplyId = undefined; outgoingFlow.reset(); detailSequence++; replyKnowledge.reset(); editKnowledge.reset(); chatDelete.reset(); chatEdit.reset(); visibility.reset(); visibilityFence.reset(); historyBusy = false; abort.abort(); abort = new AbortController();
    if (!preserveLeave) pairFeatures.resetLeave();
    verifiedContext = null; pairFeatures.resetOrdinary();
    session = null; authIdentity = null; waitingUserId = null; queue = null; sending = false; pending = null; outgoingClientId = null; draftRevision++;
    publish({ ...empty, phase: 'busy' });
    return generation;
  };
  const serialize = (action: () => Promise<void>) => {
    const current = generation;
    authTail = authTail.then(action).catch(() => {
      if (current === generation) block('auth_failed');
    });
    return authTail;
  };
  const pairFeatures = createPairFeatures(contextConfig, {
    capture: () => authIdentity && verifiedContext ? { generation, identity: authIdentity, context: verifiedContext } : null,
    getCookie: () => client.getCookie(), block, refresh,
    suspend() {
      if (!authIdentity || !verifiedContext) return null;
      const identity = authIdentity; const context = verifiedContext;
      invalidate(true); authIdentity = identity; verifiedContext = context;
      publish({ ...empty, phase: 'blocked', error: 'leave_pending' });
      return { generation, identity, context };
    },
    finish() {
      const identity = authIdentity;
      void journal.retire(); invalidate(true); authIdentity = identity;
      publish({ ...empty, phase: 'blocked', error: 'leave_finished' });
    },
  }, boundedRequest, commandId, digest);
  const hiddenReceipt = createReceiptVerifier(() => ({ generation, revision: visibilityFence.revision() }), () => client.getCookie(),
    (message, token, revision, valid) => acceptMessages([message], token, revision, valid));
  const transport = createChatTransport({
    baseUrl: contextConfig.baseURL, allowHttpLoopbackForTests: true, cookieOrigin: contextConfig.baseURL,
    getCredentialGeneration: () => generation,
    store: {
      get() { if (!queue) throw new Error('no_session'); return queue; },
      set(next) { queue = next; },
    },
    request: boundedRequest,
    acceptCanonicalMessage: (message, token, revision, valid) => acceptMessages([message], token, revision, valid),
    acceptHiddenReceipt: hiddenReceipt,
  });
  const rawRequest = createBoundedRequest(request, () => abort.signal);
  const visibilityFence = createVisibilityFence({
    capture: () => session ? { generation, scope: session.scope } : null, cookie: () => client.getCookie(),
    advance() {
      const blockedReplyId = view.replyTarget?.id;
      if (blockedReplyId) restoredReplyId = blockedReplyId;
      reconciliation.visibilityChanged();
      detailSequence++; refreshSequence++; historyBusy = false;
      if (pending) pending.redacted = true;
      if (queue) queue = redactQueue(queue, pending?.id ?? null);
      chatEdit.visibilityChanged(); chatDelete.visibilityChanged(); visibility.invalidateHistory();
      publish({ ...redactChatView(view, !!pending && draftRevision === pending.revision),
        ...(blockedReplyId ? { replyAttachmentUnavailable: blockedReplyId } : {}) });
    },
  });
  function boundedRequest(input: Request, valid?: () => boolean) { return visibilityFence.exchange(input, rawRequest, valid); }
  async function discover(valid: () => boolean = () => true): Promise<{ credential: TransportSession; changed: boolean } | null> {
    const expected = authIdentity;
    if (!expected) return null;
    const current = generation; const sequence = ++discoverySequence;
    try {
      const cookie = await client.getCookie();
      if (current !== generation || expected !== authIdentity || !valid()) return null;
      const result = await readSessionContext(contextConfig, expected.sessionId, cookie, boundedRequest);
      if (current !== generation || expected !== authIdentity) return null;
      // Any auth denial invalidates the current session, even from an older discovery request.
      if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
        block(result.error); return null;
      }
      if (sequence !== discoverySequence) return null;
      if (!valid()) {
        if (!result.ok && result.error !== 'transport_error') block(result.error);
        if (result.ok && (result.value.state !== 'ready' || (session && (
          result.value.userId !== session.scope.userId || result.value.coupleId !== session.scope.coupleId
          || result.value.membershipEpoch !== session.scope.membershipEpoch)))) block('context_changed');
        return null;
      }
      if (!result.ok) {
        if (result.error === 'transport_error' && session) publish({ ...view, error: result.error });
        else block(result.error);
        return null;
      }
      const value = result.value;
      if (value.state !== 'ready') {
        block('context_' + value.state);
        authIdentity = expected;
        verifiedContext = value; pairFeatures.sync();
        if (value.state === 'no_active_pair') waitingUserId = value.userId;
        return null;
      }
      const changed = session !== null && (session.scope.userId !== value.userId
        || session.scope.coupleId !== value.coupleId || session.scope.membershipEpoch !== value.membershipEpoch);
      if (changed) { void journal.retire(); invalidate(); authIdentity = expected; }
      if (!session) {
        const scope = { userId: value.userId, coupleId: value.coupleId, membershipEpoch: value.membershipEpoch,
          sessionId: `${expected.sessionId}:${generation}` };
        queue = createQueue(scope);
        session = { scope, token: '', credentialGeneration: generation, credentialKind: 'cookie' };
        publish({ ...empty, phase: 'signed_in', currentUserId: value.userId });
      }
      verifiedContext = value; pairFeatures.sync();
      const verifiedGeneration = generation;
      await journal.observeVerified({ ...session, token: cookie });
      if (verifiedGeneration !== generation || !valid() || !session) return null;
      return { credential: { ...session, token: cookie }, changed };
    } catch {
      if (current === generation && sequence === discoverySequence && valid()) {
        if (session) publish({ ...view, error: 'transport_error' });
        else block('transport_error');
      }
      return null;
    }
  }
  function block(error: string) {
    if (error === 'access_required' || error.startsWith('context_')) void journal.retire();
    invalidate(); publish({ ...empty, phase: 'blocked', error });
  }
  function denied(error: string) {
    if (error === 'auth_required' || error === 'access_required') {
      block(error);
    } else publish({ ...view, error });
  }
  async function refresh() {
    if (pairFeatures.unresolvedLeave()) return;
    pairFeatures.resetLeave();
    return readWindow('latest', true);
  }
  async function readWindow(direction: HistoryWindowOptions['direction'], supersede = false) {
    const anchorId = direction === 'before' ? view.messages[0]?.id : direction === 'after' ? view.messages.at(-1)?.id : undefined;
    const anchorSeq = direction === 'before' ? view.history?.nextBeforeSeq
      : direction === 'after' ? view.history?.nextAfterSeq : undefined;
    if (view.chatSuspended || (!supersede && (historyBusy || view.phase !== 'signed_in'))) return;
    if ((direction === 'before' || direction === 'after') && anchorSeq == null) return;
    let current = generation;
    const sequence = ++refreshSequence;
    reconciliation.invalidate();
    historyBusy = true;
    if (view.phase === 'signed_in') publish({ ...view, history: {
      ...view.history, status: 'loading', nextBeforeSeq: view.history?.nextBeforeSeq ?? null,
      nextAfterSeq: view.history?.nextAfterSeq ?? null, boundedWindow: true,
    } });
    try {
      const discovered = await discover();
      if (!discovered || sequence !== refreshSequence) return;
      if (!supersede && current !== generation) return;
      current = discovered.credential.credentialGeneration;
      const credential = discovered.credential;
      const readId = historyReadId();
      const result = await readReplyWindow(contextConfig.baseURL, credential, {
        direction, readId, ...(anchorSeq == null ? {} : { anchorSeq, anchorId }), allowHttpLoopbackForTests: true,
      }, boundedRequest);
      if (current !== generation) return;
      // A valid denial still invalidates this authentication generation even if
      // a later navigation won. An old account's denial never affects a new one.
      if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
        denied(result.error); return;
      }
      if (sequence !== refreshSequence) return;
      const cookie = await client.getCookie();
      if (current !== generation || sequence !== refreshSequence) return;
      if (cookie !== credential.token) { block('auth_required'); return; }
      if (!result.ok) {
        if (result.error === 'invalid_cursor') publish({ ...view, error: result.error,
          history: { status: 'error', nextBeforeSeq: null, nextAfterSeq: null, boundedWindow: true } });
        else denied(result.error);
        return;
      }
      // Validate overlap identities, but retain only the new fifty-row window.
      const messages = result.value.messages.map(displayMessage);
      if (!await acceptMessages(messages, credential.token, result.visibilityRevision, () => current === generation && sequence === refreshSequence)) {
        if (current === generation && sequence === refreshSequence && !view.chatSuspended) denied('invalid_response'); return;
      }
      if (current !== generation || sequence !== refreshSequence) return;
      publish({ ...view, error: null, visibilityChanged: view.visibilityChanged ? false : undefined, messages,
        history: { status: 'ready', nextBeforeSeq: result.value.olderCursor?.seq ?? null,
          nextAfterSeq: result.value.newerCursor?.seq ?? null, boundedWindow: true, windowReset: direction === 'latest' } });
    } catch { if (current === generation && sequence === refreshSequence) publish({ ...view, error: 'transport_error' }); }
    finally {
      if (current === generation && sequence === refreshSequence) {
        historyBusy = false;
        if (view.history?.status === 'loading') publish({ ...view, history: { ...view.history, status: 'error' } });
      }
    }
  }
  function scrubDeletedOutgoing(messages: readonly DisplayMessage[]) {
    for (const m of messages) {
      if (!m.deletedAt || !queue || !session || m.senderId !== session.scope.userId) continue;
      const removed = deleteConfirmed(queue, session.scope, m.clientId, m.id, m.version);
      if (removed.ok) queue = removed.state;
      if (pending?.id === m.clientId) {
        const unchanged = draftRevision === pending.revision;
        void journal.settle(pending.id!, pending.revision);
        pending = null; outgoingFlow.forgetDiscardConfirmation();
        publish({ ...view, outgoingPending: undefined, discardConfirmation: undefined,
          ...(unchanged ? { draft: '', replyTarget: undefined } : {}) });
      }
      if (outgoingClientId === m.clientId) { outgoingClientId = null; publish({ ...view, outgoing: undefined }); }
    }
  }
  async function acceptMessages(messages: readonly DisplayMessage[], expectedCookie: string, expectedVisibility: number | undefined, valid: () => boolean = () => true) {
    const current = generation;
    const revisionMatches = () => expectedVisibility !== undefined && expectedVisibility === visibilityFence.revision();
    if (!revisionMatches()) return false;
    try {
      const transaction = await editKnowledge.prepare(messages);
      if (!transaction || current !== generation || !valid() || !revisionMatches()) return false;
      const cookie = await client.getCookie();
      if (current !== generation || !valid() || !revisionMatches() || !transaction.isCurrent()) return false;
      if (cookie !== expectedCookie) { block('auth_required'); return false; }
      if (!replyKnowledge.accept(messages, [...view.messages, ...(view.replyDetail ? [view.replyDetail] : [])])) return false;
      transaction.commit();
    } catch (error) {
      if (current !== generation || !valid() || !revisionMatches()) return false;
      if (!(error instanceof Error) || !['edit_knowledge_limit', 'tombstone_limit'].includes(error.message)) return false;
      detailSequence++; refreshSequence++; scrubDeletedOutgoing(messages);
      publish({ ...view, messages: [], outgoing: undefined, replyDetail: undefined, replyTarget: undefined,
        replyDetailLoading: false, chatSuspended: true, error: error instanceof Error && error.message === 'edit_knowledge_limit' ? 'edit_knowledge_limit' : 'tombstone_limit' });
      return false;
    }
    for (const message of messages) {
      chatEdit.observe(message);
      if (queue && session && message.senderId === session.scope.userId && message.body !== null) {
        const applied = acknowledge(queue, session.scope, { clientId: message.clientId, serverId: message.id,
          senderId: message.senderId, seq: message.seq, version: message.version, body: message.body, replyToId: message.replyToId });
        if (applied.ok) queue = applied.state;
        if (outgoingClientId === message.clientId && view.outgoing) publish({ ...view, outgoing: { ...view.outgoing, body: message.body } });
      }
    }
    const visible = reconcileVisible(view.messages, view.replyDetail, view.replyTarget, messages);
    if (visible.messages !== view.messages || visible.replyDetail !== view.replyDetail || visible.replyTarget !== view.replyTarget) publish({ ...view, ...visible });
    const tombstones = messages.filter(m => m.deletedAt);
    if (tombstones.length) {
      scrubDeletedOutgoing(tombstones);
      const updated = (m: DisplayMessage) => replyKnowledge.tombstone(m.id) ?? m;
      publish({ ...view, messages: view.messages.map(updated),
        ...(view.replyDetail ? { replyDetail: updated(view.replyDetail) } : {}),
        ...(view.replyTarget && replyKnowledge.tombstone(view.replyTarget.id) ? { replyTarget: undefined } : {}),
      });
    }
    return true;
  }
  async function sendQueuedReply(id: string, replyToId: string, credential: TransportSession, current: number, valid: () => boolean) {
    if (!valid()) return { ok: false as const, error: 'stale_session' as const };
    const started = beginSend(queue!, credential.scope, id);
    if (!started.ok) return { ok: false as const, error: started.error };
    queue = started.state;
    const item = queue.messages.find(message => message.clientId === id)!;
    const result = await sendChatReply(contextConfig.baseURL, credential, {
      clientId: id, body: item.body!, replyToId, allowHttpLoopbackForTests: true,
    }, input => boundedRequest(input, valid));
    if (current !== generation || !queue) return { ok: false as const, error: 'stale_session' as const };
    if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) return result;
    const cookie = await client.getCookie();
    if (current !== generation || !queue) return { ok: false as const, error: 'stale_session' as const };
    if (cookie !== credential.token) return { ok: false as const, error: 'auth_required' as const };
    if (!valid()) return { ok: false as const, error: 'stale_session' as const };
    if (!result.ok) {
      const failed = failSend(queue, credential.scope, id, item.attempt, result.error === 'transport_error' || result.error === 'rate_limited');
      if (failed.ok) queue = failed.state;
      return result;
    }
    if ('hiddenMessage' in result.value) {
      if (result.visibilityRevision !== visibilityFence.revision()) return { ok: false as const, error: 'visibility_changed' as const };
      if (!await hiddenReceipt(credential.token, result.visibilityRevision, result.value.hiddenMessage, valid)) return { ok: false as const, error: 'visibility_changed' as const };
      if (current !== generation || !queue || !valid()) return { ok: false as const, error: 'stale_session' as const };
      const accepted = acknowledgeHidden(queue, credential.scope, result.value.hiddenMessage);
      if (!accepted.ok) return { ok: false as const, error: 'invalid_response' as const };
      queue = accepted.state; return { ok: true as const, value: { replay: true, hidden: true as const } };
    }
    const m = result.value.message;
    const accepted = await acceptMessages([displayMessage(m)], credential.token, result.visibilityRevision, valid);
    if (current !== generation || !queue || !valid()) return { ok: false as const, error: 'stale_session' as const };
    if (!accepted) return { ok: false as const, error: 'invalid_response' as const };
    const ack = acknowledge(queue, credential.scope, { clientId: id, serverId: m.id, senderId: m.senderId,
      seq: m.seq, version: m.version, body: m.body, replyToId: m.replyToId });
    if (!ack.ok) return { ok: false as const, error: 'invalid_response' as const };
    queue = ack.state; return { ok: true as const, value: { replay: result.value.replay } };
  }
  async function openReplyTarget(messageId: string) {
    reconciliation.invalidate();
    if (view.phase !== 'signed_in' || view.chatSuspended) return;
    const source = view.messages.find(item => item.id === messageId) ?? (view.replyDetail?.id === messageId ? view.replyDetail : undefined);
    const targetId = source?.replyToId;
    if (!targetId) return;
    const current = generation, sequence = ++detailSequence;
    publish({ ...view, replyDetail: undefined, replyDetailLoading: true });
    try {
      const discovered = await discover();
      if (!discovered || current !== generation || sequence !== detailSequence) return;
      const credential = discovered.credential;
      const result = await readReplyDetail(contextConfig.baseURL, credential, {
        messageId: targetId, readId: historyReadId(), allowHttpLoopbackForTests: true,
      }, boundedRequest);
      if (current !== generation) return;
      if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) { denied(result.error); return; }
      if (sequence !== detailSequence) return;
      const cookie = await client.getCookie();
      if (current !== generation || sequence !== detailSequence) return;
      if (cookie !== credential.token) { block('auth_required'); return; }
      if (!result.ok) {
        if (result.error === 'reply_unavailable') publish({ ...view, error: result.error,
          ...(view.replyTarget?.id === targetId ? { replyTarget: undefined } : {}),
          ...(view.replyDetail?.id === targetId ? { replyDetail: undefined } : {}),
        });
        else denied(result.error);
        return;
      }
      const message = displayMessage(result.value);
      if (!await acceptMessages([message], credential.token, result.visibilityRevision, () => current === generation && sequence === detailSequence)) {
        if (current === generation && sequence === detailSequence && !view.chatSuspended) denied('invalid_response'); return;
      }
      if (current !== generation || sequence !== detailSequence) return;
      publish({ ...view, error: null, replyDetail: message });
    } catch { if (current === generation && sequence === detailSequence) publish({ ...view, error: 'transport_error' }); }
    finally { if (current === generation && sequence === detailSequence) publish({ ...view, replyDetailLoading: false }); }
  }
  function setReplyTarget(id: string) {
    if (view.phase !== 'signed_in') return;
    const message = view.messages.find(item => item.id === id) ?? (view.replyDetail?.id === id ? view.replyDetail : undefined);
    if (!message || message.body === null || view.chatSuspended) return;
    reconciliation.invalidate();
    draftRevision++; selectedReplyAnchor = replyAnchor(message); restoredReplyId = undefined; publish({ ...view, replyTarget: selectReply(message), replyAttachmentUnavailable: undefined }); journal.changed();
  }
  const chatHost = {
    capture: () => session && view.phase === 'signed_in' && !view.chatSuspended ? { generation, session } : null,
    find: (id: string) => view.messages.find(message => message.id === id) ?? (view.replyDetail?.id === id ? view.replyDetail : undefined),
    credential: discover, cookie: () => client.getCookie(), denied,
    acceptHiddenReceipt: hiddenReceipt,
    revisionCurrent: (revision: number | undefined) => revision !== undefined && revision === visibilityFence.revision(),
    accept: (message: DisplayMessage, token: string, revision?: number) => acceptMessages([message], token, revision),
  };
  const reconciliation = createChatReconciliation(contextConfig.baseURL, {
    capture: chatHost.capture, selection: () => ({ messages: view.messages, detail: view.replyDetail, replyTarget: view.replyTarget?.id === selectedReplyAnchor?.id ? selectedReplyAnchor : undefined }),
    credential: discover, cookie: () => client.getCookie(), denied,
    accept: acceptMessages,
    unavailable(ids, blockedReplyId) {
      const unavailableTarget = blockedReplyId ?? (view.replyTarget && ids.includes(view.replyTarget.id) ? view.replyTarget.id : undefined);
      if (unavailableTarget) restoredReplyId = unavailableTarget;
      if (view.editState?.targetId && ids.includes(view.editState.targetId)) chatEdit.visibilityChanged();
      const redacted = redactUnavailable(view, queue, ids, pending, draftRevision, outgoingClientId);
      queue = redacted.queue; publish({ ...redacted.view, ...(unavailableTarget ? { replyAttachmentUnavailable: unavailableTarget } : {}) });
    },
  }, boundedRequest, historyReadId);
  const chatDelete = createChatDelete(contextConfig.baseURL, { ...chatHost,
    publish: deleteState => publish({ ...view, deleteState }),
  }, boundedRequest, commandId);
  const chatEdit = createChatEdit(contextConfig.baseURL, { ...chatHost,
    publish: editState => publish({ ...view, editState }),
  }, boundedRequest, commandId, historyReadId);
  const visibility = createChatVisibility(contextConfig.baseURL, { ...chatHost,
    revision: () => visibilityFence.revision(),
    acceptDeleted: (messages, token, revision) => acceptMessages(messages, token, revision),
  }, boundedRequest, commandId, historyReadId);
  const journal = createChatJournal(contextConfig.baseURL, journalPort, {
    capture: () => session ? { generation, session } : null, discover, denied, cookie: () => client.getCookie(),
    draft: () => ({ revision: draftRevision, text: view.draft, ...(view.replyTarget?.id ?? restoredReplyId ? { replyToId: view.replyTarget?.id ?? restoredReplyId } : {}) }),
    clearLocal() { outgoingFlow.reset(); if (session) queue = createQueue(session.scope); pending = null; sending = false; restoredReplyId = undefined; draftRevision++; publish({ ...view, draft: '', replyTarget: undefined, replyAttachmentUnavailable: undefined, outgoing: undefined, outgoingPending: undefined }); },
    hasPending: () => !!pending, bumpRevision: floor => { draftRevision = Math.max(draftRevision, floor + 1); },
    apply(draft, saved, preserve) {
      draftRevision = Math.max(draftRevision, draft?.revision ?? -1, saved?.draftRevision ?? -1) + 1;
      restoredReplyId = preserve ? view.replyTarget?.id ?? restoredReplyId : draft?.replyToId;
      pending = saved ? { id: saved.clientId, body: saved.body, revision: saved.draftRevision, replyToId: saved.replyToId, redacted: true } : null;
      publish({ ...view, draft: preserve ? view.draft : draft?.text ?? '', ...(preserve ? {} : { replyTarget: undefined, replyAttachmentUnavailable: undefined }),
        outgoing: undefined, outgoingPending: saved ? true : undefined });
    },
    removeReply() { restoredReplyId = undefined; draftRevision++; publish({ ...view, replyTarget: undefined, replyAttachmentUnavailable: undefined }); },
    verifyReply(id, valid) {
      const captured = generation;
      return verifyJournalReply(id, valid, { baseURL: contextConfig.baseURL, discover, request: boundedRequest, readId: historyReadId,
        cookie: () => client.getCookie(), denied, current: () => captured === generation,
        accept: (message, token, revision, check) => acceptMessages([message], token, revision, check),
        select: message => { selectedReplyAnchor = replyAnchor(message); restoredReplyId = undefined; publish({ ...view, replyTarget: selectReply(message), replyAttachmentUnavailable: undefined }); } });
    },
  });
  const outgoingFlow = createOutgoingFlow({
    get pending() { return pending; }, set pending(value) { pending = value; },
    get sending() { return sending; }, set sending(value) { sending = value; },
    get queue() { return queue; }, set queue(value) { queue = value; },
    get outgoingClientId() { return outgoingClientId; }, set outgoingClientId(value) { outgoingClientId = value; },
    view: () => view, generation: () => generation, draftRevision: () => draftRevision,
    publish, denied, discover, commandId, send: transport.send, sendReply: sendQueuedReply,
    canSend: () => (!view.replyAttachmentUnavailable || !!pending) && journal.canSend(),
    ...(journalPort ? { beforeSend: journal.beforeSend, prepare: journal.prepare, settle: journal.settle, discard: journal.discard } : {}),
  });
  const loadOlder = () => readWindow('before');
  return {
    ...pairFeatures.actions, visibility, journal, reconciliation,
    resumeJournalSignIn() { if (journalPort && view.phase === 'blocked' && view.error === 'auth_required') { invalidate(); publish(empty); } },
    setReplyTarget, openReplyTarget,
    beginEdit: chatEdit.beginEdit, setEditDraft: chatEdit.setEditDraft, cancelEdit: chatEdit.cancelEdit,
    saveEdit: chatEdit.saveEdit, retryEdit: chatEdit.retryEdit, reloadEdit: chatEdit.reloadEdit,
    beginDelete: chatDelete.beginDelete, cancelDelete: chatDelete.cancelDelete,
    confirmDelete: chatDelete.confirmDelete, retryDelete: chatDelete.retryDelete,
    cancelReply() { if (view.phase !== 'signed_in') return; reconciliation.invalidate(); restoredReplyId = undefined; journal.removeReply(); draftRevision++; publish({ ...view, replyTarget: undefined, replyAttachmentUnavailable: undefined }); journal.changed(); },
    closeReplyDetail() { reconciliation.invalidate(); detailSequence++; publish({ ...view, replyDetail: undefined, replyDetailLoading: false }); },
    loadOlder,
    loadNewer: () => readWindow('after'),
    loadLatest: () => readWindow('latest', true),
    loadOldest: () => readWindow('oldest'),
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) {
      if (view.phase === 'signed_in') { draftRevision++; publish({ ...view, draft }); journal.changed(); }
    },
    dispose() { invalidate(); publish(empty); },
    signIn(email: string, password: string) {
      if (view.phase !== 'signed_out') return authTail;
      const current = invalidate();
      return serialize(async () => {
        if (current !== generation) return;
        if (!await client.signOut()) throw new Error('cleanup_failed');
        if (current !== generation) return;
        const identity = await client.signIn(email, password);
        if (current !== generation) return;
        if (!identity) {
          if (!await client.signOut()) throw new Error('cleanup_failed');
          publish({ ...empty, error: 'login_failed' }); return;
        }
        authIdentity = identity;
      }).then(async () => { if (current === generation) await refresh(); });
    },
    signOut() {
      const retired = journal.retire();
      const current = invalidate();
      return serialize(async () => {
        if (current !== generation) return;
        if (!await retired) throw new Error('journal_retire_failed');
        if (!await client.signOut()) throw new Error('logout_failed');
        if (current === generation) publish(empty);
      });
    },
    async createProfile() {
      if (view.phase !== 'blocked' || !['context_unmapped', 'profile_retry_required'].includes(view.error ?? '')
        || !authIdentity) return;
      const expected = authIdentity;
      const current = invalidate(); authIdentity = expected;
      try {
        const cookie = await client.getCookie();
        if (current !== generation || authIdentity !== expected) return;
        // Bind this exact cookie snapshot before a mutation, not merely after its response.
        const binding = await readSessionContext(contextConfig, expected.sessionId, cookie, boundedRequest);
        if (current !== generation || authIdentity !== expected) return;
        if (!binding.ok) {
          const error = binding.error === 'access_required' ? 'access_required'
            : binding.error === 'auth_required' || binding.error === 'invalid_context' ? 'auth_required' : 'profile_retry_required';
          block(error);
          if (error === 'profile_retry_required') authIdentity = expected;
          return;
        }
        if (binding.value.state !== 'unmapped') { await refresh(); return; }
        const result = await provisionProfile(contextConfig, expected.sessionId, cookie, boundedRequest);
        if (current !== generation || authIdentity !== expected) return;
        if (result.ok) { await refresh(); return; }
        block(result.error);
        if (result.error === 'profile_retry_required') authIdentity = expected;
      } catch {
        if (current !== generation || authIdentity !== expected) return;
        block('profile_retry_required'); authIdentity = expected;
      }
    },
    async createWaitingSpace() {
      if (pairFeatures.actions.invitations.getSnapshot().busy || pairFeatures.actions.invitations.getSnapshot().recovery === 'accept_uncertain'
        || view.phase !== 'blocked' || !['context_no_active_pair', 'waiting_retry_required'].includes(view.error ?? '')
        || !authIdentity || !waitingUserId) return;
      const expected = authIdentity; const expectedUserId = waitingUserId;
      const current = invalidate(); authIdentity = expected; waitingUserId = expectedUserId;
      try {
        const cookie = await client.getCookie();
        if (current !== generation || authIdentity !== expected) return;
        const binding = await readSessionContext(contextConfig, expected.sessionId, cookie, boundedRequest);
        if (current !== generation || authIdentity !== expected) return;
        if (!binding.ok) {
          const error = binding.error === 'access_required' ? 'access_required'
            : binding.error === 'auth_required' || binding.error === 'invalid_context' ? 'auth_required' : 'waiting_retry_required';
          block(error);
          if (error === 'waiting_retry_required') { authIdentity = expected; waitingUserId = expectedUserId; }
          return;
        }
        if (binding.value.state !== 'unmapped' && binding.value.userId !== expectedUserId) {
          block('auth_required'); return;
        }
        if (binding.value.state !== 'no_active_pair') { await refresh(); return; }
        const result = await requestWaitingSpace(contextConfig, expected.sessionId, cookie, boundedRequest);
        if (current !== generation || authIdentity !== expected) return;
        if (result.ok) { await refresh(); return; }
        block(result.error);
        if (result.error === 'waiting_retry_required') { authIdentity = expected; waitingUserId = expectedUserId; }
      } catch {
        if (current !== generation || authIdentity !== expected) return;
        block('waiting_retry_required'); authIdentity = expected; waitingUserId = expectedUserId;
      }
    },
    send: outgoingFlow.send,
    beginDiscardOutgoing: outgoingFlow.beginDiscardOutgoing,
    cancelDiscardOutgoing: outgoingFlow.cancelDiscardOutgoing,
    confirmDiscardOutgoing: outgoingFlow.confirmDiscardOutgoing,
    refresh,
  };
}
