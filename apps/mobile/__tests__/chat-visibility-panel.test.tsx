import { fireEvent, render } from '@testing-library/react-native';
import { ChatVisibilityPanel, visibilityCopy } from '../src/auth/ChatVisibilityPanel';
import { ChatEditPanel, editCopy } from '../src/auth/ChatEditPanel';
import { uuid } from './chat-window.fixture';
for (const locale of ['ru', 'en'] as const) {
  test(`${locale}: explicit target confirmation, cancel, metadata-only history and retry`, () => {
    const callbacks = { onConfirm: jest.fn(), onCancel: jest.fn(), onRetry: jest.fn(), onRestore: jest.fn(), onLatest: jest.fn(), onOldest: jest.fn(), onOlder: jest.fn(), onNewer: jest.fn() };
    const t = visibilityCopy[locale];
    const { getByText, rerender } = render(<ChatVisibilityPanel locale={locale} {...callbacks} view={{ status: 'confirming', confirmation: {
      token: 'captured-token', messageId: uuid(1), hidden: true, version: 2, seq: 9, createdAt: '2026-11-12T00:00:00.000Z',
    } }} />);
    expect(callbacks.onConfirm).not.toHaveBeenCalled();
    getByText(t.notice);
    fireEvent.press(getByText(t.confirm)); expect(callbacks.onConfirm).toHaveBeenCalledWith('captured-token');
    fireEvent.press(getByText(t.cancel)); expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    rerender(<ChatVisibilityPanel locale={locale} {...callbacks} view={{ status: 'unknown', pendingId: uuid(1) }} />);
    fireEvent.press(getByText(t.retry)); expect(callbacks.onRetry).toHaveBeenCalledTimes(1);
    rerender(<ChatVisibilityPanel locale={locale} {...callbacks} view={{ status: 'saved' }} />);
    getByText(t.saved);
  });
  test(`${locale}: a private edit draft can reload after restoration but cannot save hidden baseline`, () => {
    const onReload = jest.fn(), onSave = jest.fn();
    const screen = render(<ChatEditPanel locale={locale} state={{ status: 'hidden', targetId: uuid(1), draft: 'new private draft', needsReload: true }} onReload={onReload} onSave={onSave} />);
    expect(screen.queryByText(editCopy[locale].save)).toBeNull();
    fireEvent.press(screen.getByText(editCopy[locale].reload)); expect(onReload).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
}
