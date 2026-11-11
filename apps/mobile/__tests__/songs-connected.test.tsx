import { leaveCopy } from '../src/auth/LeavePanel';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { createSessionController } from '../src/auth/controller';
import { songsCopy } from '../src/auth/songsCopy';
import { ack, envelope, error, context, song, uuid } from './songs-fixtures';
it.each(['ru', 'en'] as const)('connected shared songs use one controller and clear session data in %s', async locale => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  const songs = jest.fn(async (r: Request) => r.method === 'GET' ? envelope({ songs: [song], limit: 50 }) : ack());
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    r => r.url.includes('/context') ? Promise.resolve(envelope(context)) : r.url.includes('/songs') ? songs(r)
      : Promise.resolve(envelope({ messages: [], nextBeforeSeq: null })), () => uuid(3));
  const ui = render(<SyntheticChatConnected controller={controller} locale={locale} />), t = songsCopy[locale];
  await act(async () => { await controller.signIn('synthetic@example.test', 'test'); });
  fireEvent.changeText(screen.getByLabelText(t.draft), song.title);
  fireEvent.changeText(screen.getByLabelText(t.explanation), song.explanation); expect(songs).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText(t.consent));
  songs.mockResolvedValueOnce(error('temporary', 503));
  await act(async () => { fireEvent.press(screen.getByText(t.create)); });
  expect(screen.getByText(t.retry)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText(t.again)); });
  expect(screen.getByText(t.saved)).toBeTruthy(); expect(controller.songs.getSnapshot().draft).toBe('');
  await act(async () => { fireEvent.press(screen.getByText(t.list)); });
  expect(screen.getByText(song.explanation)).toBeTruthy();
  fireEvent.press(screen.getByText(t.edit));
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Corrected title');
  fireEvent.press(screen.getByLabelText(t.consent));
  songs.mockResolvedValueOnce(ack({ ...song, title: 'Corrected title', version: 2 }));
  await act(async () => { fireEvent.press(screen.getByText(t.saveEdit)); });
  expect(songs.mock.calls.at(-1)![0].method).toBe('PATCH');
  expect(controller.songs.getSnapshot()).toMatchObject({ editing: null, songs: [{ title: 'Corrected title', version: 2 }] });
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private draft'); fireEvent.press(screen.getByText(t.cancel));
  expect(controller.songs.getSnapshot().draft).toBe('');
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private draft');
  await act(async () => { await controller.signOut(); });
  expect(controller.songs.getSnapshot()).toMatchObject({ available: false, draft: '', songs: [], pending: null });
  expect(screen.queryByLabelText(t.draft)).toBeNull(); ui.unmount();
});

it('clears unresolved songs and private drafts when explicit pair closure starts', async () => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    async r => r.url.includes('/context') ? envelope(context) : r.url.includes('/songs') || r.url.includes('/leave')
      ? error('temporary', 503) : envelope({ messages: [], nextBeforeSeq: null }), () => uuid(3));
  const ui = render(<SyntheticChatConnected controller={controller} locale="en" />);
  await act(async () => { await controller.signIn('synthetic@example.test', 'test'); });
  await act(async () => {
    controller.songs.setDraft(song.title); controller.songs.setExplanation(song.explanation); controller.songs.setConsent(true);
    await controller.songs.create();
  });
  expect(controller.songs.getSnapshot().pending).not.toBeNull();
  fireEvent.press(screen.getByText(leaveCopy.en.begin));
  expect(screen.getByText(leaveCopy.en.consequences)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText(leaveCopy.en.confirm)); });
  expect(controller.songs.getSnapshot()).toMatchObject({ available: false, pending: null, songs: [], draft: '', explanation: '' });
  expect(screen.queryByLabelText(songsCopy.en.draft)).toBeNull(); ui.unmount();
});
