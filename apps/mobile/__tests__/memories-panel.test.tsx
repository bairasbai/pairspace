import { fireEvent, render, screen } from '@testing-library/react-native';
import { MemoriesPanel } from '../src/auth/MemoriesPanel';
import { memoriesCopy } from '../src/auth/memoriesCopy';
import { emptyMemories } from '../src/auth/memories-state';
import { memory } from './memories-fixtures';
const initial = { ...emptyMemories, available: true, consent: true };
function props(locale: 'ru' | 'en') {
  return { locale, view: initial, onConsent: jest.fn(), onDraft: jest.fn(), onLocalDate: jest.fn(), onBody: jest.fn(), onCreate: jest.fn(), onRetry: jest.fn(), onList: jest.fn(), onCancel: jest.fn() };
}
it.each(['ru', 'en'] as const)('explicit share/list/retry and honest one-off cap UI %s', locale => {
  const p = props(locale), t = memoriesCopy[locale]; const ui = render(<MemoriesPanel {...p} />);
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Private draft'); expect(p.onDraft).toHaveBeenCalledWith('Private draft');
  fireEvent.changeText(screen.getByLabelText(t.localDate), memory.localDate); expect(p.onLocalDate).toHaveBeenCalledWith(memory.localDate);
  fireEvent.changeText(screen.getByLabelText(t.body), memory.body); expect(p.onBody).toHaveBeenCalledWith(memory.body);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); fireEvent.press(screen.getByText(t.cancel));
  expect(p.onCreate).toHaveBeenCalledTimes(1); expect(p.onList).toHaveBeenCalledTimes(1); expect(p.onCancel).toHaveBeenCalledTimes(1);
  expect(screen.getByText(t.bound)).toBeTruthy(); expect(screen.getByText(t.cancelHint)).toBeTruthy();
  ui.rerender(<MemoriesPanel {...p} view={{ ...initial, checked: true }} />); expect(screen.getByText(t.none)).toBeTruthy();
  ui.rerender(<MemoriesPanel {...p} view={{ ...initial, memories: [memory], error: true }} />);
  expect(screen.getByText(memory.body)).toBeTruthy(); expect(screen.getByText(t.error)).toBeTruthy();
  ui.rerender(<MemoriesPanel {...p} view={{ ...initial, status: 'retry', pending: { title: 'Original', localDate: memory.localDate, body: memory.body }, memories: [memory] }} />);
  fireEvent.press(screen.getByText(t.again)); expect(p.onRetry).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText(t.create)); expect(p.onCreate).toHaveBeenCalledTimes(1);
});
it('hides unavailable and blocks busy/conflict writes but leaves refresh and clear available after conflict', () => {
  const p = props('en'), t = memoriesCopy.en; const ui = render(<MemoriesPanel {...p} view={emptyMemories} />);
  expect(screen.queryByText(t.title)).toBeNull();
  ui.rerender(<MemoriesPanel {...p} view={{ ...initial, busy: true, status: 'saving' }} />);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); expect(p.onCreate).not.toHaveBeenCalled(); expect(p.onList).not.toHaveBeenCalled();
  ui.rerender(<MemoriesPanel {...p} view={{ ...initial, requiresRefresh: true, status: 'conflict' }} />);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); expect(p.onCreate).not.toHaveBeenCalled(); expect(p.onList).toHaveBeenCalled();
});
it.each(['ru', 'en'] as const)('shows visible consent state and requests explicit toggle in %s', locale => {
  const p = props(locale), t = memoriesCopy[locale]; const ui = render(<MemoriesPanel {...p} view={{ ...initial, consent: false }} />);
  expect(screen.getByText('☐ ' + t.consent)).toBeTruthy(); expect(screen.getByText(t.limits)).toBeTruthy();
  fireEvent.press(screen.getByText(t.create)); expect(p.onCreate).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText(t.consent)); expect(p.onConsent).toHaveBeenCalledWith(true);
  ui.rerender(<MemoriesPanel {...p} />); expect(screen.getByText('☑ ' + t.consent)).toBeTruthy();
  fireEvent.press(screen.getByLabelText(t.consent)); expect(p.onConsent).toHaveBeenCalledWith(false);
});
