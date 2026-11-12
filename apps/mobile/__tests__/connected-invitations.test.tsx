import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { createSessionController } from './legacy-chat-window.fixture';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { userId: 'synthetic-provider', sessionId: 'synthetic-session' };
const recipient = { state: 'no_active_pair', sessionId: identity.sessionId, userId: uuid(1) };
const owner = { ...recipient, state: 'waiting_partner', coupleId: uuid(2), membershipEpoch: 1 };
const ready = { ...owner, state: 'ready' };
const token = 'A'.repeat(43);
const replacement = 'B'.repeat(42) + 'A';
const invitation = { id: uuid(4), commandId: uuid(3), status: 'pending',
  createdAt: '2026-11-10T09:00:00.000Z', expiresAt: '2026-11-11T09:00:00.000Z',
  revokedAt: null, consumedAt: null };
const response = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
const issued = () => response({ state: 'issued', invitation, token }, 201);
const previewed = () => response({ state: 'available', expiresAt: invitation.expiresAt });
const accepted = () => response({ ...ready, state: 'accepted', replayed: true });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  return { resolve, promise };
}
async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
const labels = {
  en: { read: 'Read invitation status', issue: 'Issue test invitation', revoke: 'Revoke current invitation',
    token: 'Test invitation token', preview: 'Preview test invitation', accept: 'Accept test invitation',
    consent: 'I agree to join this test space and share its chat with the other member.',
    cancel: 'Clear invitation and cancel locally', retry: 'Retry the same acceptance', signOut: 'Sign out',
    create: 'Create waiting space', refresh: 'Refresh history', draft: 'Test message' },
  ru: { read: 'Проверить статус приглашения', issue: 'Выпустить тестовое приглашение', revoke: 'Отозвать текущее приглашение',
    token: 'Токен тестового приглашения', preview: 'Проверить тестовое приглашение', accept: 'Принять тестовое приглашение',
    consent: 'Я согласен присоединиться к этому тестовому пространству и открыть его чат для обоих участников.',
    cancel: 'Очистить приглашение и отменить локально', retry: 'Повторить то же принятие', signOut: 'Выйти',
    create: 'Создать пространство ожидания', refresh: 'Обновить историю', draft: 'Тестовое сообщение' },
};
// Never dump a rendered tree or Request body containing the synthetic token on test failure.
function control(name: string) {
  const result = screen.queryByLabelText(name);
  if (!result) throw new Error('Expected synthetic invitation control is absent');
  return result;
}
async function press(name: string) {
  await act(async () => { fireEvent.press(control(name)); await settle(); });
}
async function enter(name: string, value: string) {
  await act(async () => { fireEvent.changeText(control(name), value); await settle(); });
}
function fixture(initialContext: unknown = recipient) {
  let context = initialContext;
  const client = { signIn: jest.fn(async () => identity), signOut: jest.fn(async () => true),
    getCookie: jest.fn(async () => 'better-auth.session_token=synthetic') };
  const read = jest.fn(async (_input: Request) => response({ state: 'current', invitation: null }));
  const issue = jest.fn(async (_input: Request) => issued());
  const revoke = jest.fn(async (_input: Request) => response({ state: 'revoked', revoked: true }));
  const preview = jest.fn(async (_input: Request) => previewed());
  const accept = jest.fn(async (_input: Request) => { context = ready; return accepted(); });
  const request = jest.fn((input: Request) => {
    const path = new URL(input.url).pathname;
    if (path === '/v1/session/context') return Promise.resolve(response(context));
    if (path === '/v1/spaces/waiting/invite') {
      if (input.method === 'GET') return read(input);
      return input.method === 'POST' ? issue(input) : revoke(input);
    }
    if (path === '/v1/pair-invitations/preview') return preview(input);
    if (path === '/v1/pair-invitations/accept') return accept(input);
    return Promise.resolve(response({ messages: [], nextBeforeSeq: null }));
  });
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' },
    client, request, () => uuid(3));
  return { controller, client, request, read, issue, revoke, preview, accept,
    setContext(value: unknown) { context = value; },
    async login() { await act(async () => { await controller.signIn('synthetic@example.test', 'synthetic'); }); } };
}

it.each(['ru', 'en'] as const)('wires explicit owner actions, token display and clearing in %s', async locale => {
  const f = fixture(owner); const t = labels[locale];
  render(<SyntheticChatConnected controller={f.controller} locale={locale} />);
  await f.login();
  expect(f.issue).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  expect(screen.queryByLabelText(t.token) === null).toBe(true);
  await press(t.read); expect(f.read).toHaveBeenCalledTimes(1);
  await press(t.issue); expect(f.issue).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('issued-invitation-token')?.props.children === token).toBe(true);
  await press(t.cancel);
  expect(screen.queryByTestId('issued-invitation-token') === null).toBe(true);
  expect(control(t.issue)).toBeDisabled();
  await press(t.revoke); expect(f.revoke).toHaveBeenCalledTimes(1);
  expect(control(t.issue)).toBeEnabled();
  await press(t.issue);
  expect(screen.queryByTestId('issued-invitation-token')?.props.children === token).toBe(true);
  await press(t.signOut);
  expect(screen.queryByTestId('issued-invitation-token') === null).toBe(true);
  expect(f.controller.invitations.getSnapshot().issuedToken === null).toBe(true);
});

