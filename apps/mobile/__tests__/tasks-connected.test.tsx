import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { createSessionController } from '../src/auth/controller';
import { tasksCopy } from '../src/auth/tasksCopy';
import { ack, envelope, error, context, task, uuid } from './tasks-fixtures';
it.each(['ru', 'en'] as const)('connected shared tasks use one controller and clear session data in %s', async locale => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  const tasks = jest.fn(async (r: Request) => r.method === 'GET' ? envelope({ tasks: [task], limit: 50 }) : ack());
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    r => r.url.includes('/context') ? Promise.resolve(envelope(context)) : r.url.includes('/tasks') ? tasks(r)
      : Promise.resolve(envelope({ messages: [], nextBeforeSeq: null })), () => uuid(3));
  const ui = render(<SyntheticChatConnected controller={controller} locale={locale} />), t = tasksCopy[locale];
  await act(async () => { await controller.signIn('synthetic@example.test', 'test'); });
  fireEvent.changeText(screen.getByLabelText(t.draft), task.title); expect(tasks).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByText(t.create)); });
  expect(screen.getByText(t.saved)).toBeTruthy(); expect(controller.tasks.getSnapshot().draft).toBe('');
  await act(async () => { fireEvent.press(screen.getByText(t.list)); });
  tasks.mockResolvedValueOnce(error('temporary', 503));
  await act(async () => { fireEvent.press(screen.getByText(t.complete + ' 1')); });
  tasks.mockResolvedValueOnce(ack({ ...task, version: 2, state: 'completed' }, 2));
  await act(async () => { fireEvent.press(screen.getByText(t.again)); });
  expect(screen.getByText(t.completed)).toBeTruthy();
  tasks.mockResolvedValueOnce(ack({ ...task, version: 3 }, 3));
  await act(async () => { fireEvent.press(screen.getByText(t.reopen + ' 1')); });
  expect(screen.getByText(t.open)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private draft'); fireEvent.press(screen.getByText(t.cancel));
  expect(controller.tasks.getSnapshot().draft).toBe('');
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private draft');
  await act(async () => { await controller.signOut(); });
  expect(controller.tasks.getSnapshot()).toMatchObject({ available: false, draft: '', tasks: [], pending: null });
  expect(screen.queryByLabelText(t.draft)).toBeNull(); ui.unmount();
});
