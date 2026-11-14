import type { ReplyMessage } from '../src/chat/reply-model';
import { fixture, message, envelope, deferred, uuid } from './chat-replies.fixture';
const response = async (request: Request, transform: (item: ReturnType<typeof message>) => ReplyMessage, latest = 251) => {
  const url = new URL(request.url);
  const row = (id: string) => transform(message(Number(id.slice(-12)) - 1000));
  const role = (name: string) => { const id = url.searchParams.get(name); return id ? { id, message: row(id) } : null; };
  return envelope({ readId: url.searchParams.get('read_id'),
    messages: (url.searchParams.get('message_ids') || '').split(',').filter(Boolean).map(row),
    unavailableIds: [], detail: role('detail_id'), replyTarget: role('reply_target_id'),
    latestVisible: { id: message(latest).id, seq: message(latest).seq } });
};
test('reconciles edits and tombstones in place, preserves position/drafts and only advertises later messages', async () => {
  const h = fixture(); await h.login(); await h.controller.loadOldest();
  const ids = h.controller.getSnapshot().messages.map(m => m.id);
  h.controller.setDraft('private composer'); h.controller.beginEdit(message(1).id); h.controller.setEditDraft('private edit');
  h.reconciliation.mockImplementation(r => response(r, m => m.id === message(1).id ? { ...m, body: 'remote edit', version: 2 }
    : m.id === message(2).id ? { ...m, body: null, deletedAt: '2026-11-12T00:00:00.000Z', version: 2 } : m));
  await h.controller.reconciliation.check();
  expect(h.controller.getSnapshot().messages.map(m => m.id)).toEqual(ids);
  expect(h.controller.getSnapshot().messages[0].body).toBe('remote edit');
  expect(h.controller.getSnapshot().messages[1].body).toBeNull();
  expect(h.controller.getSnapshot().draft).toBe('private composer');
  expect(h.controller.getSnapshot().editState).toMatchObject({ draft: 'private edit', needsReload: true });
  expect(h.controller.reconciliation.getSnapshot()).toMatchObject({ status: 'ready', hasNewMessages: true });
  expect(h.post).not.toHaveBeenCalled(); expect(h.edit).not.toHaveBeenCalled();
});
test('distinct offwindow detail and reply preview are both checked without grafting into window', async () => {
  const h = fixture(); await h.login(); await h.controller.loadOldest();
  h.controller.setReplyTarget(message(2).id); await h.controller.loadLatest();
  // A visible reply to message1 permits the existing explicit original lookup.
  await h.controller.openReplyTarget(message(251).id);
  const ids = h.controller.getSnapshot().messages.map(m => m.id);
  h.reconciliation.mockImplementation(r => response(r, m => m.seq <= message(2).seq ? { ...m, version: 2, body: `edited ${m.seq}` } : m));
  await h.controller.reconciliation.check();
  expect(h.controller.getSnapshot().replyDetail?.body).toBe(`edited ${message(1).seq}`);
  expect(h.controller.getSnapshot().replyTarget?.preview).toBe(`edited ${message(2).seq}`);
  expect(h.controller.getSnapshot().messages.map(m => m.id)).toEqual(ids);
  const url = new URL(h.reconciliation.mock.calls[0][0].url);
  expect(url.searchParams.get('detail_id')).toBe(message(1).id);
  expect(url.searchParams.get('reply_target_id')).toBe(message(2).id);
});
test('foreground bursts singleflight, explicit navigation cancels stale success but not current-account denial', async () => {
  const h = fixture(); await h.login(); const held = deferred();
  h.reconciliation.mockReturnValueOnce(held.promise);
  await h.controller.reconciliation.appStateChanged('active'); expect(h.reconciliation).not.toHaveBeenCalled();
  await h.controller.reconciliation.appStateChanged('background');
  const reading = h.controller.reconciliation.appStateChanged('active');
  while (!h.reconciliation.mock.calls.length) await Promise.resolve();
  const duplicate = h.controller.reconciliation.check(); expect(h.reconciliation).toHaveBeenCalledTimes(1);
  await h.controller.loadOldest(); const oldWindow = h.controller.getSnapshot().messages;
  const req = h.reconciliation.mock.calls[0][0]; held.resolve(await response(req, m => ({ ...m, version: 2, body: 'obsolete' })));
  await Promise.all([reading, duplicate]); expect(h.controller.getSnapshot().messages).toBe(oldWindow);
  const deny = deferred(); h.reconciliation.mockReturnValueOnce(deny.promise);
  const checking = h.controller.reconciliation.check(); while (h.reconciliation.mock.calls.length < 2) await Promise.resolve();
  await h.controller.loadLatest();
  const request = h.reconciliation.mock.calls[1][0];
  deny.resolve(new Response(JSON.stringify({ ok: false, error: 'unavailable', readId: new URL(request.url).searchParams.get('read_id') }), { status: 401 }));
  await checking; expect(h.controller.getSnapshot().phase).toBe('blocked');
});
test('old account response cannot alter a new login or new private draft', async () => {
  const h = fixture(); await h.login(); const held = deferred(); h.reconciliation.mockReturnValueOnce(held.promise);
  const reading = h.controller.reconciliation.check(); while (!h.reconciliation.mock.calls.length) await Promise.resolve();
  await h.controller.signOut(); h.setContext({ state: 'ready', sessionId: 'session', userId: uuid(90), coupleId: uuid(91), membershipEpoch: 2 });
  await h.login(); h.controller.setDraft('new account');
  expect(h.controller.getSnapshot()).toMatchObject({ phase: 'signed_in', draft: 'new account' });
  const request = h.reconciliation.mock.calls[0][0];
  held.resolve(new Response(JSON.stringify({ ok: false, error: 'unavailable', readId: new URL(request.url).searchParams.get('read_id') }), { status: 403 }));
  await reading; expect(h.controller.getSnapshot()).toMatchObject({ phase: 'signed_in', draft: 'new account' });
});

