import { fireEvent, render, screen } from '@testing-library/react-native';
import { DatesPanel } from '../src/auth/DatesPanel';
import { datesCopy } from '../src/auth/datesCopy';
import { emptyDates } from '../src/auth/dates-state';
import { date } from './dates-fixtures';
const initial = { ...emptyDates, available: true };
function props(locale: 'ru' | 'en') {
  return { locale, view: initial, onEdit: jest.fn(), onRecurrence: jest.fn(), onLeapDayPolicy: jest.fn(), onDraft: jest.fn(), onLocalDate: jest.fn(), onTimezone: jest.fn(), onCreate: jest.fn(), onRetry: jest.fn(), onList: jest.fn(), onCancel: jest.fn() };
}
it.each(['ru', 'en'] as const)('explicit share/list/retry and honest one-off cap UI %s', locale => {
  const p = props(locale), t = datesCopy[locale]; const ui = render(<DatesPanel {...p} />);
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Private draft'); expect(p.onDraft).toHaveBeenCalledWith('Private draft');
  fireEvent.changeText(screen.getByLabelText(t.localDate), date.localDate); expect(p.onLocalDate).toHaveBeenCalledWith(date.localDate);
  fireEvent.changeText(screen.getByLabelText(t.timezone), date.timezone); expect(p.onTimezone).toHaveBeenCalledWith(date.timezone);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); fireEvent.press(screen.getByText(t.cancel));
  expect(p.onCreate).toHaveBeenCalledTimes(1); expect(p.onList).toHaveBeenCalledTimes(1); expect(p.onCancel).toHaveBeenCalledTimes(1);
  expect(screen.getByText(t.bound)).toBeTruthy(); expect(screen.getByText(t.cancelHint)).toBeTruthy();
  ui.rerender(<DatesPanel {...p} view={{ ...initial, checked: true }} />); expect(screen.getByText(t.none)).toBeTruthy();
  ui.rerender(<DatesPanel {...p} view={{ ...initial, dates: [date], error: true }} />);
  expect(screen.getByText(date.localDate + ' · ' + date.timezone)).toBeTruthy(); expect(screen.getByText(t.error)).toBeTruthy();
  ui.rerender(<DatesPanel {...p} view={{ ...initial, status: 'retry', pending: { recurrence: 'once', leapDayPolicy: null, title: 'Original', localDate: date.localDate, timezone: date.timezone }, dates: [date] }} />);
  fireEvent.press(screen.getByText(t.again)); expect(p.onRetry).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText(t.create)); expect(p.onCreate).toHaveBeenCalledTimes(1);
});
it('hides unavailable and blocks busy/conflict writes but leaves refresh and clear available after conflict', () => {
  const p = props('en'), t = datesCopy.en; const ui = render(<DatesPanel {...p} view={emptyDates} />);
  expect(screen.queryByText(t.title)).toBeNull();
  ui.rerender(<DatesPanel {...p} view={{ ...initial, busy: true, status: 'saving' }} />);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); expect(p.onCreate).not.toHaveBeenCalled(); expect(p.onList).not.toHaveBeenCalled();
  ui.rerender(<DatesPanel {...p} view={{ ...initial, requiresRefresh: true, status: 'conflict' }} />);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); expect(p.onCreate).not.toHaveBeenCalled(); expect(p.onList).toHaveBeenCalled();
});
