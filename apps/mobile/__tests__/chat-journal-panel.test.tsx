import { fireEvent, render } from '@testing-library/react-native';
import { ChatJournalPanel, journalCopy } from '../src/auth/ChatJournalPanel';
for (const locale of ['ru', 'en'] as const) {
    test(`${locale}: explicit recovery, conflict consent, reset warning, no automatic send`, () => {
        const actions = { onCheck: jest.fn(), onRestore: jest.fn(), onFlush: jest.fn(), onConflict: jest.fn(), onVerify: jest.fn(), onRemove: jest.fn(), onRetry: jest.fn(),
            onBeginReset: jest.fn(), onCancelReset: jest.fn(), onConfirmReset: jest.fn() };
        const screen = render(<ChatJournalPanel locale={locale} {...actions} view={{ enabled: true, status: 'recovery', hasPending: true }}/>);
        screen.getByText(journalCopy[locale].notice);
        expect(actions.onRestore).not.toHaveBeenCalled();
        expect(actions.onRetry).not.toHaveBeenCalled();
        fireEvent.press(screen.getByText(journalCopy[locale].restore));
        expect(actions.onRestore).toHaveBeenCalledTimes(1);
        screen.rerender(<ChatJournalPanel locale={locale} {...actions} view={{ enabled: true, status: 'conflict', conflictToken: 'A' }}/>);
        fireEvent.press(screen.getByText(journalCopy[locale].current));
        expect(actions.onConflict).toHaveBeenCalledWith('A', 'current');
        fireEvent.press(screen.getByText(journalCopy[locale].stored));
        expect(actions.onConflict).toHaveBeenCalledWith('A', 'stored');
        screen.rerender(<ChatJournalPanel locale={locale} {...actions} view={{ enabled: true, status: 'ready', replyNeedsVerification: 'id', hasPending: true, resetToken: 'B' }}/>);
        fireEvent.press(screen.getByText(journalCopy[locale].verify));
        expect(actions.onVerify).toHaveBeenCalledTimes(1);
        fireEvent.press(screen.getByText(journalCopy[locale].remove));
        expect(actions.onRemove).toHaveBeenCalledTimes(1);
        fireEvent.press(screen.getByText(locale === 'ru' ? 'Подтвердить локальный сброс' : 'Confirm local reset'));
        expect(actions.onConfirmReset).toHaveBeenCalledWith('B');
        screen.rerender(<ChatJournalPanel locale={locale} {...actions} view={{ enabled: true, status: 'unsaved' }}/>);
        screen.getByText(journalCopy[locale].unsaved);
        fireEvent.press(screen.getByText(journalCopy[locale].flush));
        expect(actions.onFlush).toHaveBeenCalledTimes(1);
        screen.rerender(<ChatJournalPanel locale={locale} {...actions} view={{ enabled: false, status: 'disabled' }}/>);
        expect(screen.queryByText(journalCopy[locale].title)).toBeNull();
    });
}
