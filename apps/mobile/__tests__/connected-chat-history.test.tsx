import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { createSessionController } from '../src/auth/controller';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { userId: 'synthetic', sessionId: 'session' };
const context = { state: 'ready', sessionId: 'session', userId: uuid(1), coupleId: uuid(2), membershipEpoch: 1 };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status });
const page = (start = 201, count = 50, more = true) => envelope({ messages: Array.from({ length: count }, (_, i) => ({
  id: uuid(start + i + 1000), coupleId: uuid(2), senderId: uuid(1), clientId: uuid(start + i + 2000),
  seq: (start + i) * 3, body: `Synthetic ${start + i}`, version: 1, createdAt: '2026-11-10T00:00:00Z',
})), nextBeforeSeq: more ? start * 3 : null });
const settle = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
const labels = {
  en: { older: 'Load older messages', retry: 'Retry loading history', loading: 'Loading history…',
    error: 'Could not load history. You can retry.', end: 'Beginning of history.', refresh: 'Refresh history',
    window: 'Refreshing shows only the latest 50 messages. You can load older messages again.',
    cap: 'Up to 200 messages shown. Refresh history to return to the latest messages.' },
  ru: { older: 'Загрузить предыдущие сообщения', retry: 'Повторить загрузку истории', loading: 'История загружается…',
    error: 'Не удалось загрузить историю. Можно повторить запрос.', end: 'Начало истории.', refresh: 'Обновить историю',
    window: 'После обновления показаны только последние 50 сообщений. Предыдущие можно загрузить снова.',
    cap: 'Показано не более 200 сообщений. Обновите историю, чтобы вернуться к последним.' },
};
function fixture() {
  const history = jest.fn(async () => page());
  const client = { signIn: async () => identity, signOut: async () => true, getCookie: async () => 'test=cookie' };
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, client,
    request => new URL(request.url).pathname === '/v1/session/context' ? Promise.resolve(envelope(context)) : history(), () => uuid(9));
  return { history, controller, login: () => controller.signIn('synthetic@example.test', 'test') };
}
async function press(label: string) { await act(async () => { fireEvent.press(screen.getByRole('button', { name: label })); await settle(); }); }
it.each(['ru', 'en'] as const)('renders history loading, errors, retry, end, bound and reset in %s', async locale => {
  const f = fixture(); const t = labels[locale]; render(<SyntheticChatConnected controller={f.controller} locale={locale} />);
  await act(async () => { await f.login(); }); expect(screen.getByText(t.window)).toBeOnTheScreen();
  let resolve!: (response: Response) => void;
  f.history.mockReturnValueOnce(new Promise<Response>(yes => { resolve = yes; }));
  await press(t.older); expect(screen.getByText(t.loading)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: t.older })).toBeDisabled(); await press(t.older); expect(f.history).toHaveBeenCalledTimes(2);
  await act(async () => { resolve(envelope({}, 503)); await settle(); }); expect(screen.getByText(t.error)).toBeOnTheScreen();
  f.history.mockResolvedValueOnce(page(200, 1, false)); await press(t.retry); expect(screen.getByText(t.end)).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: t.older })).toBeNull(); expect(screen.getByText('Synthetic 200')).toBeOnTheScreen();
  await press(t.refresh); expect(screen.queryByText('Synthetic 200')).toBeNull();
  for (const start of [151, 101, 51]) { f.history.mockResolvedValueOnce(page(start)); await press(t.older); }
  expect(screen.getByText(t.cap)).toBeOnTheScreen(); expect(screen.queryByRole('button', { name: t.older })).toBeNull();
});
