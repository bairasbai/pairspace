import { fireEvent, render } from '@testing-library/react-native';
import { ChatReconciliationPanel, reconciliationCopy } from '../src/auth/ChatReconciliationPanel';
for (const locale of ['ru', 'en'] as const) {
  test(`${locale}: check and latest require explicit action, truthful non-realtime banner`, () => {
    const onCheck = jest.fn(), onLatest = jest.fn(), text = reconciliationCopy[locale];
    const screen = render(<ChatReconciliationPanel locale={locale} view={{ status: 'idle', hasNewMessages: false }} onCheck={onCheck} onLatest={onLatest} />);
    screen.getByText(text.notice); expect(onCheck).not.toHaveBeenCalled(); expect(onLatest).not.toHaveBeenCalled();
    expect(screen.queryByText(text.latest)).toBeNull(); fireEvent.press(screen.getByText(text.check)); expect(onCheck).toHaveBeenCalledTimes(1);
    screen.rerender(<ChatReconciliationPanel locale={locale} view={{ status: 'loading', hasNewMessages: false }} onCheck={onCheck} onLatest={onLatest} />);
    screen.getByText(text.busy); fireEvent.press(screen.getByText(text.check)); expect(onCheck).toHaveBeenCalledTimes(1);
    screen.rerender(<ChatReconciliationPanel locale={locale} view={{ status: 'ready', hasNewMessages: true }} onCheck={onCheck} onLatest={onLatest} />);
    screen.getByText(text.newer); expect(onLatest).not.toHaveBeenCalled(); fireEvent.press(screen.getByText(text.latest)); expect(onLatest).toHaveBeenCalledTimes(1);
    screen.rerender(<ChatReconciliationPanel locale={locale} view={{ status: 'error', hasNewMessages: false, error: 'transport_error' }} onCheck={onCheck} onLatest={onLatest} />);
    screen.getByText(text.error);
    screen.rerender(<ChatReconciliationPanel locale={locale} view={{ status: 'error', hasNewMessages: false, error: 'visibility_changed' }} onCheck={onCheck} onLatest={onLatest} />);
    screen.getByText(text.visibility); expect(onCheck).toHaveBeenCalledTimes(1); expect(onLatest).toHaveBeenCalledTimes(1);
  });
}
