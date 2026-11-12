import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SyntheticChatConnected } from '../src/auth/SyntheticChatConnected';
import { fixture, row, message, envelope } from './chat-replies.fixture';
it.each(['ru','en'] as const)('%s selects reply, cancels, opens out-of-window original and displays terminal marker',async locale=>{
 const f=fixture(),ru=locale==='ru';render(<SyntheticChatConnected controller={f.controller} locale={locale}/>);await act(async()=>{await f.login();});
 const count=f.post.mock.calls.length;
 fireEvent.press(screen.getByRole('button',{name:`${ru?'Ответить на сообщение':'Reply to message'}: ${row(250).id}`}));
 expect(screen.getByText(`${ru?'Ответ на сообщение':'Replying to message'}: ${row(250).id}`)).toBeTruthy();expect(f.post).toHaveBeenCalledTimes(count);
 fireEvent.press(screen.getByRole('button',{name:ru?'Отменить выбор ответа':'Cancel reply selection'}));expect(f.controller.getSnapshot().replyTarget).toBeUndefined();
 await act(async()=>{fireEvent.press(screen.getByRole('button',{name:`${ru?'Открыть исходное сообщение':'Open original message'}: ${row(251).id}`}));});
 expect(screen.getByText('Synthetic 1')).toBeTruthy();
 fireEvent.press(screen.getByRole('button',{name:`${ru?'Ответить на сообщение':'Reply to message'}: ${row(1).id}`}));expect(f.controller.getSnapshot().replyTarget?.id).toBe(row(1).id);
 f.detail.mockImplementationOnce(async r=>envelope({message:{...message(1),body:null,version:2,deletedAt:'2026-11-12T00:00:00.000Z'},readId:new URL(r.url).searchParams.get('read_id')}));
 await act(async()=>{await f.controller.openReplyTarget(row(251).id);});expect(screen.queryByText('Synthetic 1')).toBeNull();expect(screen.getByText(ru?'Сообщение удалено':'Message deleted')).toBeTruthy();
 fireEvent.press(screen.getByRole('button',{name:ru?'Закрыть исходное сообщение':'Close original message'}));expect(f.controller.getSnapshot().replyDetail).toBeUndefined();
});
