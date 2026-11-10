import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { createSessionController } from '../src/auth/controller';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { userId: 'synthetic-provider', sessionId: 'synthetic-session' };
const context = { state: 'ready', sessionId: identity.sessionId, userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
const page = () => envelope({ messages: [], nextBeforeSeq: null });
const ack = (body: string, id = uuid(3)) => envelope({ replay: true, message: {
  id: uuid(4), coupleId: uuid(2), senderId: uuid(1), clientId: id, seq: 1,
  body, version: 1, createdAt: '2026-11-10T00:00:00.000Z',
} });
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function settle() { for (let n = 0; n < 80; n++) await Promise.resolve(); }
async function press(name: string) {
  await act(async () => { fireEvent.press(screen.getByRole('button', { name })); await settle(); });
}
const labels = {
  en: { draft: 'Test message', send: 'Send test message', retry: 'Retry the same message',
    sending: 'Sending…', uncertain: 'No confirmation received. Retry the same message without a duplicate.',
    sent: 'Sent to the server. Delivery and reading are not confirmed.',
    network: 'Connection temporarily unavailable. Draft kept until you leave this screen.',
    refresh: 'Refresh history', signOut: 'Sign out' },
  ru: { draft: 'Тестовое сообщение', send: 'Отправить тестовое сообщение', retry: 'Повторить то же сообщение',
    sending: 'Отправляется…', uncertain: 'Подтверждение не получено. Повторите то же сообщение без дубля.',
    sent: 'Отправлено на сервер. Доставка и прочтение не подтверждены.',
    network: 'Связь временно недоступна. Черновик сохранён до выхода из экрана.',
    refresh: 'Обновить историю', signOut: 'Выйти' },
};
function fixture() {
  const client = { signIn: jest.fn(async () => identity), signOut: jest.fn(async () => true),
    getCookie: jest.fn(async () => 'better-auth.session_token=synthetic') };
  const discovery = jest.fn(async (_request: Request) => envelope(context));
  const history = jest.fn(async (_request: Request) => page());
  const post = jest.fn(async (_request: Request) => ack('Synthetic original'));
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    request => new URL(request.url).pathname === '/v1/session/context' ? discovery(request)
      : request.method === 'POST' ? post(request) : history(request), () => uuid(3));
  return { controller, client, discovery, history, post,
    async login() { await act(async () => { await controller.signIn('synthetic@example.test', 'synthetic'); }); } };
}

it.each(['ru', 'en'] as const)('shows sending, immutable explicit retry and server-only sent confirmation in %s', async locale => {
  const f = fixture(); const t = labels[locale]; const pending = deferred();
  render(<SyntheticChatConnected controller={f.controller} locale={locale} />); await f.login();
  f.post.mockReturnValueOnce(pending.promise);
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Synthetic original');
  await press(t.send);
  expect(screen.getByText(t.sending)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: t.send })).toBeDisabled();
  await press(t.send); expect(f.post).toHaveBeenCalledTimes(1);
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Synthetic edited');
  await act(async () => { pending.resolve(envelope({}, 503)); await settle(); });
  expect(screen.getByText(t.uncertain)).toBeOnTheScreen();
  expect(screen.queryByText(t.sent)).toBeNull();
  expect(screen.getByLabelText(t.draft)).toHaveDisplayValue('Synthetic edited');
  expect(screen.getByText('Synthetic original')).toBeOnTheScreen();
  f.history.mockRejectedValueOnce(new Error('Synthetic history outage'));
  await press(t.retry);
  expect(f.post).toHaveBeenCalledTimes(2);
  const requests = f.post.mock.calls.map(([request]) => request);
  expect(requests[0].headers.get('idempotency-key')).toBe(requests[1].headers.get('idempotency-key'));
  expect(await requests[0].json()).toEqual(await requests[1].json());
  expect(screen.getByText(t.sent)).toBeOnTheScreen();
  expect(screen.getByText(t.network)).toBeOnTheScreen();
  expect(screen.getByLabelText(t.draft)).toHaveDisplayValue('Synthetic edited');
  expect(screen.queryByRole('button', { name: t.retry })).toBeNull();
});

it.each(['ru', 'en'] as const)('keeps the draft on transient discovery failure and permits explicit recovery in %s', async locale => {
  const f = fixture(); const t = labels[locale];
  render(<SyntheticChatConnected controller={f.controller} locale={locale} />); await f.login();
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Synthetic original');
  f.discovery.mockRejectedValueOnce(new Error('Synthetic context outage'));
  await press(t.send);
  expect(f.post).not.toHaveBeenCalled();
  expect(screen.getByLabelText(t.draft)).toHaveDisplayValue('Synthetic original');
  expect(screen.getByText(t.network)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: t.retry })).not.toBeDisabled();
  await press(t.retry);
  expect(f.post).toHaveBeenCalledTimes(1);
  expect(screen.getByText(t.sent)).toBeOnTheScreen();
  expect(screen.getByLabelText(t.draft)).toHaveDisplayValue('');
});

