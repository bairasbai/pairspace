import { fireEvent, render } from '@testing-library/react-native';
import { OutgoingAttemptPanel, outgoingAttemptCopy } from '../src/auth/OutgoingAttemptPanel';
for (const locale of ['ru', 'en'] as const) {
    test(`${locale} explicit local-only unknown-delivery consent, captured token and cancel`, () => {
        const onBegin = jest.fn(), onCancel = jest.fn(), onConfirm = jest.fn();
        const props = { locale, onBegin, onCancel, onConfirm };
        const screen = render(<OutgoingAttemptPanel {...props} pending/>);
        fireEvent.press(screen.getByText(outgoingAttemptCopy[locale].begin));
        expect(onBegin).toHaveBeenCalledTimes(1);
        expect(onConfirm).not.toHaveBeenCalled();
        screen.rerender(<OutgoingAttemptPanel {...props} pending confirmation={{ token: 'A', clientId: 'id', wasInFlight: true }}/>);
        screen.getByText(outgoingAttemptCopy[locale].warning);
        fireEvent.press(screen.getByText(outgoingAttemptCopy[locale].cancel));
        expect(onCancel).toHaveBeenCalledTimes(1);
        fireEvent.press(screen.getByText(outgoingAttemptCopy[locale].confirm));
        expect(onConfirm).toHaveBeenCalledWith('A');
        screen.rerender(<OutgoingAttemptPanel {...props}/>);
        expect(screen.queryByText(outgoingAttemptCopy[locale].begin)).toBeNull();
    });
}