test('unavailable reply source preserves text and target binding, never silently sends plain text', async () => {
  const h = fixture(); await h.login(); h.controller.setReplyTarget(message(250).id); h.controller.setDraft('preserve attachment');
  h.reconciliation.mockImplementation(async r => {
    const json = await (await response(r, m => m)).json();
    json.value.messages = json.value.messages.filter((m: { id: string }) => m.id !== message(250).id);
    json.value.unavailableIds = [message(250).id];
    json.value.replyTarget = { id: message(250).id, message: null };
    return envelope(json.value);
  });
  await h.controller.reconciliation.check();
  expect(h.controller.getSnapshot()).toMatchObject({ draft: 'preserve attachment', replyAttachmentUnavailable: message(250).id });
  expect(h.controller.getSnapshot().replyTarget).toBeUndefined(); await h.controller.send(); expect(h.post).not.toHaveBeenCalled();
  h.controller.cancelReply(); await h.controller.send();
  expect(h.post).toHaveBeenCalledTimes(1); expect((await h.post.mock.calls[0][0].clone().json()).reply_to_id).toBeUndefined();
});

test('changing selected reply cancels an older role read without touching new selection or text', async () => {
  const h = fixture(); await h.login(); h.controller.setReplyTarget(message(250).id);
  const held = deferred(); h.reconciliation.mockReturnValueOnce(held.promise);
  const reading = h.controller.reconciliation.check(); while (!h.reconciliation.mock.calls.length) await Promise.resolve();
  h.controller.setReplyTarget(message(249).id); h.controller.setDraft('new target draft');
  held.resolve(await response(h.reconciliation.mock.calls[0][0], m => ({ ...m, version: 2, body: 'old role edit' })));
  await reading;
  expect(h.controller.getSnapshot().replyTarget?.id).toBe(message(249).id);
  expect(h.controller.getSnapshot().replyTarget?.preview).toBe(message(249).body);
  expect(h.controller.getSnapshot().draft).toBe('new target draft');
});
test('cookie change after read begins blocks plaintext publication', async () => {
  const h = fixture(); await h.login(); const held = deferred(); h.reconciliation.mockReturnValueOnce(held.promise);
  const reading = h.controller.reconciliation.check(); while (!h.reconciliation.mock.calls.length) await Promise.resolve();
  h.client.getCookie.mockResolvedValue('different=cookie');
  held.resolve(await response(h.reconciliation.mock.calls[0][0], m => ({ ...m, version: 2, body: 'not publishable' })));
  await reading;
  expect(h.controller.getSnapshot().phase).toBe('blocked');
  expect(JSON.stringify(h.controller.getSnapshot())).not.toContain('not publishable');
});

test('deleted offwindow reply original retains blocked attachment intent, not a silent plain draft', async () => {
  const h = fixture(); await h.login(); await h.controller.loadOldest();
  h.controller.setReplyTarget(message(2).id); h.controller.setDraft('reply to deleted original'); await h.controller.loadLatest();
  h.reconciliation.mockImplementation(r => response(r, m => m.id === message(2).id
    ? { ...m, version: 2, body: null, deletedAt: '2026-11-12T00:00:00.000Z' } : m));
  await h.controller.reconciliation.check();
  expect(h.controller.getSnapshot()).toMatchObject({ draft: 'reply to deleted original', replyAttachmentUnavailable: message(2).id });
  expect(h.controller.getSnapshot().replyTarget).toBeUndefined();
  await h.controller.send(); expect(h.post).not.toHaveBeenCalled();
  h.controller.cancelReply(); await h.controller.send(); expect(h.post).toHaveBeenCalledTimes(1);
});

test('higher visibility revision drops body yet retains reply intent until explicit removal', async () => {
  const h = fixture(); await h.login(); h.controller.setReplyTarget(message(250).id); h.controller.setDraft('not plain by accident');
  h.reconciliation.mockImplementation(async r => {
    const result = await response(r, m => ({ ...m, version: 2, body: 'discard this response' }));
    result.headers.set('X-Chat-Visibility-Revision', '1'); return result;
  });
  await h.controller.reconciliation.check();
  expect(h.controller.getSnapshot()).toMatchObject({ draft: 'not plain by accident', replyAttachmentUnavailable: message(250).id });
  expect(h.controller.getSnapshot().replyTarget).toBeUndefined();
  expect(h.controller.reconciliation.getSnapshot()).toMatchObject({ status: 'error', error: 'visibility_changed' });
  await h.controller.send(); expect(h.post).not.toHaveBeenCalled();
  h.controller.cancelReply(); expect(h.controller.getSnapshot().replyAttachmentUnavailable).toBeUndefined();
});