it.each(['unmount', 'logout', 'revocation'] as const)('scrubs a pending command on %s and ignores a late ACK', async action => {
  const f = fixture(); const t = labels.en; const pending = deferred();
  const ui = render(<SyntheticChatConnected controller={f.controller} locale="en" />); await f.login();
  f.post.mockReturnValueOnce(pending.promise);
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Synthetic original');
  await press(t.send);
  expect(f.post).toHaveBeenCalledTimes(1);
  if (action === 'unmount') ui.unmount();
  else if (action === 'logout') await press(t.signOut);
  else {
    f.discovery.mockResolvedValueOnce(envelope({}, 401));
    await press(t.refresh);
  }
  const scrubbed = f.controller.getSnapshot();
  expect(scrubbed.draft).toBe(''); expect(scrubbed.messages).toEqual([]); expect(scrubbed.outgoing).toBeUndefined();
  expect(f.post.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => { pending.resolve(ack('Synthetic original')); await settle(); });
  expect(f.controller.getSnapshot()).toBe(scrubbed);
  expect(f.client.signOut).toHaveBeenCalledTimes(action === 'logout' ? 2 : 1);
  if (action === 'unmount') {
    render(<SyntheticChatConnected controller={f.controller} locale="en" />);
    expect(screen.queryByLabelText(t.draft)).toBeNull();
    expect(screen.queryByText('Synthetic original')).toBeNull();
    await f.login();
    expect(screen.getByLabelText(t.draft)).toHaveDisplayValue('');
  }
});

it('remains usable after React StrictMode replays mount effects without externally signing out', async () => {
  const f = fixture(); const t = labels.en;
  const dispose = jest.spyOn(f.controller, 'dispose');
  const ui = render(<StrictMode><SyntheticChatConnected controller={f.controller} locale="en" /></StrictMode>);
  // This assertion proves a real effect cleanup/setup replay, rather than testing a plain mount.
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(f.client.signOut).not.toHaveBeenCalled();
  expect(f.controller.getSnapshot().phase).toBe('signed_out');
  await f.login();
  expect(f.client.signIn).toHaveBeenCalledTimes(1);
  expect(f.client.signOut).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText(t.draft)).toHaveDisplayValue('');
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Synthetic original');
  await press(t.send);
  expect(screen.getByText(t.sent)).toBeOnTheScreen();
  expect(f.post).toHaveBeenCalledTimes(1);
  ui.unmount();
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(f.client.signOut).toHaveBeenCalledTimes(1);
  expect(f.controller.getSnapshot().phase).toBe('signed_out');
});

it('cleans up only the replaced controller and never overwrites the replacement with a late response', async () => {
  const old = fixture(); const next = fixture(); const t = labels.en; const pending = deferred();
  const oldDispose = jest.spyOn(old.controller, 'dispose');
  const nextDispose = jest.spyOn(next.controller, 'dispose');
  const ui = render(<SyntheticChatConnected controller={old.controller} locale="en" />);
  await old.login();
  old.post.mockReturnValueOnce(pending.promise);
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Synthetic original');
  await press(t.send);
  await next.login();
  next.controller.setDraft('Synthetic replacement draft');
  const replacement = next.controller.getSnapshot();
  ui.rerender(<SyntheticChatConnected controller={next.controller} locale="en" />);
  expect(oldDispose).toHaveBeenCalledTimes(1);
  expect(nextDispose).not.toHaveBeenCalled();
  expect(old.controller.getSnapshot().phase).toBe('signed_out');
  expect(next.controller.getSnapshot()).toBe(replacement);
  expect(screen.getByLabelText(t.draft)).toHaveDisplayValue('Synthetic replacement draft');
  expect(old.post.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => { pending.resolve(ack('Synthetic original')); await settle(); });
  expect(next.controller.getSnapshot()).toBe(replacement);
  expect(screen.queryByText('Synthetic original')).toBeNull();
  expect(old.client.signOut).toHaveBeenCalledTimes(1);
  expect(next.client.signOut).toHaveBeenCalledTimes(1);
  ui.unmount();
  expect(nextDispose).toHaveBeenCalledTimes(1);
  expect(next.controller.getSnapshot().draft).toBe('');
});
