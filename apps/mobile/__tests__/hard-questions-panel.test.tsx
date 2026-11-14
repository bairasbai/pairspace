import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { HardQuestionsPanel } from '../src/auth/HardQuestionsPanel';
import { ConnectedTogether } from '../src/auth/ConnectedTogether';
import { createPairFeatures } from '../src/auth/pair-features';
import { hardQuestionsCopy } from '../src/auth/hardQuestionsCopy';
import { ack, context, declined, deferred, detail, envelope, fixture, incoming, list, openAck, opened, own, ownOpened, prose, settle, uuid } from './hard-questions-fixtures';

for (const locale of ['ru','en'] as const) for (const platform of ['ios','android'] as const) {
  it(`keeps recipient text sealed until explicit confirmation and supports repeated reads in ${locale}/${platform}`, async () => {
    const replacement = jest.replaceProperty(Platform, 'OS', platform);
    try {
      const f = fixture(), t = hardQuestionsCopy[locale]; await f.load([incoming]);
      render(<HardQuestionsPanel controller={f.api} locale={locale}/>);
      expect(screen.queryByText(prose)).toBeNull(); expect(screen.getByText(t.notice)).toBeTruthy();
      fireEvent.press(screen.getByRole('button',{ name: `${t.open} 1` })); expect(screen.getByText(t.confirmOpen)).toBeTruthy();
      fireEvent.press(screen.getByRole('button',{ name: t.cancel })); expect(f.operation).toHaveBeenCalledTimes(1);
      fireEvent.press(screen.getByRole('button',{ name: `${t.open} 1` })); f.operation.mockResolvedValueOnce(openAck());
      await act(async()=>{ fireEvent.press(screen.getByRole('button',{name:t.confirm})); await settle(); });
      expect(screen.getByText(prose).props.children).toContain('\n\n'); expect(screen.getByText(t.opened)).toBeTruthy();
      fireEvent.press(screen.getByRole('button',{name:t.close})); expect(screen.queryByText(prose)).toBeNull();
      f.operation.mockResolvedValueOnce(detail());
      await act(async()=>{fireEvent.press(screen.getByRole('button',{name:`${t.readOpened} 1`}));await settle();});
      expect(screen.getByText(prose)).toBeTruthy();
      fireEvent.changeText(screen.getByLabelText(t.draftLabel),'🦉🦉'); expect(screen.getByText(`${t.characters} 2/2000`)).toBeTruthy();
      fireEvent.press(screen.getByRole('button',{name:t.cancelDraft}));expect(f.api.getSnapshot().draft).toBe('');
    } finally { replacement.restore(); }
  });
}
it('author can read their own sealed text without consent transition and remove only their own words', async()=>{
  const f=fixture(),t=hardQuestionsCopy.ru;await f.load([own]);render(<HardQuestionsPanel controller={f.api} locale="ru"/>);
  expect(screen.queryByRole('button',{name:`${t.open} 1`})).toBeNull();f.operation.mockResolvedValueOnce(detail(own));
  await act(async()=>{fireEvent.press(screen.getByRole('button',{name:`${t.readOwn} 1`}));await settle();});
  expect(screen.getByText(prose)).toBeTruthy();expect(f.api.getSnapshot().questions[0].decisionState).toBe('sealed');
  fireEvent.press(screen.getByRole('button',{name:`${t.remove} 1`}));expect(screen.getByText(t.confirmRemove)).toBeTruthy();
  fireEvent.press(screen.getByRole('button',{name:t.cancel}));expect(f.operation).toHaveBeenCalledTimes(2);
  fireEvent.press(screen.getByRole('button',{name:`${t.remove} 1`}));f.operation.mockResolvedValueOnce(ack({...own,contentState:'removed',decisionState:'withdrawn',version:2}));
  await act(async()=>{fireEvent.press(screen.getByRole('button',{name:t.confirm}));await settle();});
  expect(screen.queryByText(prose)).toBeNull();expect(screen.getByText(t.withdrawn)).toBeTruthy();expect(screen.getByText(t.removed)).toBeTruthy();
});
it('decline confirmation explains no disclosure, terminal choice and author visibility; no text is shown',async()=>{
  const f=fixture(),t=hardQuestionsCopy.en;await f.load([incoming]);render(<HardQuestionsPanel controller={f.api} locale="en"/>);
  fireEvent.press(screen.getByRole('button',{name:`${t.decline} 1`}));expect(screen.getByText(t.confirmDecline)).toBeTruthy();
  f.operation.mockResolvedValueOnce(ack(declined));await act(async()=>{fireEvent.press(screen.getByRole('button',{name:t.confirm}));await settle();});
  expect(screen.getByText(t.declined)).toBeTruthy();expect(screen.queryByText(prose)).toBeNull();expect(screen.queryByRole('button',{name:`${t.open} 1`})).toBeNull();
});
it('actual unmount during opening clears display intent under StrictMode without cancelling the committed command',async()=>{
  const f=fixture(),t=hardQuestionsCopy.ru;await f.load([incoming]);const reply=deferred();f.operation.mockImplementationOnce(()=>reply.promise);
  const mounted=render(<StrictMode><HardQuestionsPanel controller={f.api} locale="ru"/></StrictMode>);
  fireEvent.press(screen.getByRole('button',{name:`${t.open} 1`}));
  await act(async()=>{fireEvent.press(screen.getByRole('button',{name:t.confirm}));await settle();});
  expect(f.api.getSnapshot().pending).toBe(true);mounted.unmount();
  await act(async()=>{reply.resolve(openAck());await settle();});
  expect(f.api.getSnapshot().pending).toBe(false);expect(f.api.getSnapshot().questions[0]).toEqual(opened);expect(f.api.getSnapshot().reader).toBeNull();
  render(<HardQuestionsPanel controller={f.api} locale="ru"/>);expect(screen.queryByText(prose)).toBeNull();
  f.operation.mockResolvedValueOnce(detail());await act(async()=>{fireEvent.press(screen.getByRole('button',{name:`${t.readOpened} 1`}));await settle();});expect(screen.getByText(prose)).toBeTruthy();
});
it('offline opening exposes an honest retry; closing then retrying confirms state without late display',async()=>{
  const f=fixture(),t=hardQuestionsCopy.ru;await f.load([incoming]);render(<HardQuestionsPanel controller={f.api} locale="ru"/>);
  fireEvent.press(screen.getByRole('button',{name:`${t.open} 1`}));f.operation.mockRejectedValueOnce(Error('offline'));
  await act(async()=>{fireEvent.press(screen.getByRole('button',{name:t.confirm}));await settle();});expect(screen.getByText(t.readerError)).toBeTruthy();
  fireEvent.press(screen.getByRole('button',{name:t.close}));f.operation.mockResolvedValueOnce(openAck(opened,true));
  await act(async()=>{fireEvent.press(screen.getByRole('button',{name:t.retry}));await settle();});
  expect(screen.queryByText(prose)).toBeNull();expect(f.api.getSnapshot().pending).toBe(false);expect(screen.getByText(t.opened)).toBeTruthy();
});
it('reset/rebind and ready-controller replacement clear confirmations and never close a replacement reader',async()=>{
  const f=fixture(),g=fixture(),t=hardQuestionsCopy.ru;await f.load([incoming]);await g.load([ownOpened]);g.operation.mockResolvedValueOnce(detail(ownOpened));await g.api.read(own.id);
  const mounted=render(<HardQuestionsPanel controller={f.api} locale="ru"/>);fireEvent.press(screen.getByRole('button',{name:`${t.open} 1`}));
  await act(async()=>{f.controller.reset();f.controller.sync();await f.load([incoming]);});expect(screen.queryByText(t.confirmOpen)).toBeNull();
  fireEvent.press(screen.getByRole('button',{name:`${t.decline} 1`}));expect(screen.getByText(t.confirmDecline)).toBeTruthy();
  mounted.rerender(<HardQuestionsPanel controller={g.api} locale="ru"/>);expect(screen.queryByText(t.confirmDecline)).toBeNull();expect(screen.getByText(prose)).toBeTruthy();
  expect(g.api.getSnapshot().reader?.text).toBe(prose);
});
it('StrictMode ready-controller replacement discards a late old OpenACK while retaining the replacement reader',async()=>{
  const a=fixture(),b=fixture(),t=hardQuestionsCopy.ru;await a.load([incoming]);await b.load([ownOpened]);b.operation.mockResolvedValueOnce(detail(ownOpened,'Synthetic replacement text'));await b.api.read(own.id);
  const late=deferred();a.operation.mockImplementationOnce(()=>late.promise);
  const mounted=render(<StrictMode><HardQuestionsPanel controller={a.api} locale="ru"/></StrictMode>);
  fireEvent.press(screen.getByRole('button',{name:`${t.open} 1`}));await act(async()=>{fireEvent.press(screen.getByRole('button',{name:t.confirm}));await settle();});
  mounted.rerender(<StrictMode><HardQuestionsPanel controller={b.api} locale="ru"/></StrictMode>);
  await act(async()=>{late.resolve(openAck());await settle();});
  expect(a.api.getSnapshot().pending).toBe(false);expect(a.api.getSnapshot().reader).toBeNull();
  expect(b.api.getSnapshot().reader?.question.id).toBe(own.id);expect(screen.getByText('Synthetic replacement text')).toBeTruthy();expect(screen.queryByText(prose)).toBeNull();
});
it('real composition adds a distinct tab without auto requests; navigating away closes text and legacy controllers stay usable',async()=>{
  const snapshot={generation:1,identity:{sessionId:'session',userId:'provider'},context};
  const host={capture:()=>snapshot,getCookie:async()=>'synthetic=cookie',block:jest.fn(),refresh:async()=>{},suspend:jest.fn(),finish:jest.fn()};
  const request=jest.fn(async(r:Request)=>r.url.endsWith('/context')?envelope(context):r.url.includes('/text?')?detail(own):list([own]));
  const features=createPairFeatures({mode:'synthetic-loopback',baseURL:'http://127.0.0.1:8787'},host,request,()=>uuid(3));features.sync();
  const mounted=render(<ConnectedTogether controller={features.actions} locale="ru"/>);expect(request).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('tab',{name:'Трудный вопрос'}));expect(request).not.toHaveBeenCalled();
  await act(async()=>{fireEvent.press(screen.getByRole('button',{name:hardQuestionsCopy.ru.load}));await settle();});expect(request).toHaveBeenCalledTimes(2);
  await act(async()=>{fireEvent.press(screen.getByRole('button',{name:`${hardQuestionsCopy.ru.readOwn} 1`}));await settle();});expect(screen.getByText(prose)).toBeTruthy();
  fireEvent.press(screen.getByRole('tab',{name:'Словарь'}));expect(features.actions.hardQuestions.getSnapshot().reader).toBeNull();
  fireEvent.press(screen.getByRole('tab',{name:'Трудный вопрос'}));expect(screen.queryByText(prose)).toBeNull();
  mounted.rerender(<ConnectedTogether controller={{loveWords:features.actions.loveWords,asks:features.actions.asks,scale:features.actions.scale,stems:features.actions.stems,stories:features.actions.stories}} locale="ru"/>);
  expect(screen.queryByRole('tab',{name:'Трудный вопрос'})).toBeNull();expect(screen.getByRole('tab',{name:'Словарь'}).props.accessibilityState.selected).toBe(true);
});
