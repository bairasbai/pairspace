import { visibilityFixture, wire, row } from './chat-visibility.fixture';
import { deferred } from './chat-window.fixture';
test('discarded higher-revision response never rolls back or replaces independently observed visibility knowledge', async () => {
    const f = visibilityFixture();
    await f.login();
    const held = deferred();
    let posted: Record<string, string> | null = null, received!: () => void;
    const ready = new Promise<void>(yes => { received = yes; });
    f.request.mockImplementation(async (r) => {
        if (r.method !== 'POST')
            return f.response(r);
        posted = await r.clone().json();
        received();
        return held.promise;
    });
    f.controller.setDraft('discarded original');
    const send = f.controller.send();
    await ready;
    expect(posted).not.toBeNull();
    f.controller.beginDiscardOutgoing();
    f.controller.confirmDiscardOutgoing(f.controller.getSnapshot().discardConfirmation!.token);
    f.controller.setDraft('new private draft');
    await f.controller.visibility.beginHide(f.rows[101].id);
    await f.controller.visibility.confirm(f.controller.visibility.getSnapshot().confirmation!.token);
    await f.controller.loadLatest();
    const current = f.controller.getSnapshot().messages;
    held.resolve(wire({ replay: false, message: { ...row(300), clientId: posted!.client_message_id, body: posted!.body } }, 99));
    await send;
    expect(f.controller.getSnapshot().messages).toBe(current);
    expect(f.controller.getSnapshot().draft).toBe('new private draft');
    f.request.mockImplementation(async (r) => {
        const response = await f.response(r);
        if (r.url.includes('/reply-window?'))
            response.headers.set('X-Chat-Visibility-Revision', '0');
        return response;
    });
    await f.controller.loadLatest();
    expect(f.controller.getSnapshot().history?.status).toBe('error');
    expect(f.controller.getSnapshot().messages).toBe(current);
    expect(f.controller.getSnapshot().draft).toBe('new private draft');
});