it.each(['ru', 'en'] as const)('clears consent on token edits and accepts only after a separate visible consent action in %s', async locale => {
  const f = fixture(); const t = labels[locale];
  render(<SyntheticChatConnected controller={f.controller} locale={locale} />); await f.login();
  expect(f.preview).not.toHaveBeenCalled(); expect(f.accept).not.toHaveBeenCalled();
  await enter(t.token, token); expect(f.preview).not.toHaveBeenCalled();
  await press(t.preview); expect(f.preview).toHaveBeenCalledTimes(1);
  expect(control(t.accept)).toBeDisabled(); await press(t.accept); expect(f.accept).not.toHaveBeenCalled();
  await press(t.consent); expect(control(t.accept)).toBeEnabled(); expect(f.accept).not.toHaveBeenCalled();
  await enter(t.token, replacement);
  expect(screen.queryByRole('checkbox')).toBeNull(); expect(control(t.accept)).toBeDisabled();
  expect(f.controller.invitations.getSnapshot().consent).toBe(false);
  await press(t.preview); await press(t.consent); await press(t.accept);
  expect(f.accept).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot().phase).toBe('signed_in');
  expect(screen.queryByLabelText(t.token) === null).toBe(true);
  expect(screen.queryByLabelText(t.draft) !== null).toBe(true);
  expect(f.controller.invitations.getSnapshot().tokenInput.length).toBe(0);
});

it('retries a lost acceptance response with the same command after the server context becomes ready', async () => {
  const f = fixture(); const t = labels.en;
  f.accept.mockImplementationOnce(async () => {
    f.setContext(ready); return new Response('{}', { status: 503 });
  });
  render(<SyntheticChatConnected controller={f.controller} locale="en" />); await f.login();
  await enter(t.token, token); await press(t.preview); await press(t.consent); await press(t.accept);
  expect(control(t.retry)).toBeEnabled(); expect(control(t.preview)).toBeDisabled();
  expect(control(t.token).props.editable).toBe(false);
  expect(control(t.create)).toBeDisabled(); expect(control(t.refresh)).toBeDisabled();
  await press(t.retry);
  expect(f.accept).toHaveBeenCalledTimes(2); expect(f.preview).toHaveBeenCalledTimes(1);
  const bodies = await Promise.all(f.accept.mock.calls.map(([input]) => input.clone().text()));
  expect(bodies[0] === bodies[1]).toBe(true);
  expect(f.controller.getSnapshot().phase).toBe('signed_in');
  expect(screen.queryByLabelText(t.draft) !== null).toBe(true);
});

it('locks competing actions while busy, clears locally and suppresses a late preview', async () => {
  const f = fixture(); const pending = deferred(); const t = labels.en;
  f.preview.mockReturnValueOnce(pending.promise);
  render(<SyntheticChatConnected controller={f.controller} locale="en" />); await f.login();
  await enter(t.token, token); await press(t.preview);
  for (const label of [t.token, t.preview, t.accept, t.create, t.refresh]) {
    expect(control(label).props.accessibilityState.disabled).toBe(true);
  }
  await press(t.preview); expect(f.preview).toHaveBeenCalledTimes(1);
  await press(t.cancel);
  expect(control(t.token).props.value.length).toBe(0);
  await act(async () => { pending.resolve(previewed()); await settle(); });
  expect(screen.queryByRole('checkbox')).toBeNull(); expect(control(t.accept)).toBeDisabled();
  expect(f.controller.invitations.getSnapshot().preview).toBeNull();
});

it('clears a pending preview on logout and suppresses the old response after a fresh login', async () => {
  const f = fixture(); const pending = deferred(); const t = labels.en;
  f.preview.mockReturnValueOnce(pending.promise);
  render(<SyntheticChatConnected controller={f.controller} locale="en" />); await f.login();
  await enter(t.token, token); await press(t.preview); await press(t.signOut);
  expect(f.controller.getSnapshot().phase).toBe('signed_out');
  await f.login();
  await act(async () => { pending.resolve(previewed()); await settle(); });
  expect(control(t.token).props.value.length).toBe(0); expect(screen.queryByRole('checkbox')).toBeNull();
});

it('does not redisplay a late token when the panel is dismissed and reopened', async () => {
  const f = fixture(owner); const pending = deferred(); const t = labels.en;
  f.issue.mockReturnValueOnce(pending.promise);
  const ui = render(<SyntheticChatConnected controller={f.controller} locale="en" />); await f.login();
  await press(t.issue); expect(control(t.issue)).toBeDisabled();
  ui.unmount();
  await act(async () => { pending.resolve(issued()); await settle(); });
  render(<SyntheticChatConnected controller={f.controller} locale="en" />);
  expect(screen.queryByTestId('issued-invitation-token') === null).toBe(true);
  expect(f.controller.invitations.getSnapshot().issuedToken === null).toBe(true);
  expect(f.controller.getSnapshot().phase).toBe('signed_out');
  expect(screen.queryByLabelText(t.issue)).toBeNull();
  expect(f.controller.invitations.getSnapshot().recovery).toBe('none');
  await f.login();
  expect(control(t.issue)).not.toBeDisabled();
  expect(f.controller.invitations.getSnapshot().issuedToken).toBeNull();
});

it('clears an issued token when authoritative membership scope changes', async () => {
  const f = fixture(owner); const t = labels.en;
  render(<SyntheticChatConnected controller={f.controller} locale="en" />); await f.login(); await press(t.issue);
  expect(screen.queryByTestId('issued-invitation-token')?.props.children === token).toBe(true);
  f.setContext({ ...owner, coupleId: uuid(7), membershipEpoch: 2 });
  await press(t.refresh);
  expect(screen.queryByTestId('issued-invitation-token') === null).toBe(true);
  expect(f.controller.invitations.getSnapshot().issuedToken === null).toBe(true);
});
