import { fixture, message, envelope, deferred, settle, uuid } from './chat-replies.fixture';
async function waitFor(predicate: () => boolean) { for (let i = 0; i < 20 && !predicate(); i++)
    await settle(); expect(predicate()).toBe(true); }
const discard = (c: ReturnType<typeof fixture>['controller']) => {
    c.beginDiscardOutgoing();
    const token = c.getSnapshot().discardConfirmation!.token;
    c.confirmDiscardOutgoing(token);
};
for (const reply of [false, true]) {
    test(`${reply ? 'reply' : 'plain'} in-flight discard permits new send; old ACK/finally cannot replace new state`, async () => {
        const f = fixture();
        await f.login();
        const old = deferred(), newer = deferred();
        f.post.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => newer.promise);
        if (reply)
            f.controller.setReplyTarget(message(251).id);
        f.controller.setDraft('old submitted');
        const first = f.controller.send();
        await waitFor(() => f.post.mock.calls.length === 1);
        const oldBody = await f.post.mock.calls[0][0].clone().json();
        f.controller.setDraft('new submitted');
        discard(f.controller);
        expect(f.controller.getSnapshot().draft).toBe('new submitted');
        expect(f.controller.getSnapshot().outgoingPending).toBeUndefined();
        f.controller.cancelReply();
        const second = f.controller.send();
        await waitFor(() => f.post.mock.calls.length === 2);
        const newBody = await f.post.mock.calls[1][0].clone().json();
        expect(newBody.client_message_id).not.toBe(oldBody.client_message_id);
        old.resolve(envelope({ replay: false, message: { ...message(300), clientId: oldBody.client_message_id, body: oldBody.body,
                ...(reply ? { replyToId: oldBody.reply_to_id } : {}) } }));
        await first;
        expect(f.controller.getSnapshot().outgoing).toMatchObject({ body: 'new submitted', status: 'sending' });
        await f.controller.send();
        expect(f.post).toHaveBeenCalledTimes(2);
        newer.resolve(envelope({ replay: false, message: { ...message(301), clientId: newBody.client_message_id, body: newBody.body } }));
        await second;
        expect(f.controller.getSnapshot().outgoing).toMatchObject({ body: 'new submitted', status: 'sent' });
    });
}
test('confirmation is explicit, cancel/obsolete tokens do not discard, unchanged text clears only on confirm', async () => {
    const f = fixture();
    await f.login();
    f.post.mockRejectedValue(Error('offline'));
    f.controller.setDraft('submitted');
    await f.controller.send();
    f.controller.beginDiscardOutgoing();
    const old = f.controller.getSnapshot().discardConfirmation!.token;
    f.controller.cancelDiscardOutgoing();
    f.controller.confirmDiscardOutgoing(old);
    expect(f.controller.getSnapshot().outgoingPending).toBe(true);
    f.controller.beginDiscardOutgoing();
    f.controller.confirmDiscardOutgoing(old);
    expect(f.controller.getSnapshot().outgoingPending).toBe(true);
    f.controller.confirmDiscardOutgoing(f.controller.getSnapshot().discardConfirmation!.token);
    expect(f.controller.getSnapshot().draft).toBe('');
    expect(f.controller.getSnapshot().outgoingPending).toBeUndefined();
    expect(f.post).toHaveBeenCalledTimes(1);
});
for (const status of [401, 403, 409]) {
    test(`discarded same-session ${status} denial remains fail-closed after new send`, async () => {
        const f = fixture();
        await f.login();
        const held = deferred();
        f.post.mockImplementationOnce(() => held.promise);
        f.controller.setDraft('old');
        const old = f.controller.send();
        await waitFor(() => f.post.mock.calls.length === 1);
        discard(f.controller);
        f.controller.setDraft('new');
        await f.controller.send();
        held.resolve(new Response(JSON.stringify({ ok: false, error: status === 409 ? 'stale_membership' : 'unavailable' }), { status }));
        await old;
        expect(f.controller.getSnapshot().phase).toBe('blocked');
        expect(f.controller.getSnapshot().draft).toBe('');
    });
}
test('discarded old session denial cannot log out a new account', async () => {
    const f = fixture();
    await f.login();
    const held = deferred();
    f.post.mockImplementationOnce(() => held.promise);
    f.controller.setDraft('old');
    const old = f.controller.send();
    await waitFor(() => f.post.mock.calls.length === 1);
    discard(f.controller);
    await f.controller.signOut();
    await f.login();
    f.controller.setDraft('new account draft');
    held.resolve(new Response(JSON.stringify({ ok: false, error: 'unavailable' }), { status: 403 }));
    await old;
    expect(f.controller.getSnapshot().phase).toBe('signed_in');
    expect(f.controller.getSnapshot().draft).toBe('new account draft');
});
test('discard while canonical digest waits prevents old ledger/publication and preserves new draft', async () => {
    let resolve!: (digest: string) => void, started!: () => void;
    const ready = new Promise<void>(yes => { started = yes; });
    const f = fixture(async () => { started(); return new Promise(yes => { resolve = yes; }); });
    await f.login();
    f.post.mockImplementationOnce(async (r) => {
        const body = await r.clone().json();
        return envelope({ replay: true,
            message: { ...message(300), clientId: body.client_message_id, body: 'edited canonical', version: 2 } });
    });
    f.controller.setDraft('original');
    const sending = f.controller.send();
    await ready;
    f.controller.setDraft('private new text');
    discard(f.controller);
    resolve('a'.repeat(64));
    await sending;
    expect(f.controller.getSnapshot().outgoing).toBeUndefined();
    expect(f.controller.getSnapshot().draft).toBe('private new text');
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('edited canonical');
});
test('permanent rejection can be explicitly discarded, then creates fresh ID without HTTP DELETE', async () => {
    const f = fixture();
    await f.login();
    f.post.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'invalid_request' }), { status: 400 }));
    f.controller.setDraft('rejected');
    await f.controller.send();
    const original = await f.post.mock.calls[0][0].clone().json();
    discard(f.controller);
    f.controller.setDraft('new');
    await f.controller.send();
    const current = await f.post.mock.calls[1][0].clone().json();
    expect(current.client_message_id).not.toBe(original.client_message_id);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().outgoing?.status).toBe('sent');
    expect(current.client_message_id).toBe(uuid(21));
});
for (const reply of [false, true]) {
    test(`${reply ? 'reply' : 'plain'} discarded response cannot advance visibility fence or erase newer in-flight text`, async () => {
        const f = fixture();
        await f.login();
        const old = deferred(), current = deferred();
        f.post.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
        if (reply)
            f.controller.setReplyTarget(message(251).id);
        f.controller.setDraft('discarded');
        const first = f.controller.send();
        await waitFor(() => f.post.mock.calls.length === 1);
        const a = await f.post.mock.calls[0][0].clone().json();
        discard(f.controller);
        f.controller.cancelReply();
        f.controller.setDraft('current request');
        const second = f.controller.send();
        await waitFor(() => f.post.mock.calls.length === 2);
        const b = await f.post.mock.calls[1][0].clone().json();
        const response = envelope({ replay: false, message: { ...message(300), clientId: a.client_message_id, body: a.body, replyToId: a.reply_to_id ?? null } });
        response.headers.set('X-Chat-Visibility-Revision', '99');
        old.resolve(response);
        await first;
        expect(f.controller.getSnapshot().outgoing).toMatchObject({ body: 'current request', status: 'sending' });
        expect(f.controller.getSnapshot().visibilityChanged).not.toBe(true);
        current.resolve(envelope({ replay: false, message: { ...message(301), clientId: b.client_message_id, body: b.body } }));
        await second;
        expect(f.controller.getSnapshot().outgoing?.status).toBe('sent');
    });
}
test('discard during context discovery suppresses late transport error without a POST', async () => {
    const f = fixture();
    await f.login();
    const held = deferred();
    f.discovery.mockImplementationOnce(() => held.promise);
    f.controller.setDraft('old');
    const send = f.controller.send();
    await waitFor(() => f.discovery.mock.calls.length === 2);
    f.controller.setDraft('new draft');
    discard(f.controller);
    held.resolve(new Response('{}', { status: 503 }));
    await send;
    expect(f.post).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'signed_in', draft: 'new draft', error: null });
});
test('discard during cookie retrieval makes no context or POST request afterward', async () => {
    const f = fixture();
    await f.login();
    let release!: (cookie: string) => void;
    f.client.getCookie.mockImplementationOnce(() => new Promise(yes => { release = yes; }));
    f.controller.setDraft('old');
    const send = f.controller.send();
    discard(f.controller);
    f.controller.setDraft('new draft');
    release('test=cookie');
    await send;
    expect(f.post).not.toHaveBeenCalled();
    expect(f.discovery).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot().draft).toBe('new draft');
});
for (const denied of [true, false]) {
    test(`discard cannot suppress late ${denied ? 'context denial' : 'authoritative pair revocation'}`, async () => {
        const f = fixture();
        await f.login();
        const held = deferred();
        f.discovery.mockImplementationOnce(() => held.promise);
        f.controller.setDraft('old');
        const send = f.controller.send();
        await waitFor(() => f.discovery.mock.calls.length === 2);
        discard(f.controller);
        held.resolve(denied ? new Response(JSON.stringify({ ok: false, error: 'unavailable' }), { status: 403 })
            : envelope({ state: 'no_active_pair', userId: uuid(1), sessionId: 'session' }));
        await send;
        expect(f.controller.getSnapshot().phase).toBe('blocked');
        expect(f.post).not.toHaveBeenCalled();
    });
}
for (const status of [401, 403, 409]) {
    test(`discarded reply still applies current-session ${status} denial`, async () => {
        const f = fixture();
        await f.login();
        const held = deferred();
        f.post.mockImplementationOnce(() => held.promise);
        f.controller.setReplyTarget(message(251).id);
        f.controller.setDraft('reply');
        const send = f.controller.send();
        await waitFor(() => f.post.mock.calls.length === 1);
        discard(f.controller);
        f.controller.setDraft('new private draft');
        held.resolve(new Response(JSON.stringify({ ok: false, error: status === 409 ? 'stale_membership' : 'unavailable' }), { status }));
        await send;
        expect(f.controller.getSnapshot().phase).toBe('blocked');
    });
}

