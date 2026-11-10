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
it.each(['ru','en'] as const)('renders explicit history, selection, and confirmed next controls in %s',locale=>{
  const onList=jest.fn(),onSelect=jest.fn(),onNext=jest.fn(),noop=jest.fn();
  const revealed={...round,ownAnswer:'Joy',partnerAnswer:'Walk',revealed:true};
  render(<BlindPanel locale={locale} view={{...emptyBlind,available:true,round:revealed,selectedRoundId:round.id,currentRoundId:round.id,
    rounds:[{id:round.id,questionId:round.questionId,catalogVersion:1}]}}
    onDraft={noop} onConsent={noop} onOpen={noop} onRead={noop} onSubmit={noop} onRetry={noop}
    onList={onList} onSelect={onSelect} onNext={onNext}/>);
  fireEvent.press(screen.getByText(blindCopy[locale].history)); expect(onList).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText(new RegExp(round.id))); expect(onSelect).toHaveBeenCalledWith(round.id);
  const nextButtons=screen.getAllByText(new RegExp('^'+blindCopy[locale].next));
  expect(nextButtons).toHaveLength(3);fireEvent.press(nextButtons[1]);
  expect(onNext).toHaveBeenCalledWith('shared-plan',1,true);
});
