import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { createSessionController } from '../src/auth/controller';
import { BlindPanel } from '../src/auth/BlindPanel';
import { emptyBlind } from '../src/auth/blind-state';
import { blindCopy } from '../src/auth/blindCopy';
import { ack, round, envelope, error, context, uuid } from './blind-fixtures';
it.each(['ru','en'] as const)('explicit connected flow and immutable answer in %s', async locale => {
  const client = { getCookie: jest.fn(async () => 'test=cookie'), signIn: jest.fn(async () => ({ sessionId: 'session', userId: 'provider' })), signOut: jest.fn(async () => true) };
  const api = jest.fn(async (_r: Request) => ack());
  const controller = createSessionController({ mode:'synthetic-loopback', baseURL:'http://127.0.0.1:8787' },client,
    r => r.url.includes('/context') ? Promise.resolve(envelope(context)) : r.url.includes('/blind-round') ? api(r) : Promise.resolve(envelope({ messages:[],nextBeforeSeq:null })), () => uuid(3));
  const ui = render(<SyntheticChatConnected controller={controller} locale={locale} />), t=blindCopy[locale];
  await act(async () => { await controller.signIn('synthetic@example.test','test'); }); expect(api).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByText(t.open)); });
  fireEvent.changeText(screen.getByLabelText(t.draft),'Small joy');
  fireEvent(screen.getByLabelText(t.consent),'valueChange',true);
  api.mockResolvedValueOnce(error('temporary',503));
  await act(async () => { fireEvent.press(screen.getByText(t.submit)); });
  api.mockResolvedValueOnce(ack({ ...round, ownAnswer:'Small joy' },true));
  await act(async () => { fireEvent.press(screen.getByText(t.again)); }); expect(screen.queryByLabelText(t.draft)).toBeNull();
  api.mockResolvedValueOnce(envelope({ round: { ...round, ownAnswer:'Small joy',partnerAnswer:'A walk',revealed:true } }));
  await act(async () => { fireEvent.press(screen.getByText(t.read)); }); expect(screen.getByText('A walk')).toBeTruthy();
  await act(async () => { await controller.signOut(); }); expect(screen.queryByText(t.title)).toBeNull(); ui.unmount();
});
it('unavailable panel renders no answer controls', () => {
  const noop=jest.fn(); render(<BlindPanel locale="ru" view={emptyBlind} onDraft={noop} onConsent={noop} onOpen={noop} onRead={noop} onSubmit={noop} onRetry={noop} />);
  expect(screen.queryByText(blindCopy.ru.title)).toBeNull();
});