test('unavailable reply keeps a discardable protected attempt instead of stranding a failed queue record', async () => {
    const f = fixture();
    await f.login();
    f.controller.setReplyTarget(message(251).id);
    f.controller.setDraft('cannot deliver to target');
    f.post.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'reply_unavailable' }), { status: 409 }));
    await f.controller.send();
    expect(f.controller.getSnapshot()).toMatchObject({ outgoingPending: true, error: 'reply_unavailable' });
    expect(f.controller.getSnapshot().outgoing).toBeUndefined();
    expect(f.controller.getSnapshot().replyTarget).toBeUndefined();
    f.controller.setDraft('new independent message');
    discard(f.controller);
    await f.controller.send();
    expect(f.controller.getSnapshot().outgoing).toMatchObject({ status: 'sent', body: 'new independent message' });
    const commands = await Promise.all(f.post.mock.calls.map(async ([r]) => r.clone().json()));
    expect(commands[0].client_message_id).not.toBe(commands[1].client_message_id);
    expect(commands[1]).not.toHaveProperty('reply_to_id');
});

test('canonical GET can prove acceptance before POST ACK; discard releases only pending operation', async () => {
    const f = fixture();
    await f.login();
    const held = deferred();
    f.post.mockImplementationOnce(() => held.promise);
    f.controller.setDraft('already committed');
    const old = f.controller.send();
    await waitFor(() => f.post.mock.calls.length === 1);
    const body = await f.post.mock.calls[0][0].clone().json();
    const canonical = { ...message(300), clientId: body.client_message_id, body: body.body };
    f.history.mockImplementationOnce(async r => envelope({ messages: [canonical], readId: new URL(r.url).searchParams.get('read_id'),
        hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null }));
    await f.controller.loadLatest();
    expect(f.controller.getSnapshot().messages[0].id).toBe(canonical.id);
    f.controller.setDraft('second independent message');
    discard(f.controller);
    expect(f.controller.getSnapshot().outgoingPending).toBeUndefined();
    expect(f.controller.getSnapshot().messages[0].id).toBe(canonical.id);
    f.post.mockImplementationOnce(async r => { const next = await r.clone().json(); return envelope({ replay: false,
        message: { ...message(301), clientId: next.client_message_id, body: next.body } }); });
    await f.controller.send();
    held.resolve(envelope({ replay: false, message: canonical }));
    await old;
    expect(f.controller.getSnapshot().outgoing).toMatchObject({ status: 'sent', body: 'second independent message' });
    expect(f.remove).not.toHaveBeenCalled();
});

