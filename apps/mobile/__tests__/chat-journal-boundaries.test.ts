import { createChatJournal } from '../src/auth/chat-journal';
import { verifyJournalReply } from '../src/auth/journal-reply';
import type { JournalPort, JournalDraft, JournalSnapshot, JournalToken } from '../src/chat/journal/types';
import type { TransportSession } from '../src/chat/transport';
const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const session: TransportSession = { scope: { userId: id(1), coupleId: id(2), membershipEpoch: 1, sessionId: 'session' }, token: 'cookie', credentialGeneration: 1 };
const token: JournalToken = { installationId: id(3), generation: 1, lease: 1, scope: 'scope' };
const ok = { ok: true as const, value: null }, bad = { ok: false as const, error: 'storage_error' as const };
function setup() {
  const port = {
    bindVerifiedScope: jest.fn<ReturnType<JournalPort['bindVerifiedScope']>, Parameters<JournalPort['bindVerifiedScope']>>(async () => ({ ok: true, value: token })),
    inspect: jest.fn<ReturnType<JournalPort['inspect']>, Parameters<JournalPort['inspect']>>(async () => ({ ok: true, value: { hasDraft: false, hasPending: false, draftRevision: 0 } })),
    restore: jest.fn<ReturnType<JournalPort['restore']>, Parameters<JournalPort['restore']>>(async () => ({ ok: true, value: { draft: null, pending: null } })),
    saveDraft: jest.fn<ReturnType<JournalPort['saveDraft']>, Parameters<JournalPort['saveDraft']>>(async () => ok),
    prepareSend: jest.fn<ReturnType<JournalPort['prepareSend']>, Parameters<JournalPort['prepareSend']>>(async () => ok),
    settlePending: jest.fn<ReturnType<JournalPort['settlePending']>, Parameters<JournalPort['settlePending']>>(async () => ok),
    discardPending: jest.fn<ReturnType<JournalPort['discardPending']>, Parameters<JournalPort['discardPending']>>(async () => ok),
    suspend: jest.fn<ReturnType<JournalPort['suspend']>, Parameters<JournalPort['suspend']>>(),
    retire: jest.fn<ReturnType<JournalPort['retire']>, Parameters<JournalPort['retire']>>(async () => ok),
    reset: jest.fn<ReturnType<JournalPort['reset']>, Parameters<JournalPort['reset']>>(async () => ok),
  } satisfies JournalPort;
  type Host = Parameters<typeof createChatJournal>[2];
  let captured: ReturnType<Host['capture']> = { generation: 1, session };
  let draft: JournalDraft = { revision: 0, text: '' };
  const host = {
    capture: () => captured,
    discover: jest.fn<ReturnType<Host['discover']>, Parameters<Host['discover']>>(async () => ({ credential: session, changed: false })),
    cookie: jest.fn(async () => 'cookie'), denied: jest.fn(), draft: () => draft, hasPending: jest.fn(() => false),
    apply: jest.fn<ReturnType<Host['apply']>, Parameters<Host['apply']>>((stored, _pending, preserve) => { if (!preserve && stored) draft = stored; }),
    verifyReply: jest.fn<ReturnType<Host['verifyReply']>, Parameters<Host['verifyReply']>>(async () => true),
    removeReply: jest.fn(() => { draft = { revision: draft.revision + 1, text: draft.text }; }), clearLocal: jest.fn(), bumpRevision: jest.fn(),
  } satisfies Host;
  const journal = createChatJournal('https://example.test', port, host);
  return { journal, host, port, setCapture: (value: typeof captured) => { captured = value; }, setDraft: (value: JournalDraft) => { draft = value; } };
}
describe('journal boundary failures', () => {
  test('disabled and rejected native factory fail closed without recovery plaintext', async () => {
    const h = setup(), disabled = createChatJournal('https://example.test', undefined, h.host);
    expect(disabled.canSend()).toBe(true); expect(await disabled.flush()).toBe(true); expect(await disabled.retire()).toBe(true);
    await disabled.check(); await disabled.restore(); disabled.beginReset(); disabled.changed();
    expect(await disabled.beforeSend(() => true)).toBe(true);
    expect(await disabled.prepare({ id: id(4), body: 'x', revision: 0 }, session, () => true)).toBe(true);
    const broken = createChatJournal('https://example.test', Promise.reject(Error('native unavailable')), h.host);
    await broken.check(); expect(broken.getSnapshot()).toMatchObject({ status: 'unsaved', error: 'storage_error' });
    expect(await broken.retire()).toBe(false);
    expect(JSON.stringify(broken.getSnapshot())).not.toContain('body');
  });
  test('bind errors, inspection errors, cookie mismatch and stale generation', async () => {
    const h = setup(); h.port.bindVerifiedScope.mockResolvedValueOnce(bad); await h.journal.check();
    expect(h.journal.getSnapshot().error).toBe('storage_error');
    h.port.inspect.mockResolvedValueOnce(bad); await h.journal.check(); expect(h.journal.getSnapshot().status).toBe('unsaved');
    h.journal.suspend(); h.host.cookie.mockResolvedValueOnce('other'); await h.journal.check(); expect(h.host.denied).toHaveBeenCalledWith('auth_required');
    h.journal.suspend(); h.port.bindVerifiedScope.mockImplementationOnce(async () => { h.setCapture(null); return { ok: true, value: token }; });
    await h.journal.check(); expect(h.port.suspend).toHaveBeenCalledWith(token);
    expect(await h.journal.flush()).toBe(false); await h.journal.restore();
  });
  test('save and pending cleanup failures retain retryable work', async () => {
    const h = setup(); await h.journal.check(); h.setDraft({ revision: 1, text: 'unsent' });
    h.port.saveDraft.mockResolvedValueOnce(bad); h.journal.changed(); expect(await h.journal.flush()).toBe(false);
    expect(h.journal.getSnapshot().status).toBe('unsaved'); expect(await h.journal.flush()).toBe(true);
    await h.journal.check(); expect(h.journal.getSnapshot().status).toBe('ready');
    h.port.saveDraft.mockRejectedValueOnce(Error('disk')); h.setDraft({ revision: 2, text: 'newer' }); h.journal.changed();
    expect(await h.journal.flush()).toBe(false); expect(await h.journal.flush()).toBe(true);
    expect(h.port.saveDraft).toHaveBeenLastCalledWith(token, { revision: 2, text: 'newer' });
    h.port.settlePending.mockResolvedValueOnce(bad); await h.journal.settle(id(4), 2);
    expect(h.journal.getSnapshot().status).toBe('unsaved'); expect(await h.journal.flush()).toBe(true);
    h.port.discardPending.mockResolvedValueOnce(bad); expect(await h.journal.discard(id(4), 2)).toBe(false);
    expect(await h.journal.flush()).toBe(true); expect(await h.journal.discard(null, 2)).toBe(true);
    h.host.cookie.mockResolvedValueOnce('other'); expect(await h.journal.flush()).toBe(false); expect(h.host.denied).toHaveBeenCalled();
  });
  test('prepare guards and failures do not manufacture a durable pending command', async () => {
    const h = setup(); await h.journal.check();
    expect(await h.journal.prepare({ id: null, body: 'text', revision: 0 }, session, () => true)).toBe(false);
    expect(await h.journal.prepare({ id: id(4), body: 'text', revision: 0 }, session, () => false)).toBe(false);
    expect(await h.journal.prepare({ id: id(4), body: '', revision: 0 }, session, () => true)).toBe(false);
    h.port.prepareSend.mockResolvedValueOnce(bad);
    expect(await h.journal.prepare({ id: id(4), body: 'text', revision: 0 }, session, () => true)).toBe(false);
    expect(await h.journal.prepare({ id: id(4), body: 'text', revision: 0, replyToId: id(8) }, session, () => true)).toBe(true);
    expect(h.journal.getSnapshot()).toMatchObject({ hasPending: true, pendingId: id(4) });
  });
  test('recovery conflict tokens, new drafts and explicit current/stored choices', async () => {
    const h = setup(); const stored: JournalSnapshot = { draft: { revision: 1, text: 'stored', replyToId: id(8) }, pending: null };
    h.port.inspect.mockResolvedValueOnce({ ok: true, value: { hasDraft: true, hasPending: false, draftRevision: 1 } });
    await h.journal.check(); await h.journal.check(); expect(h.journal.getSnapshot().status).toBe('recovery'); expect(h.journal.canSend()).toBe(false); expect(await h.journal.beforeSend(() => true)).toBe(false);
    h.setDraft({ revision: 2, text: 'current' }); h.port.restore.mockResolvedValue({ ok: true, value: stored });
    await h.journal.restore(); const conflict = h.journal.getSnapshot().conflictToken!;
    await h.journal.resolveConflict('wrong', 'stored'); expect(h.host.apply).not.toHaveBeenCalled();
    h.setDraft({ revision: 3, text: 'new current' }); await h.journal.resolveConflict(conflict, 'stored'); expect(h.host.apply).not.toHaveBeenCalled();
    await h.journal.restore(); await h.journal.resolveConflict(h.journal.getSnapshot().conflictToken!, 'current');
    expect(h.host.apply).toHaveBeenLastCalledWith(stored.draft, null, true);
    h.journal.suspend(); h.setDraft({ revision: 4, text: '' }); await h.journal.restore();
    expect(h.journal.getSnapshot().replyNeedsVerification).toBe(id(8)); expect(h.journal.canSend()).toBe(false);
    h.host.verifyReply.mockResolvedValueOnce(false); await h.journal.verifyReply(); expect(h.journal.getSnapshot().replyNeedsVerification).toBe(id(8));
    await h.journal.verifyReply(); expect(h.journal.getSnapshot().replyNeedsVerification).toBeUndefined();
    h.journal.suspend(); await h.journal.restore(); h.journal.removeReply(); await h.journal.flush(); expect(h.host.removeReply).toHaveBeenCalled();
  });
  test('restore errors and scope changes do not apply snapshots', async () => {
    const h = setup(); await h.journal.check(); h.port.restore.mockResolvedValueOnce(bad); await h.journal.restore(); expect(h.journal.getSnapshot().status).toBe('unsaved');
    h.host.discover.mockResolvedValueOnce({ credential: session, changed: false }).mockResolvedValueOnce({ credential: { ...session, scope: { ...session.scope, coupleId: id(9) } }, changed: false });
    await h.journal.restore(); expect(h.host.apply).not.toHaveBeenCalled();
    h.host.discover.mockResolvedValueOnce(null); expect(await h.journal.beforeSend(() => true)).toBe(false);
    h.host.hasPending.mockReturnValueOnce(true); await h.journal.restore(); expect(h.host.apply).not.toHaveBeenCalled();
  });
  test('reset confirmation, failure and retry; retirement failures gate new bind', async () => {
    const h = setup(), notify = jest.fn(), off = h.journal.subscribe(notify); await h.journal.check();
    h.journal.beginReset(); await h.journal.confirmReset('wrong'); expect(h.port.reset).not.toHaveBeenCalled(); h.journal.cancelReset();
    h.journal.beginReset(); h.port.reset.mockResolvedValueOnce(bad); await h.journal.confirmReset(h.journal.getSnapshot().resetToken!);
    expect(h.journal.getSnapshot().status).toBe('unsaved'); h.journal.beginReset(); await h.journal.confirmReset(h.journal.getSnapshot().resetToken!);
    expect(h.journal.getSnapshot().status).toBe('idle'); expect(h.host.clearLocal).toHaveBeenCalledTimes(2); expect(notify).toHaveBeenCalled(); off();
    h.port.retire.mockResolvedValueOnce(bad); expect(await h.journal.retire()).toBe(false); expect(await h.journal.observeVerified(session)).toBe(false);
  });
});
function replyHost() {
  type Host = Parameters<typeof verifyJournalReply>[2];
  const message = { id: id(8), coupleId: id(2), senderId: id(1), clientId: id(9), seq: 1, version: 1,
    body: 'target', createdAt: '2026-11-12T00:00:00.000Z', replyToId: null, deletedAt: null };
  const host = {
    baseURL: 'https://example.test',
    discover: jest.fn<ReturnType<Host['discover']>, Parameters<Host['discover']>>(async () => ({ credential: session, changed: false })),
    request: jest.fn<ReturnType<Host['request']>, Parameters<Host['request']>>(async () => Response.json({ ok: true, value: { message, readId: id(10) } })),
    readId: () => id(10), cookie: jest.fn(async () => 'cookie'), denied: jest.fn(), current: jest.fn(() => true),
    accept: jest.fn<ReturnType<Host['accept']>, Parameters<Host['accept']>>(async () => true),
    select: jest.fn<ReturnType<Host['select']>, Parameters<Host['select']>>(),
  } satisfies Host;
  return { host, message };
}
describe('journal recovered reply revalidation', () => {
  test('missing or changed credentials, invalid context, old account never select', async () => {
    for (const found of [null, { credential: session, changed: true }]) {
      const { host } = replyHost(); host.discover.mockResolvedValueOnce(found);
      expect(await verifyJournalReply(id(8), () => true, host)).toBe(false); expect(host.request).not.toHaveBeenCalled();
    }
    const { host } = replyHost(); expect(await verifyJournalReply(id(8), () => false, host)).toBe(false);
    host.current.mockReturnValueOnce(false); expect(await verifyJournalReply(id(8), () => true, host)).toBe(false); expect(host.select).not.toHaveBeenCalled();
  });
  test('denial, malformed read, changed cookie and terminal targets fail closed', async () => {
    const { host, message } = replyHost();
    host.request.mockResolvedValueOnce(Response.json({ ok: false, error: 'unavailable', readId: id(10) }, { status: 403 }));
    expect(await verifyJournalReply(id(8), () => true, host)).toBe(false); expect(host.denied).toHaveBeenCalledWith('access_required');
    host.request.mockResolvedValueOnce(Response.json({ ok: true, value: { message, readId: id(11) } }));
    expect(await verifyJournalReply(id(8), () => true, host)).toBe(false);
    host.cookie.mockResolvedValueOnce('other'); expect(await verifyJournalReply(id(8), () => true, host)).toBe(false);
    expect(host.denied).toHaveBeenCalledWith('auth_required');
    host.request.mockResolvedValueOnce(Response.json({ ok: true, value: { message: { ...message, body: null, deletedAt: '2026-11-13T00:00:00.000Z', version: 2 }, readId: id(10) } }));
    expect(await verifyJournalReply(id(8), () => true, host)).toBe(false); expect(host.select).not.toHaveBeenCalled();
  });
  test('late validation/cookie/accept changes cannot select recovered target', async () => {
    const { host } = replyHost(); let valid = true;
    host.request.mockImplementationOnce(async () => { valid = false; return Response.json({ ok: false, error: 'reply_unavailable', readId: id(10) }, { status: 409 }); });
    expect(await verifyJournalReply(id(8), () => valid, host)).toBe(false);
    valid = true; host.cookie.mockImplementationOnce(async () => { valid = false; return 'cookie'; });
    expect(await verifyJournalReply(id(8), () => valid, host)).toBe(false);
    valid = true; host.accept.mockResolvedValueOnce(false); expect(await verifyJournalReply(id(8), () => valid, host)).toBe(false);
    host.accept.mockImplementationOnce(async () => { valid = false; return true; });
    expect(await verifyJournalReply(id(8), () => valid, host)).toBe(false); expect(host.select).not.toHaveBeenCalled();
    valid = true; expect(await verifyJournalReply(id(8), () => valid, host)).toBe(true); expect(host.select).toHaveBeenCalledTimes(1);
  });
});
describe('journal late-storage and recovery security', () => {
  test('restore rejected storage and post-restore cookie changes cannot apply', async () => {
    const h = setup(); await h.journal.check();
    h.port.restore.mockRejectedValueOnce(Error('storage unavailable')); await h.journal.restore();
    expect(h.journal.getSnapshot().error).toBe('storage_error');
    h.host.cookie.mockResolvedValueOnce('other'); await h.journal.restore(); expect(h.host.denied).toHaveBeenCalledWith('auth_required');
    h.host.cookie.mockImplementationOnce(async () => { h.journal.suspend(); return 'cookie'; });
    await h.journal.restore(); expect(h.host.apply).not.toHaveBeenCalled();
    h.host.discover.mockResolvedValueOnce(null); await h.journal.restore(); expect(h.host.apply).not.toHaveBeenCalled();
  });
  test('conflict choices require fresh cookie and stable local draft revision', async () => {
    const h = setup(); await h.journal.check(); h.setDraft({ revision: 2, text: 'local' });
    h.port.restore.mockResolvedValue({ ok: true, value: { draft: { revision: 1, text: 'stored' }, pending: null } });
    await h.journal.restore(); const token = h.journal.getSnapshot().conflictToken!;
    await h.journal.check(); expect(h.journal.getSnapshot().status).toBe('conflict');
    h.host.discover.mockResolvedValueOnce(null); await h.journal.resolveConflict(token, 'stored');
    h.host.cookie.mockResolvedValueOnce('other'); await h.journal.resolveConflict(token, 'stored');
    expect(h.host.denied).toHaveBeenCalledWith('auth_required'); expect(h.host.apply).not.toHaveBeenCalled();
    h.host.cookie.mockImplementationOnce(async () => { h.setDraft({ revision: 3, text: 'new local' }); return 'cookie'; });
    await h.journal.resolveConflict(token, 'stored'); expect(h.host.apply).not.toHaveBeenCalled();
    await h.journal.restore(); await h.journal.resolveConflict(h.journal.getSnapshot().conflictToken!, 'stored');
    expect(h.host.apply).toHaveBeenCalledWith({ revision: 1, text: 'stored' }, null, false);
  });
  test('reset cannot run against a new session while native factory or reset is pending', async () => {
    const h = setup(); let resolvePort!: (port: JournalPort) => void;
    const delayed = createChatJournal('https://example.test', new Promise<JournalPort>(resolve => { resolvePort = resolve; }), h.host);
    delayed.beginReset(); const work = delayed.confirmReset(delayed.getSnapshot().resetToken!);
    h.setCapture({ generation: 2, session }); resolvePort(h.port); await work; expect(h.port.reset).not.toHaveBeenCalled();
    const next = setup(); await next.journal.check(); next.journal.beginReset();
    next.port.reset.mockImplementationOnce(async () => { next.journal.suspend(); return ok; });
    await next.journal.confirmReset(next.journal.getSnapshot().resetToken!); expect(next.journal.getSnapshot().status).toBe('idle');
  });
  test('prepare validates again after disk write; cleanup does not cross suspend', async () => {
    const h = setup(); await h.journal.check(); const command = { id: id(4), body: 'pending', revision: 1 };
    h.port.prepareSend.mockImplementationOnce(async () => { h.host.cookie.mockResolvedValueOnce('other'); return ok; });
    expect(await h.journal.prepare(command, session, () => true)).toBe(false); expect(h.host.denied).toHaveBeenCalledWith('auth_required');
    let valid = true;
    h.port.prepareSend.mockImplementationOnce(async () => { valid = false; return ok; });
    expect(await h.journal.prepare(command, session, () => valid)).toBe(false);
    let finish!: () => void;
    const entered = new Promise<void>(resolve => {
      h.port.prepareSend.mockImplementationOnce(async () => { resolve(); await new Promise<void>(done => { finish = done; }); return ok; });
    });
    const preparing = h.journal.prepare(command, session, () => true); await entered;
    const discard = h.journal.discard(id(4), 1), settle = h.journal.settle(id(4), 1);
    h.journal.suspend(); finish(); await preparing; expect(await discard).toBe(false); await settle;
    expect(h.port.discardPending).not.toHaveBeenCalled(); expect(h.port.settlePending).not.toHaveBeenCalled();
  });
  test('inflight save stale completion never republishes and interrupted bind is not reused', async () => {
    const h = setup(); await h.journal.check(); h.setDraft({ revision: 1, text: 'save' });
    h.port.saveDraft.mockImplementationOnce(async () => { h.journal.suspend(); return bad; });
    h.journal.changed(); expect(await h.journal.flush()).toBe(false); expect(h.journal.getSnapshot().status).toBe('idle');
    await h.journal.verifyReply(); h.journal.removeReply(); await h.journal.settle(id(4), 1);
    const next = setup(); next.host.discover.mockResolvedValueOnce({ credential: session, changed: true });
    expect(await next.journal.beforeSend(() => true)).toBe(false);
    next.port.inspect.mockImplementationOnce(async () => { next.setCapture(null); return { ok: true, value: { hasDraft: false, hasPending: false, draftRevision: 0 } }; });
    await next.journal.check(); expect(next.host.bumpRevision).not.toHaveBeenCalled();
  });
});

test.each([3, 4])('atomic discard does not re-save submission revision, preserves newer revision %i', async revision => {
  const h = setup(); await h.journal.check();
  h.port.discardPending.mockImplementationOnce(async () => {
    h.setDraft({ revision, text: revision === 3 ? 'submitted' : 'genuinely newer' });
    h.journal.changed();
    return ok;
  });
  expect(await h.journal.discard(null, 3)).toBe(true);
  expect(h.port.discardPending).toHaveBeenCalledWith(token, null, 3);
  if (revision === 3) expect(h.port.saveDraft).not.toHaveBeenCalled();
  else expect(h.port.saveDraft).toHaveBeenCalledWith(token, { revision: 4, text: 'genuinely newer' });
});
