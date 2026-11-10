import { fireEvent, render, screen } from '@testing-library/react-native';
import { LettersPanel } from '../src/auth/LettersPanel';
import { lettersCopy } from '../src/auth/lettersCopy';
import type { LettersView } from '../src/auth/letters';
const meta = { id: 'id', coupleId: 'couple', senderId: 'sender', recipientId: 'recipient', clientId: 'client', membershipEpoch: 1, releaseAt: null, releaseTimezone: null, availability: 'available' as const, createdAt: '2026-11-10T00:00:00Z' };
const initial: LettersView = { available: true, busy: false, status: 'idle', draft: '', releaseAtInput: '', releaseTimezoneInput: '', letters: [], opened: null, checked: false, error: false };
function props(locale: 'ru' | 'en', view = initial) {
  return { locale, view, onDraft: jest.fn(), onReleaseAt: jest.fn(), onReleaseTimezone: jest.fn(), onSendLater: jest.fn(), onSend: jest.fn(), onList: jest.fn(), onOpen: jest.fn(), onClose: jest.fn() };
}
it.each(['ru', 'en'] as const)('explicit compose/send/list/open/close UI %s', locale => {
  const p = props(locale), t = lettersCopy[locale]; const ui = render(<LettersPanel {...p} />);
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Private'); expect(p.onDraft).toHaveBeenCalledWith('Private');
  fireEvent.press(screen.getByText(t.send)); expect(p.onSend).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText(t.list)); expect(p.onList).toHaveBeenCalledTimes(1);
  ui.rerender(<LettersPanel {...p} view={{ ...initial, checked: true }} />); expect(screen.getByText(t.none)).toBeTruthy();
  ui.rerender(<LettersPanel {...p} view={{ ...initial, checked: true, letters: [meta], opened: { ...meta, body: '<script>literal</script>' }, error: true, status: 'retry' }} />);
  expect(screen.getByText(t.bound)).toBeTruthy(); expect(screen.getByText(t.error)).toBeTruthy(); expect(screen.getByText(t.retry)).toBeTruthy();
  fireEvent.press(screen.getByText(t.again)); fireEvent.press(screen.getByText(t.open + ' 1'));
  expect(p.onOpen).toHaveBeenCalledWith('id'); expect(screen.getByText('<script>literal</script>')).toBeTruthy();
  fireEvent.press(screen.getByText(t.close)); expect(p.onClose).toHaveBeenCalledTimes(1);
});
it('hides unavailable and disables repeated actions when busy', () => {
  const p = props('en'); const ui = render(<LettersPanel {...p} view={{ ...initial, available: false }} />);
  expect(screen.queryByText(lettersCopy.en.title)).toBeNull();
  ui.rerender(<LettersPanel {...p} view={{ ...initial, busy: true, status: 'sending' }} />);
  fireEvent.press(screen.getByText(lettersCopy.en.send)); expect(p.onSend).not.toHaveBeenCalled();
});
it.each(['ru', 'en'] as const)('scheduled inputs, sealed state and explicit refresh in %s', locale => {
  const p = props(locale), t = lettersCopy[locale]; const ui = render(<LettersPanel {...p} />);
  fireEvent.changeText(screen.getByLabelText(t.releaseAt), '2027-01-15T09:00:00+03:00');
  fireEvent.changeText(screen.getByLabelText(t.releaseTimezone), 'Europe/Moscow');
  expect(p.onReleaseAt).toHaveBeenCalledWith('2027-01-15T09:00:00+03:00'); expect(p.onReleaseTimezone).toHaveBeenCalledWith('Europe/Moscow');
  fireEvent.press(screen.getByText(t.sendLater)); expect(p.onSendLater).toHaveBeenCalledTimes(1);
  ui.rerender(<LettersPanel {...p} view={{ ...initial, checked: true, letters: [{ ...meta, releaseAt: '2027-01-15T06:00:00.000Z', releaseTimezone: 'Europe/Moscow', availability: 'sealed' }] }} />);
  expect(screen.getByText(t.sealed)).toBeTruthy(); fireEvent.press(screen.getByText(t.open + ' 1')); expect(p.onOpen).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText(t.list)); expect(p.onList).toHaveBeenCalledTimes(1);
});
