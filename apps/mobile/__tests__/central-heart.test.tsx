import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Alert } from 'react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import { PairspaceApp } from '../App';
import { createSessionController } from './legacy-chat-window.fixture';
import { copy, type Locale } from '../src/copy';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { sessionId: 'synthetic-session', userId: 'synthetic-provider' };
const context = { state: 'ready', sessionId: identity.sessionId, userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
const signal = { id: uuid(8), clientId: uuid(3), senderId: uuid(1), recipientId: uuid(4),
  coupleId: uuid(2), membershipEpoch: 1, kind: 'thinking_of_you', createdAt: '2026-11-10T00:00:00Z' };
const ack = () => envelope({ signal, replay: false });
const labels = {
  ru: {
    idle: 'Нажмите сердце, чтобы отправить знак заботы.', sending: 'Отправляется…',
    retry: 'Подтверждение не получено. Нажмите сердце для повтора того же знака без дубля.',
    sent: 'Сохранено на сервере. Доставка и прочтение не подтверждены.',
    cooldown: 'Новый знак можно отправлять не чаще раза в минуту. Попробуйте позже.',
    unavailable: 'Тестовая функция заботы недоступна на этом сервере.',
    signedOut: 'Войдите в тестовый аккаунт во вкладке «Чат».',
    waiting: 'Знак заботы станет доступен после присоединения партнёра.',
    blocked: 'Для знака заботы нужна подтверждённая активная пара. Откройте «Чат».',
    busy: 'Проверяем тестовый аккаунт…', read: 'Проверить знак от партнёра', logout: 'Выйти',
  },
  en: {
    idle: 'Tap the heart to send a care signal.', sending: 'Sending…',
    retry: 'No acknowledgement received. Tap the heart to retry the same signal without a duplicate.',
    sent: 'Saved on the server. Delivery and reading are not confirmed.',
    cooldown: 'You can send a new signal once per minute. Try again later.',
    unavailable: 'The test care feature is unavailable on this server.',
    signedOut: 'Sign in to a test account in the Chat tab.',
    waiting: 'Care signals become available when your partner joins.',
    blocked: 'A verified active pair is required. Open Chat.',
    busy: 'Checking the test account…', read: 'Check for a partner signal', logout: 'Sign out',
  },
};
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function settle() { for (let n = 0; n < 80; n++) await Promise.resolve(); }
async function press(name: string, role: 'button' | 'tab' | 'radio' = 'button') {
  await act(async () => { fireEvent.press(screen.getByRole(role, { name })); await settle(); });
}
async function chooseLocale(locale: Locale) {
  if (locale === 'en') {
    await press(copy.ru.us, 'tab'); await press('English', 'radio'); await press(copy.en.today, 'tab');
  }
}
function fixture() {
  const client = { getCookie: jest.fn(async () => 'test=synthetic'), signIn: jest.fn(async () => identity),
    signOut: jest.fn(async () => true) };
  const discovery = jest.fn(async (_r: Request) => envelope(context));
  const care = jest.fn(async (_r: Request) => ack());
  const request = jest.fn((r: Request) => r.url.includes('/context') ? discovery(r)
    : r.url.includes('/care-signals') ? care(r) : Promise.resolve(envelope({ messages: [], nextBeforeSeq: null })));
  const commandId = jest.fn(() => uuid(3));
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client, request, commandId);
  return { controller, client, discovery, care, request, commandId,
    async login() { await act(async () => { await controller.signIn('synthetic@example.test', 'synthetic'); }); } };
}
beforeEach(() => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each(['ru', 'en'] as const)('keeps one heart and the same authenticated store across every tab in %s', async locale => {
  const f = fixture(); const dispose = jest.spyOn(f.controller, 'dispose');
  render(<PairspaceApp syntheticController={f.controller} />); await chooseLocale(locale); await f.login();
  expect(f.care).not.toHaveBeenCalled();
  await act(async () => { f.controller.setDraft('Synthetic draft retained across tabs'); });
  for (const tab of ['chat', 'together', 'us', 'today', 'chat'] as const) {
    await press(copy[locale][tab], 'tab');
    expect(screen.getAllByRole('button', { name: copy[locale].heart })).toHaveLength(1);
    expect(f.controller.getSnapshot().phase).toBe('signed_in');
    expect(f.controller.getSnapshot().draft).toBe('Synthetic draft retained across tabs');
    expect(dispose).not.toHaveBeenCalled();
    await press(copy[locale].heart);
    expect(screen.getAllByText(labels[locale].sent)).toHaveLength(1);
    expect(f.controller.care.getSnapshot().status).toBe('sent');
  }
  expect(f.care).toHaveBeenCalledTimes(5);
  expect(f.care.mock.calls.every(([r]) => r.method === 'POST')).toBe(true);
  expect(screen.getByRole('button', { name: labels[locale].read })).toBeOnTheScreen();
  expect(Alert.alert).not.toHaveBeenCalled();
});

it.each(['ru', 'en'] as const)('blocks double taps and retries the same lost acknowledgement after changing tabs in %s', async locale => {
  const f = fixture(); const pending = deferred();
  render(<PairspaceApp syntheticController={f.controller} />); await chooseLocale(locale); await f.login();
  f.care.mockReturnValueOnce(pending.promise);
  await act(async () => {
    const heart = screen.getByRole('button', { name: copy[locale].heart });
    fireEvent.press(heart); fireEvent.press(heart); await settle();
  });
  expect(f.care).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: copy[locale].heart })).toBeDisabled();
  expect(screen.getByRole('button', { name: copy[locale].heart }).props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  expect(screen.getByText(labels[locale].sending)).toBeOnTheScreen();
  await press(copy[locale].chat, 'tab'); await press(copy[locale].heart);
  expect(f.care).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(envelope({}, 503)); await settle(); });
  expect(screen.getByText(labels[locale].retry)).toBeOnTheScreen();
  await press(copy[locale].together, 'tab'); await press(copy[locale].heart);
  expect(f.care).toHaveBeenCalledTimes(2);
  const [first, second] = f.care.mock.calls.map(([r]) => r);
  expect(first.headers.get('Idempotency-Key')).toBe(second.headers.get('Idempotency-Key'));
  expect(await first.json()).toEqual(await second.json());
  expect(f.commandId).toHaveBeenCalledTimes(1);
  expect(screen.getByText(labels[locale].sent)).toBeOnTheScreen();
});