test('own tombstone clears pending/discard UI immediately before ACK while preserving newer composer and reply', async () => {
    const f = fixture();
    await f.login();
    f.controller.setReplyTarget(message(250).id);
    f.controller.setDraft('submitted private body');
    const held = deferred();
    f.post.mockImplementationOnce(() => held.promise);
    const sending = f.controller.send();
    await waitFor(() => f.post.mock.calls.length === 1);
    const command = await f.post.mock.calls[0][0].clone().json();
    f.controller.setDraft('new independent draft');
    f.controller.setReplyTarget(message(249).id);
    f.controller.beginDiscardOutgoing();
    const staleToken = f.controller.getSnapshot().discardConfirmation!.token;
    const tombstone = { ...message(300), clientId: command.client_message_id, replyToId: command.reply_to_id,
        body: null, version: 2, deletedAt: '2026-11-12T00:00:00.000Z' };
    f.history.mockImplementationOnce(async r => envelope({ messages: [tombstone], readId: new URL(r.url).searchParams.get('read_id'),
        hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null }));
    await f.controller.loadLatest();
    expect(f.controller.getSnapshot().outgoingPending).toBeUndefined();
    expect(f.controller.getSnapshot().discardConfirmation).toBeUndefined();
    expect(f.controller.getSnapshot().outgoing).toBeUndefined();
    expect(f.controller.getSnapshot().draft).toBe('new independent draft');
    expect(f.controller.getSnapshot().replyTarget?.id).toBe(message(249).id);
    f.controller.confirmDiscardOutgoing(staleToken);
    expect(f.controller.getSnapshot().draft).toBe('new independent draft');
    held.resolve(envelope({ replay: false, message: { ...tombstone, body: command.body, version: 1, deletedAt: null } }));
    await sending;
    expect(f.controller.getSnapshot().outgoingPending).toBeUndefined();
    expect(f.controller.getSnapshot().discardConfirmation).toBeUndefined();
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('submitted private body');
});
