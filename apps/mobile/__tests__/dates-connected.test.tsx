import { leaveCopy } from '../src/auth/LeavePanel';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { createSessionController } from '../src/auth/controller';
import { datesCopy } from '../src/auth/datesCopy';
import { ack, envelope, error, context, date, uuid } from './dates-fixtures';
it.each(['ru', 'en'] as const)('connected shared dates use one controller and clear session data in %s', async locale => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  const dates = jest.fn(async (r: Request) => r.method === 'GET' ? envelope({ dates: [date], limit: 50 })
    : r.method === 'PATCH' ? ack({ ...date, title: 'Edited together', version: 2 }) : ack());
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    r => r.url.includes('/context') ? Promise.resolve(envelope(context)) : r.url.includes('/dates') ? dates(r)
      : Promise.resolve(envelope({ messages: [], nextBeforeSeq: null })), () => uuid(3));
  const ui = render(<SyntheticChatConnected controller={controller} locale={locale} />), t = datesCopy[locale];
  await act(async () => { await controller.signIn('synthetic@example.test', 'test'); });
  fireEvent.changeText(screen.getByLabelText(t.draft), date.title);
  fireEvent.changeText(screen.getByLabelText(t.localDate), date.localDate);
  fireEvent.changeText(screen.getByLabelText(t.timezone), date.timezone); expect(dates).not.toHaveBeenCalled();
  dates.mockResolvedValueOnce(error('temporary', 503));
  await act(async () => { fireEvent.press(screen.getByText(t.create)); });
  expect(screen.getByText(t.retry)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText(t.again)); });
  expect(screen.getByText(t.saved)).toBeTruthy(); expect(controller.dates.getSnapshot().draft).toBe('');
  await act(async () => { fireEvent.press(screen.getByText(t.list)); });
  expect(screen.getByText(date.localDate + ' · ' + date.timezone)).toBeTruthy();
  fireEvent.press(screen.getByText(t.edit));
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Edited together');
  expect(screen.getByText(t.editNotice)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText(t.saveEdit)); });
  expect(screen.getByText('Edited together')).toBeTruthy();
  expect(controller.dates.getSnapshot().editing).toBeNull();
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private draft'); fireEvent.press(screen.getByText(t.cancel));
  expect(controller.dates.getSnapshot().draft).toBe('');
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Unsent private draft');
  await act(async () => { await controller.signOut(); });
  expect(controller.dates.getSnapshot()).toMatchObject({ available: false, draft: '', dates: [], pending: null });
  expect(screen.queryByLabelText(t.draft)).toBeNull(); ui.unmount();
});

it('clears unresolved dates and private drafts when explicit pair closure starts', async () => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  const controller = createSessionController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, client,
    async r => r.url.includes('/context') ? envelope(context) : r.url.includes('/dates') || r.url.includes('/leave')
      ? error('temporary', 503) : envelope({ messages: [], nextBeforeSeq: null }), () => uuid(3));
  const ui = render(<SyntheticChatConnected controller={controller} locale="en" />);
  await act(async () => { await controller.signIn('synthetic@example.test', 'test'); });
  await act(async () => {
    controller.dates.setDraft(date.title); controller.dates.setLocalDate(date.localDate); controller.dates.setTimezone(date.timezone);
    await controller.dates.create();
  });
  expect(controller.dates.getSnapshot().pending).not.toBeNull();
  fireEvent.press(screen.getByText(leaveCopy.en.begin));
  expect(screen.getByText(leaveCopy.en.consequences)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText(leaveCopy.en.confirm)); });
  expect(controller.dates.getSnapshot()).toMatchObject({ available: false, pending: null, dates: [], draft: '', localDate: '', timezone: '' });
  expect(screen.queryByLabelText(datesCopy.en.draft)).toBeNull(); ui.unmount();
});
