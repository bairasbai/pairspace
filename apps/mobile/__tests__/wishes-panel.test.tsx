import { fireEvent, render, screen } from '@testing-library/react-native';
import { WishesPanel } from '../src/auth/WishesPanel';
import { wishesCopy } from '../src/auth/wishesCopy';
import { emptyWishes } from '../src/auth/wishes-state';
import { wish } from './wishes-fixtures';
const initial = { ...emptyWishes, available: true, consent: true };
function props(locale: 'ru' | 'en') {
  return { locale, view: initial, onDraft: jest.fn(), onExplanation: jest.fn(), onConsent: jest.fn(), onCreate: jest.fn(), onRetry: jest.fn(), onList: jest.fn(), onFulfill: jest.fn(), onReopen: jest.fn(), onCancel: jest.fn() };
}
it.each(['ru', 'en'] as const)('explicit create/list/fulfill/reopen/retry and honest cap UI %s', locale => {
  const p = props(locale), t = wishesCopy[locale]; const ui = render(<WishesPanel {...p} />);
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Private draft'); expect(p.onDraft).toHaveBeenCalledWith('Private draft');
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); fireEvent.press(screen.getByText(t.cancel));
  expect(p.onCreate).toHaveBeenCalledTimes(1); expect(p.onList).toHaveBeenCalledTimes(1); expect(p.onCancel).toHaveBeenCalledTimes(1);
  expect(screen.getByText(t.bound)).toBeTruthy();
  ui.rerender(<WishesPanel {...p} view={{ ...initial, checked: true }} />); expect(screen.getByText(t.none)).toBeTruthy();
  ui.rerender(<WishesPanel {...p} view={{ ...initial, wishes: [wish] }} />);
  fireEvent.press(screen.getByText(t.fulfill + ' 1')); expect(p.onFulfill).toHaveBeenCalledWith(wish.id);
  ui.rerender(<WishesPanel {...p} view={{ ...initial, wishes: [{ ...wish, state: 'fulfilled' }], error: true }} />);
  fireEvent.press(screen.getByText(t.reopen + ' 1')); expect(p.onReopen).toHaveBeenCalledWith(wish.id); expect(screen.getByText(t.error)).toBeTruthy();
  ui.rerender(<WishesPanel {...p} view={{ ...initial, status: 'retry', pending: { operation: 'create', title: 'Original', explanation: '' }, wishes: [wish] }} />);
  fireEvent.press(screen.getByText(t.again)); expect(p.onRetry).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.fulfill + ' 1'));
  expect(p.onCreate).toHaveBeenCalledTimes(1); expect(p.onFulfill).toHaveBeenCalledTimes(1);
});
it('hides unavailable and blocks busy/conflict writes but leaves refresh and clear available after conflict', () => {
  const p = props('en'), t = wishesCopy.en; const ui = render(<WishesPanel {...p} view={emptyWishes} />);
  expect(screen.queryByText(t.title)).toBeNull();
  ui.rerender(<WishesPanel {...p} view={{ ...initial, busy: true, status: 'saving' }} />);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); expect(p.onCreate).not.toHaveBeenCalled(); expect(p.onList).not.toHaveBeenCalled();
  ui.rerender(<WishesPanel {...p} view={{ ...initial, requiresRefresh: true, status: 'conflict' }} />);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); expect(p.onCreate).not.toHaveBeenCalled(); expect(p.onList).toHaveBeenCalled();
});
it.each(['ru', 'en'] as const)('explanation and explicit consent controls in %s', locale => {
  const p = props(locale), t = wishesCopy[locale];
  const ui = render(<WishesPanel {...p} view={{ ...initial, consent: false }} />);
  fireEvent.press(screen.getByText(t.create)); expect(p.onCreate).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText(t.explanation), 'For both');
  expect(p.onExplanation).toHaveBeenCalledWith('For both');
  fireEvent.press(screen.getByLabelText(t.consent)); expect(p.onConsent).toHaveBeenCalledWith(true);
  ui.rerender(<WishesPanel {...p} view={{ ...initial, wishes: [{ ...wish, explanation: 'For both', version: 2147483647 }] }} />);
  expect(screen.getByText('For both')).toBeTruthy();
  fireEvent.press(screen.getByLabelText(t.consent)); expect(p.onConsent).toHaveBeenLastCalledWith(false);
  fireEvent.press(screen.getByText(t.fulfill + ' 1')); expect(p.onFulfill).not.toHaveBeenCalled();
});
