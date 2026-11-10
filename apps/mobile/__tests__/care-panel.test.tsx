import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { CarePanel } from '../src/auth/CarePanel';
import { createSessionController } from '../src/auth/controller';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const initial = { available: true, busy: false, status: 'idle' as const, incoming: null, checked: false, error: false };
beforeEach(() => { jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true); });
afterEach(() => jest.restoreAllMocks());
it.each(['ru', 'en'] as const)('shows honest states and accessible disabled pulse in %s', async locale => {
  const onSend = jest.fn(), onRead = jest.fn();
  const props = { locale, onSend, onRead };
  const { rerender } = render(<CarePanel {...props} view={initial} />); await act(async () => {});
  const heart = locale === 'ru' ? 'Думаю о тебе' : 'Thinking of you';
  const read = locale === 'ru' ? 'Проверить знак от партнёра' : 'Check for a partner signal';
  fireEvent.press(screen.getByRole('button', { name: heart })); fireEvent.press(screen.getByRole('button', { name: read }));
  expect(onSend).toHaveBeenCalledTimes(1); expect(onRead).toHaveBeenCalledTimes(1);
  rerender(<CarePanel {...props} view={{ ...initial, busy: true, status: 'sending' }} />);
  expect(screen.getByRole('button', { name: heart })).toBeDisabled();
  expect(screen.getByRole('button', { name: heart }).props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  fireEvent.press(screen.getByRole('button', { name: heart })); expect(onSend).toHaveBeenCalledTimes(1);
  for (const status of ['retry', 'sent', 'cooldown'] as const) rerender(<CarePanel {...props} view={{ ...initial, status, checked: true, error: true }} />);
  rerender(<CarePanel {...props} view={{ ...initial, checked: true, incoming: { id: uuid(1), clientId: uuid(2), senderId: uuid(3),
    recipientId: uuid(4), coupleId: uuid(5), membershipEpoch: 1, kind: 'thinking_of_you', createdAt: '2026-11-10T00:00:00Z' } }} />);
  expect(screen.getByText(locale === 'ru' ? 'Партнёр отправил «Думаю о тебе».' : 'Your partner sent “Thinking of you”.')).toBeOnTheScreen();
  rerender(<CarePanel {...props} view={{ ...initial, available: false }} />); expect(screen.queryByRole('button')).toBeNull();
});
it.each(['ru', 'en'] as const)('connects explicit send/read and clears receiver state at logout in %s', async locale => {
  const context = { state: 'ready', sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
  const signal = { id: uuid(8), clientId: uuid(3), senderId: uuid(1), recipientId: uuid(4), coupleId: uuid(2),
    membershipEpoch: 1, kind: 'thinking_of_you', createdAt: '2026-11-10T00:00:00Z' };
  const response = (value: unknown) => new Response(JSON.stringify({ ok: true, value }));
  const care = jest.fn(async (r: Request) => response(r.method === 'POST' ? { signal, replay: false }
    : { signal: { ...signal, senderId: uuid(4), recipientId: uuid(1) } }));
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, {
    getCookie: async () => 'test=cookie', signIn: async () => ({ sessionId: 'session', userId: 'provider' }), signOut: async () => true,
  }, async r => r.url.includes('/context') ? response(context) : r.url.includes('/care-signals') ? care(r)
    : response({ messages: [], nextBeforeSeq: null }), () => uuid(3));
  render(<SyntheticChatConnected controller={controller} locale={locale} />);
  await act(async () => { await controller.signIn('test@example.test', 'synthetic'); });
  expect(care).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: locale === 'ru' ? 'Думаю о тебе' : 'Thinking of you' })); });
  expect(controller.care.getSnapshot().status).toBe('sent'); expect(controller.care.getSnapshot().incoming).toBeNull();
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: locale === 'ru' ? 'Проверить знак от партнёра' : 'Check for a partner signal' })); });
  expect(controller.care.getSnapshot().incoming?.senderId).toBe(uuid(4));
  await act(async () => { await controller.signOut(); }); expect(controller.care.getSnapshot().incoming).toBeNull();
});
