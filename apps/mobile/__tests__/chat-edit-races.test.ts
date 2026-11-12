/// <reference types="node" />
import { createHash } from 'node:crypto';
import { fixture, message, row, envelope } from './chat-replies.fixture';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function heldHash() {
    let release!: (value: string) => void, reject!: (error: Error) => void, started!: () => void, body = '';
    const ready = new Promise<void>(resolve => { started = resolve; });
    const hash = jest.fn((text: string) => { body = text; started(); return new Promise<string>((resolve, no) => { release = resolve; reject = no; }); });
    return { hash, ready, release: () => release(digest(body)), reject: () => reject(Error('hash failure')) };
}
const page = (request: Request, m: ReturnType<typeof message>[]) => envelope({ messages: m, readId: new URL(request.url).searchParams.get('read_id'), hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null });
it('delayed digest cannot replace a newer selected window', async () => {
    const h = heldHash(), f = fixture(h.hash);
    await f.login();
    f.history.mockImplementationOnce(async (r) => page(r, [{ ...message(250), version: 2, body: 'older read' }]));
    const old = f.controller.loadLatest();
    await h.ready;
    expect(h.hash).toHaveBeenCalled();
    f.history.mockImplementationOnce(async (r) => page(r, [message(1)]));
    await f.controller.loadLatest();
    const selected = f.controller.getSnapshot().messages;
    h.release();
    await old;
    expect(f.controller.getSnapshot().messages).toBe(selected);
    expect(f.controller.getSnapshot().messages[0].id).toBe(row(1).id);
});
it('delayed digest cannot publish after logout/relogin', async () => {
    const h = heldHash(), f = fixture(h.hash);
    await f.login();
    f.history.mockImplementationOnce(async (r) => page(r, [{ ...message(250), version: 2, body: 'old session' }]));
    const old = f.controller.loadLatest();
    await h.ready;
    await f.controller.signOut();
    await f.login();
    f.controller.setDraft('new session');
    h.release();
    await old;
    expect(f.controller.getSnapshot().draft).toBe('new session');
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('old session');
});
it('concurrent canonical deletion dominates delayed live edit digest', async () => {
    const h = heldHash(), f = fixture(h.hash);
    await f.login();
    f.controller.beginEdit(row(250).id);
    f.controller.setEditDraft('changed');
    const save = f.controller.saveEdit();
    await h.ready;
    expect(h.hash).toHaveBeenCalled();
    f.controller.beginDelete(row(250).id);
    const token = f.controller.getSnapshot().deleteState!.confirmation!.token;
    await f.controller.confirmDelete(token);
    expect(f.controller.getSnapshot().messages.find(m => m.id === row(250).id)?.body).toBeNull();
    h.release();
    await save;
    expect(f.controller.getSnapshot().editState).toMatchObject({ status: 'deleted', draft: '' });
    expect(f.controller.getSnapshot().messages.find(m => m.id === row(250).id)?.body).toBeNull();
});
it('501 edited targets suspend safely without evicting prior floors or clearing a private draft', async () => {
    const f = fixture();
    await f.login();
    f.controller.setDraft('private');
    for (let start = 1; start <= 501; start += 50) {
        const messages = Array.from({ length: Math.min(50, 502 - start) }, (_, i) => ({ ...message(start + i), version: 2, body: `edit ${start + i}` }));
        f.history.mockImplementationOnce(async (request) => page(request, messages));
        await f.controller.loadLatest();
    }
    expect(f.controller.getSnapshot()).toMatchObject({ chatSuspended: true, error: 'edit_knowledge_limit', draft: 'private', messages: [] });
    const calls = f.history.mock.calls.length;
    await f.controller.loadLatest();
    await f.controller.send();
    expect(f.history).toHaveBeenCalledTimes(calls);
    await f.controller.signOut();
    await f.login();
    expect(f.controller.getSnapshot().chatSuspended).toBeUndefined();
});
it('stale hash failure after newer navigation does not suspend or clear the newer window', async () => {
    const h = heldHash(), f = fixture(h.hash);
    await f.login();
    f.history.mockImplementationOnce(async (r) => page(r, [{ ...message(250), version: 2, body: 'stale' }]));
    const old = f.controller.loadLatest();
    await h.ready;
    f.history.mockImplementationOnce(async (r) => page(r, [message(1)]));
    await f.controller.loadLatest();
    h.reject();
    await old;
    expect(f.controller.getSnapshot().messages[0].id).toBe(row(1).id);
    expect(f.controller.getSnapshot().chatSuspended).toBeUndefined();
});

it('external cookie replacement during hashing blocks before any old ledger or body publication', async () => {
    const h = heldHash(), f = fixture(h.hash);
    await f.login();
    f.history.mockImplementationOnce(async request => page(request, [{ ...message(250), version: 2, body: 'old credential plaintext' }]));
    const read = f.controller.loadLatest();
    await h.ready;
    f.client.getCookie.mockResolvedValue('new-account=cookie');
    h.release();
    await read;
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'blocked', error: 'auth_required', messages: [], draft: '' });
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('old credential plaintext');
    f.client.getCookie.mockResolvedValue('test=cookie');
    const attempts = f.client.signIn.mock.calls.length;
    const requests = f.history.mock.calls.length;
    await f.login();
    expect(f.controller.getSnapshot().phase).toBe('blocked');
    expect(f.client.signIn).toHaveBeenCalledTimes(attempts);
    expect(f.history).toHaveBeenCalledTimes(requests);
    await f.controller.signOut();
    await f.login();
    expect(f.controller.getSnapshot().phase).toBe('signed_in');
});
it('external cookie replacement during edit ACK hashing cannot expose an old edit in a new account', async () => {
    const h = heldHash(), f = fixture(h.hash);
    await f.login();
    f.controller.beginEdit(row(250).id);
    f.controller.setEditDraft('old edit plaintext');
    const save = f.controller.saveEdit();
    await h.ready;
    f.client.getCookie.mockResolvedValue('new-account=cookie');
    h.release();
    await save;
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'blocked', error: 'auth_required', messages: [] });
    expect(f.controller.getSnapshot().editState).toBeUndefined();
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('old edit plaintext');
});
