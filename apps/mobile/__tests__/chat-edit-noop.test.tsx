import { render } from '@testing-library/react-native';
import { SyntheticChatPanel } from '../src/auth/SyntheticChatPanel';
import { editCopy } from '../src/auth/ChatEditPanel';
import { fixture, message, row, uuid, envelope } from './chat-replies.fixture';

it.each(['ru', 'en'] as const)('%s no-op v1 is unmarked, real edit v2 and restoration v3 stay marked', async locale => {
    const f = fixture();
    await f.login();
    let canonical = message(250);
    f.edit.mockImplementation(async request => {
        const command = await request.clone().json();
        if (canonical.body !== command.body) canonical = { ...canonical, body: command.body, version: canonical.version + 1 };
        return envelope({ commandId: command.command_id, replay: false, message: canonical });
    });
    const props = { locale, onDraft: jest.fn(), onSignIn: jest.fn(), onSignOut: jest.fn(),
        onSend: jest.fn(), onRefresh: jest.fn(), onCreateProfile: jest.fn(), onCreateWaitingSpace: jest.fn() };
    f.controller.beginEdit(row(250).id);
    await f.controller.saveEdit();
    expect(f.controller.getSnapshot().editState).toMatchObject({ status: 'saved', version: 1 });
    const screen = render(<SyntheticChatPanel {...props} {...f.controller.getSnapshot()} />);
    expect(screen.queryByText(editCopy[locale].edited)).toBeNull();
    f.controller.setEditDraft('Real changed text');
    await f.controller.saveEdit();
    expect(canonical.version).toBe(2);
    screen.rerender(<SyntheticChatPanel {...props} {...f.controller.getSnapshot()} />);
    expect(screen.getByText(editCopy[locale].edited)).toBeTruthy();
    await f.controller.saveEdit();
    expect(canonical.version).toBe(2);
    f.controller.setEditDraft(row(250).body);
    await f.controller.saveEdit();
    expect(canonical.version).toBe(3);
    screen.rerender(<SyntheticChatPanel {...props} {...f.controller.getSnapshot()} />);
    expect(screen.getByText(editCopy[locale].edited)).toBeTruthy();
    const commands = await Promise.all(f.edit.mock.calls.map(async ([request]) => request.clone().json()));
    expect(commands.map(command => command.expected_version)).toEqual([1, 1, 2, 2]);
});

it.each(['unchanged', 'later-edited', 'later-deleted'] as const)('lost no-op ACK retries exact command and accepts %s canonical', async outcome => {
    const f = fixture();
    await f.login();
    f.controller.beginEdit(row(250).id);
    f.edit.mockRejectedValueOnce(Error('lost acknowledgement'));
    await f.controller.saveEdit();
    f.controller.setEditDraft('Private next draft');
    const canonical = outcome === 'later-deleted'
        ? { ...message(250), version: 2, body: null, deletedAt: '2026-11-13T00:00:00.000Z' }
        : { ...message(250), version: outcome === 'unchanged' ? 1 : 2,
            body: outcome === 'unchanged' ? row(250).body : 'Later changed text' };
    f.edit.mockResolvedValueOnce(envelope({ commandId: uuid(20), replay: true, message: canonical }));
    await f.controller.retryEdit();
    expect(await f.edit.mock.calls[0][0].clone().text()).toBe(await f.edit.mock.calls[1][0].clone().text());
    expect(f.controller.getSnapshot().editState).toMatchObject({ draft: 'Private next draft',
        status: outcome === 'later-deleted' ? 'deleted' : 'editing', version: canonical.version });
    expect(f.controller.getSnapshot().messages.find(item => item.id === row(250).id)?.body).toBe(canonical.body);
});
