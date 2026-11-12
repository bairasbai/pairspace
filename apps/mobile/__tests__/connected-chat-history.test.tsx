import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { fixture, settle, deferred, windowResponse } from './chat-window.fixture';
const labels = {
  en: { older:'Load older messages', retry:'Retry loading history', loading:'Loading history…', error:'Could not load history. You can retry.', end:'Beginning of history.', refresh:'Refresh history', latest:'Latest messages', oldest:'Oldest messages', newer:'Show newer messages', cap:'One window of up to 50 messages. Previous windows are not accumulated.' },
  ru: { older:'Загрузить предыдущие сообщения', retry:'Повторить загрузку истории', loading:'История загружается…', error:'Не удалось загрузить историю. Можно повторить запрос.', end:'Начало истории.', refresh:'Обновить историю', latest:'Последние сообщения', oldest:'Самые первые сообщения', newer:'Показать более новые сообщения', cap:'Показано одно окно до 50 сообщений. Предыдущие окна не накапливаются.' },
};
async function press(label:string) { await act(async()=>{fireEvent.press(screen.getByRole('button',{name:label}));await settle();}); }
it.each(['ru','en'] as const)('explicit bounded bidirectional navigation and retry in %s', async locale=>{
  const f=fixture(),t=labels[locale];render(<SyntheticChatConnected controller={f.controller} locale={locale}/>);
  await act(async()=>{await f.login();});expect(screen.getByText(t.cap)).toBeOnTheScreen();
  const pending=deferred();f.history.mockReturnValueOnce(pending.promise);await press(t.older);
  expect(screen.getByText(t.loading)).toBeOnTheScreen();expect(screen.getByRole('button',{name:t.older})).toBeDisabled();
  await act(async()=>{pending.resolve(new Response('{}',{status:503}));await settle();});expect(screen.getByText(t.error)).toBeOnTheScreen();
  await press(t.retry);expect(screen.queryByText('Synthetic 251')).toBeNull();expect(screen.getByText('Synthetic 152')).toBeOnTheScreen();
  await press(t.newer);expect(screen.getByText('Synthetic 251')).toBeOnTheScreen();
  await press(t.oldest);expect(screen.getByText('Synthetic 1')).toBeOnTheScreen();expect(screen.getByText(t.end)).toBeOnTheScreen();expect(screen.queryByRole('button',{name:t.older})).toBeNull();
  await press(t.latest);expect(screen.queryByText('Synthetic 1')).toBeNull();expect(screen.getByText('Synthetic 251')).toBeOnTheScreen();
  f.history.mockImplementationOnce(async r=>windowResponse(r,310));await press(t.refresh);expect(screen.getByText('Synthetic 310')).toBeOnTheScreen();
});
