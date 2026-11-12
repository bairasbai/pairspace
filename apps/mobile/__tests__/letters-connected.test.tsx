import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { createSessionController } from './legacy-chat-window.fixture';
import { lettersCopy } from '../src/auth/lettersCopy';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { state: 'ready', sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const meta = { id: uuid(9), clientId: uuid(3), senderId: uuid(4), recipientId: uuid(1), coupleId: uuid(2), membershipEpoch: 1, releaseAt: null, releaseTimezone: null, availability: 'available' as const, createdAt: '2026-11-10T00:00:00Z' };
const envelope = (value: unknown) => new Response(JSON.stringify({ ok: true, value }));
it.each(['ru', 'en'] as const)('connected letters keep draft private and clear it on logout in %s', async locale => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  const letters = jest.fn(async (r: Request) => {
    const payload = r.method === 'POST' ? await r.clone().json() : null;
    return r.method === 'POST'
    ? envelope({ letter: { ...meta, senderId: uuid(1), recipientId: uuid(4), body: 'Draft', ...(payload.release_at ? { releaseAt: '2027-01-15T06:00:00.000Z', releaseTimezone: 'Europe/Moscow', availability: 'sealed' } : {}) }, replay: false })
    : r.url.includes('/letters/') ? envelope({ letter: { ...meta, body: 'Partner text' } }) : envelope({ letters: [meta] }); });
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    r => r.url.includes('/context') ? Promise.resolve(envelope(context)) : r.url.includes('/letters') ? letters(r)
      : Promise.resolve(envelope({ messages: [], nextBeforeSeq: null })), () => uuid(3));
  const ui = render(<SyntheticChatConnected locale={locale} controller={controller} />), t = lettersCopy[locale];
  await act(async () => { await controller.signIn('fake@example.test', 'test'); });
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Draft'); expect(letters).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByText(t.send)); });
  expect(screen.getByText(t.sent)).toBeTruthy(); expect(controller.letters.getSnapshot().draft).toBe('');
  await act(async () => { fireEvent.press(screen.getByText(t.list)); });
  expect(screen.queryByText('Partner text')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByText(t.open + ' 1')); }); expect(screen.getByText('Partner text')).toBeTruthy();
  fireEvent.press(screen.getByText(t.close)); expect(screen.queryByText('Partner text')).toBeNull();
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Draft');
  fireEvent.changeText(screen.getByLabelText(t.releaseAt), '2027-01-15T09:00:00+03:00');
  fireEvent.changeText(screen.getByLabelText(t.releaseTimezone), 'Europe/Moscow');
  await act(async () => { fireEvent.press(screen.getByText(t.sendLater)); });
  expect(controller.letters.getSnapshot().status).toBe('sent');
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private');
  await act(async () => { await controller.signOut(); });
  expect(controller.letters.getSnapshot()).toMatchObject({ available: false, draft: '', releaseAtInput: '', releaseTimezoneInput: '', letters: [], opened: null });
  expect(screen.queryByLabelText(t.draft)).toBeNull(); ui.unmount();
});
