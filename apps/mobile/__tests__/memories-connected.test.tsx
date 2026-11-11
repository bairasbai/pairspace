import { leaveCopy } from '../src/auth/LeavePanel';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { createSessionController } from '../src/auth/controller';
import { memoriesCopy } from '../src/auth/memoriesCopy';
import { ack, envelope, error, context, memory, uuid } from './memories-fixtures';
it.each(['ru', 'en'] as const)('connected shared memories use one controller and clear session data in %s', async locale => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  const memories = jest.fn(async (r: Request) => r.method === 'GET' ? envelope({ memories: [memory], limit: 50 }) : ack());
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    r => r.url.includes('/context') ? Promise.resolve(envelope(context)) : r.url.includes('/memories') ? memories(r)
      : Promise.resolve(envelope({ messages: [], nextBeforeSeq: null })), () => uuid(3));
  const ui = render(<SyntheticChatConnected controller={controller} locale={locale} />), t = memoriesCopy[locale];
  await act(async () => { await controller.signIn('synthetic@example.test', 'test'); });
  fireEvent.changeText(screen.getByLabelText(t.draft), memory.title);
  fireEvent.changeText(screen.getByLabelText(t.localDate), memory.localDate);
  fireEvent.changeText(screen.getByLabelText(t.body), memory.body); expect(memories).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText(t.consent));
  memories.mockResolvedValueOnce(error('temporary', 503));
  await act(async () => { fireEvent.press(screen.getByText(t.create)); });
  expect(screen.getByText(t.retry)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText(t.again)); });
  expect(screen.getByText(t.saved)).toBeTruthy(); expect(controller.memories.getSnapshot().draft).toBe('');
  await act(async () => { fireEvent.press(screen.getByText(t.list)); });
  expect(screen.getByText(memory.body)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private draft'); fireEvent.press(screen.getByText(t.cancel));
  expect(controller.memories.getSnapshot().draft).toBe('');
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private draft');
  await act(async () => { await controller.signOut(); });
  expect(controller.memories.getSnapshot()).toMatchObject({ available: false, draft: '', memories: [], pending: null });
  expect(screen.queryByLabelText(t.draft)).toBeNull(); ui.unmount();
});

it('clears unresolved memories and private drafts when explicit pair closure starts', async () => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    async r => r.url.includes('/context') ? envelope(context) : r.url.includes('/memories') || r.url.includes('/leave')
      ? error('temporary', 503) : envelope({ messages: [], nextBeforeSeq: null }), () => uuid(3));
  const ui = render(<SyntheticChatConnected controller={controller} locale="en" />);
  await act(async () => { await controller.signIn('synthetic@example.test', 'test'); });
  await act(async () => {
    controller.memories.setDraft(memory.title); controller.memories.setLocalDate(memory.localDate); controller.memories.setBody(memory.body); controller.memories.setConsent(true);
    await controller.memories.create();
  });
  expect(controller.memories.getSnapshot().pending).not.toBeNull();
  fireEvent.press(screen.getByText(leaveCopy.en.begin));
  expect(screen.getByText(leaveCopy.en.consequences)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText(leaveCopy.en.confirm)); });
  expect(controller.memories.getSnapshot()).toMatchObject({ available: false, pending: null, memories: [], draft: '', localDate: '', body: '' });
  expect(screen.queryByLabelText(memoriesCopy.en.draft)).toBeNull(); ui.unmount();
});
