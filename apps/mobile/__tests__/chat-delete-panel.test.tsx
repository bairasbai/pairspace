import { render, fireEvent } from '@testing-library/react-native';
import { ChatDeletePanel, deleteCopy } from '../src/auth/ChatDeletePanel';
it.each(['ru','en'] as const)('explicit %s confirmation captures token and explains consequences', locale => {
 const confirm=jest.fn(), cancel=jest.fn(), retry=jest.fn(); const t=deleteCopy[locale];
 const screen=render(<ChatDeletePanel locale={locale} state={{status:'confirming',confirmation:{token:'one',messageId:'selected',version:1,seq:3,createdAt:'2026-11-12T00:00:00.000Z'}}} onConfirm={confirm} onCancel={cancel} onRetry={retry} />);
 expect(confirm).not.toHaveBeenCalled(); expect(screen.getByText(`${t.own} #3`)).toBeTruthy(); expect(screen.getByText(`${t.sent}: 2026-11-12T00:00:00.000Z`)).toBeTruthy(); expect(screen.getByText(t.notice)).toBeTruthy();
 fireEvent.press(screen.getByText(t.confirm)); expect(confirm).toHaveBeenCalledWith('one');
 fireEvent.press(screen.getByText(t.cancel)); expect(cancel).toHaveBeenCalledTimes(1);
 screen.rerender(<ChatDeletePanel locale={locale} state={{status:'unknown',pendingId:'selected'}} onRetry={retry} />);
 expect(screen.queryByText(t.cancel)).toBeNull(); fireEvent.press(screen.getByText(t.retry)); expect(retry).toHaveBeenCalledTimes(1);
 screen.rerender(<ChatDeletePanel locale={locale} state={{status:'sending'}} />); expect(screen.getByText(t.sending)).toBeTruthy();
 screen.rerender(<ChatDeletePanel locale={locale} state={{status:'deleted'}} />); expect(screen.getByText(t.deleted)).toBeTruthy();
 screen.rerender(<ChatDeletePanel locale={locale} state={{status:'error'}} />); expect(screen.getByText(t.error)).toBeTruthy();
 screen.rerender(<ChatDeletePanel locale={locale} state={{status:'error',error:'message_deleted'}} />);
 expect(screen.getByText(t.alreadyDeleted)).toBeTruthy(); expect(screen.queryByText(t.error)).toBeNull();
 screen.rerender(<ChatDeletePanel locale={locale} state={{status:'confirming',confirmation:{token:'two',messageId:'selected',version:1,seq:3,createdAt:'2026-11-12T00:00:00.000Z'}}} />);
 fireEvent.press(screen.getByText(t.confirm));
});

import { SyntheticChatPanel } from '../src/auth/SyntheticChatPanel';
import { row, uuid } from './chat-replies.fixture';
it('offers deletion only for own live window/detail rows, without deleting automatically', () => {
 const begin=jest.fn(); const own=row(1), partner={...row(2),senderId:uuid(99)};
 const props={locale:'en' as const,phase:'signed_in' as const,currentUserId:uuid(1),error:null,draft:'',
   messages:[own,partner,{...row(3),body:null}],replyDetail:row(4),onBeginDelete:begin,
   onDraft:jest.fn(),onSignIn:jest.fn(),onSignOut:jest.fn(),onSend:jest.fn(),onRefresh:jest.fn(),
   onCreateProfile:jest.fn(),onCreateWaitingSpace:jest.fn()};
 const screen=render(<SyntheticChatPanel {...props} />);
 expect(begin).not.toHaveBeenCalled();
 expect(screen.queryByText(`Delete for both: ${partner.id}`)).toBeNull();
 expect(screen.queryByText(`Delete for both: ${row(3).id}`)).toBeNull();
 fireEvent.press(screen.getByText(`Delete for both: ${own.id}`));expect(begin).toHaveBeenCalledWith(own.id);
 fireEvent.press(screen.getByText(`Delete for both: ${row(4).id}`));expect(begin).toHaveBeenCalledWith(row(4).id);
});