it('changes locale without resetting the pending command or its status', async () => {
  const f = fixture(); render(<PairspaceApp syntheticController={f.controller} />); await f.login();
  f.care.mockRejectedValueOnce(new Error('Synthetic lost ACK')); await press(copy.ru.heart);
  const state = f.controller.care.getSnapshot();
  await chooseLocale('en'); expect(f.controller.care.getSnapshot()).toBe(state);
  expect(screen.getByText(labels.en.retry)).toBeOnTheScreen();
  expect(screen.queryByText(labels.ru.retry)).toBeNull();
  await press(copy.en.heart); expect(f.commandId).toHaveBeenCalledTimes(1);
  expect(screen.getByText(labels.en.sent)).toBeOnTheScreen();
});

it.each(['ru', 'en'] as const)('keeps default preview heart local in %s', async locale => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  render(<PairspaceApp />); await chooseLocale(locale); await press(copy[locale].heart);
  expect(Alert.alert).toHaveBeenLastCalledWith(copy[locale].heart, copy[locale].heartNotice, [{ text: copy[locale].close }]);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['ru', 'en'] as const)('explains signed-out, waiting, blocked and busy disabled states in %s', async locale => {
  const f = fixture(); render(<PairspaceApp syntheticController={f.controller} />); await chooseLocale(locale);
  expect(screen.getByText(labels[locale].signedOut)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: copy[locale].heart })).toBeDisabled();
  await press(copy[locale].heart); expect(f.request).not.toHaveBeenCalled();
  const pending = deferred(); f.discovery.mockReturnValueOnce(pending.promise);
  let signingIn!: Promise<void>;
  await act(async () => { signingIn = f.controller.signIn('synthetic@example.test', 'synthetic'); await settle(); });
  expect(screen.getByText(labels[locale].busy)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: copy[locale].heart })).toBeDisabled();
  await press(copy[locale].heart);
  await act(async () => { pending.resolve(envelope({ ...context, state: 'waiting_partner' })); await signingIn; });
  expect(screen.getByText(labels[locale].waiting)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: copy[locale].heart })).toBeDisabled();
  await press(copy[locale].heart); await act(async () => { await f.controller.signOut(); });
  f.discovery.mockResolvedValueOnce(envelope({}, 403)); await f.login();
  expect(screen.getByText(labels[locale].blocked)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: copy[locale].heart })).toBeDisabled();
  await press(copy[locale].heart); expect(f.care).not.toHaveBeenCalled();
});

