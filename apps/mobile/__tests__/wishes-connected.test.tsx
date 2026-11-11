import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { createSessionController } from '../src/auth/controller';
import { wishesCopy } from '../src/auth/wishesCopy';
import { ack, envelope, error, context, wish, uuid } from './wishes-fixtures';
it.each(['ru', 'en'] as const)('connected shared wishes use one controller and clear session data in %s', async locale => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  const wishes = jest.fn(async (r: Request) => r.method === 'GET' ? envelope({ wishes: [wish], limit: 50 }) : ack());
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    r => r.url.includes('/context') ? Promise.resolve(envelope(context)) : r.url.includes('/wishes') ? wishes(r)
      : Promise.resolve(envelope({ messages: [], nextBeforeSeq: null })), () => uuid(3));
  const ui = render(<SyntheticChatConnected controller={controller} locale={locale} />), t = wishesCopy[locale];
  await act(async () => { await controller.signIn('synthetic@example.test', 'test'); });
  fireEvent.changeText(screen.getByLabelText(t.draft), wish.title); expect(wishes).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText(t.consent));
  await act(async () => { fireEvent.press(screen.getByText(t.create)); });
  expect(screen.getByText(t.saved)).toBeTruthy(); expect(controller.wishes.getSnapshot().draft).toBe('');
  await act(async () => { fireEvent.press(screen.getByText(t.list)); });
  wishes.mockResolvedValueOnce(error('temporary', 503));
  await act(async () => { fireEvent.press(screen.getByText(t.fulfill + ' 1')); });
  wishes.mockResolvedValueOnce(ack({ ...wish, version: 2, state: 'fulfilled' }, 2));
  await act(async () => { fireEvent.press(screen.getByText(t.again)); });
  expect(screen.getByText(t.fulfilled)).toBeTruthy();
  wishes.mockResolvedValueOnce(ack({ ...wish, version: 3 }, 3));
  await act(async () => { fireEvent.press(screen.getByText(t.reopen + ' 1')); });
  expect(screen.getByText(t.open)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private draft'); fireEvent.press(screen.getByText(t.cancel));
  expect(controller.wishes.getSnapshot().draft).toBe('');
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private draft');
  await act(async () => { await controller.signOut(); });
  expect(controller.wishes.getSnapshot()).toMatchObject({ available: false, draft: '', wishes: [], pending: null });
  expect(screen.queryByLabelText(t.draft)).toBeNull(); ui.unmount();
});
it('unmount scrubs RAM and ignores a late publication acknowledgement', async () => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  let release!: (r: Response) => void;
  const pending = new Promise<Response>(r => { release = r; });
  const operation = jest.fn(() => pending);
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    r => r.url.includes('/context') ? Promise.resolve(envelope(context)) : r.url.includes('/wishes') ? operation()
      : Promise.resolve(envelope({ messages: [], nextBeforeSeq: null })), () => uuid(3));
  const ui = render(<SyntheticChatConnected controller={controller} locale="en" />);
  await act(async () => { await controller.signIn('synthetic@example.test', 'test'); });
  fireEvent.changeText(screen.getByLabelText(wishesCopy.en.draft), wish.title);
  fireEvent.changeText(screen.getByLabelText(wishesCopy.en.explanation), 'Unpublished');
  fireEvent.press(screen.getByLabelText(wishesCopy.en.consent));
  await act(async () => { fireEvent.press(screen.getByText(wishesCopy.en.create)); });
  expect(operation).toHaveBeenCalledTimes(1);
  ui.unmount();
  await act(async () => { release(ack({ ...wish, explanation: 'Unpublished' })); });
  expect(controller.wishes.getSnapshot()).toMatchObject({ available: false, wishes: [], draft: '', explanation: '', consent: false, pending: null });
});