it.each(['ru', 'en'] as const)('renders cooldown, unavailable and malformed-response states honestly in %s', async locale => {
  const f = fixture(); render(<PairspaceApp syntheticController={f.controller} />); await chooseLocale(locale); await f.login();
  f.care.mockResolvedValueOnce(envelope({}, 429)); await press(copy[locale].heart);
  expect(screen.getByText(labels[locale].cooldown)).toBeOnTheScreen();
  expect(screen.queryByText(labels[locale].sent)).toBeNull();
  f.care.mockResolvedValueOnce(envelope({ signal: { ...signal, coupleId: uuid(99) }, replay: false }));
  await press(copy[locale].heart); expect(screen.getByText(labels[locale].retry)).toBeOnTheScreen();
  expect(screen.queryByText(labels[locale].sent)).toBeNull();
  f.care.mockResolvedValueOnce(envelope({}, 404)); await press(copy[locale].heart);
  expect(screen.getByText(labels[locale].unavailable)).toBeOnTheScreen();
  expect(screen.queryByText(labels[locale].sent)).toBeNull();
});

it.each(['unmount', 'logout'] as const)('discards a pending result after %s without leaking session state', async action => {
  const f = fixture(); const pending = deferred();
  const ui = render(<PairspaceApp syntheticController={f.controller} />); await f.login();
  f.care.mockReturnValueOnce(pending.promise); await press(copy.ru.heart);
  if (action === 'unmount') await act(async () => { ui.unmount(); await settle(); });
  else { await press(copy.ru.chat, 'tab'); await press(labels.ru.logout); }
  const scrubbed = f.controller.care.getSnapshot();
  expect(scrubbed.available).toBe(false); expect(scrubbed.incoming).toBeNull(); expect(scrubbed.status).toBe('idle');
  expect(f.controller.getSnapshot().phase).toBe('signed_out');
  expect(f.care.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => { pending.resolve(ack()); await settle(); });
  expect(f.controller.care.getSnapshot()).toBe(scrubbed);
  expect(f.client.signOut).toHaveBeenCalledTimes(action === 'logout' ? 2 : 1);
});

it('disposes only the replaced controller and ignores its late result', async () => {
  const old = fixture(); const next = fixture(); const pending = deferred();
  const oldDispose = jest.spyOn(old.controller, 'dispose'); const nextDispose = jest.spyOn(next.controller, 'dispose');
  const ui = render(<PairspaceApp syntheticController={old.controller} />); await old.login(); await next.login();
  old.care.mockReturnValueOnce(pending.promise); await press(copy.ru.heart);
  const nextState = next.controller.getSnapshot(); const nextCare = next.controller.care.getSnapshot();
  await act(async () => { ui.rerender(<PairspaceApp syntheticController={next.controller} />); await settle(); });
  expect(oldDispose).toHaveBeenCalledTimes(1); expect(nextDispose).not.toHaveBeenCalled();
  expect(old.controller.getSnapshot().phase).toBe('signed_out');
  expect(old.care.mock.calls[0][0].signal.aborted).toBe(true);
  expect(next.controller.getSnapshot()).toBe(nextState); expect(next.controller.care.getSnapshot()).toBe(nextCare);
  await act(async () => { pending.resolve(ack()); await settle(); });
  expect(next.controller.care.getSnapshot()).toBe(nextCare);
  expect(screen.getByText(labels.ru.idle)).toBeOnTheScreen();
  await press(copy.ru.heart); expect(next.care).toHaveBeenCalledTimes(1);
  await act(async () => { ui.unmount(); await settle(); }); expect(nextDispose).toHaveBeenCalledTimes(1);
});

it('preserves a preauthenticated controller during StrictMode effect replay and disposes on actual unmount', async () => {
  const f = fixture(); await f.login(); const dispose = jest.spyOn(f.controller, 'dispose');
  const before = f.controller.getSnapshot();
  const ui = render(<StrictMode><PairspaceApp syntheticController={f.controller} /></StrictMode>);
  await act(async () => { await settle(); });
  expect(dispose).not.toHaveBeenCalled(); expect(f.controller.getSnapshot()).toBe(before);
  await press(copy.ru.chat, 'tab'); await press(copy.ru.today, 'tab'); await press(copy.ru.heart);
  expect(f.care).toHaveBeenCalledTimes(1); expect(screen.getByText(labels.ru.sent)).toBeOnTheScreen();
  await act(async () => { ui.unmount(); await settle(); });
  expect(dispose).toHaveBeenCalledTimes(1); expect(f.controller.getSnapshot().phase).toBe('signed_out');
  expect(f.client.signOut).toHaveBeenCalledTimes(1);
});
