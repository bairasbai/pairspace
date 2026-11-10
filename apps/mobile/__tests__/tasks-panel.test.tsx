import { fireEvent, render, screen } from '@testing-library/react-native';
import { TasksPanel } from '../src/auth/TasksPanel';
import { tasksCopy } from '../src/auth/tasksCopy';
import { emptyTasks } from '../src/auth/tasks-state';
import { task } from './tasks-fixtures';
const initial = { ...emptyTasks, available: true };
function props(locale: 'ru' | 'en') {
  return { locale, view: initial, onDraft: jest.fn(), onCreate: jest.fn(), onRetry: jest.fn(), onList: jest.fn(), onComplete: jest.fn(), onReopen: jest.fn(), onCancel: jest.fn() };
}
it.each(['ru', 'en'] as const)('explicit create/list/complete/reopen/retry and honest cap UI %s', locale => {
  const p = props(locale), t = tasksCopy[locale]; const ui = render(<TasksPanel {...p} />);
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Private draft'); expect(p.onDraft).toHaveBeenCalledWith('Private draft');
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); fireEvent.press(screen.getByText(t.cancel));
  expect(p.onCreate).toHaveBeenCalledTimes(1); expect(p.onList).toHaveBeenCalledTimes(1); expect(p.onCancel).toHaveBeenCalledTimes(1);
  expect(screen.getByText(t.bound)).toBeTruthy();
  ui.rerender(<TasksPanel {...p} view={{ ...initial, checked: true }} />); expect(screen.getByText(t.none)).toBeTruthy();
  ui.rerender(<TasksPanel {...p} view={{ ...initial, tasks: [task] }} />);
  fireEvent.press(screen.getByText(t.complete + ' 1')); expect(p.onComplete).toHaveBeenCalledWith(task.id);
  ui.rerender(<TasksPanel {...p} view={{ ...initial, tasks: [{ ...task, state: 'completed' }], error: true }} />);
  fireEvent.press(screen.getByText(t.reopen + ' 1')); expect(p.onReopen).toHaveBeenCalledWith(task.id); expect(screen.getByText(t.error)).toBeTruthy();
  ui.rerender(<TasksPanel {...p} view={{ ...initial, status: 'retry', pending: { operation: 'create', title: 'Original' }, tasks: [task] }} />);
  fireEvent.press(screen.getByText(t.again)); expect(p.onRetry).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.complete + ' 1'));
  expect(p.onCreate).toHaveBeenCalledTimes(1); expect(p.onComplete).toHaveBeenCalledTimes(1);
});
it('hides unavailable and blocks busy/conflict writes but leaves refresh and clear available after conflict', () => {
  const p = props('en'), t = tasksCopy.en; const ui = render(<TasksPanel {...p} view={emptyTasks} />);
  expect(screen.queryByText(t.title)).toBeNull();
  ui.rerender(<TasksPanel {...p} view={{ ...initial, busy: true, status: 'saving' }} />);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); expect(p.onCreate).not.toHaveBeenCalled(); expect(p.onList).not.toHaveBeenCalled();
  ui.rerender(<TasksPanel {...p} view={{ ...initial, requiresRefresh: true, status: 'conflict' }} />);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); expect(p.onCreate).not.toHaveBeenCalled(); expect(p.onList).toHaveBeenCalled();
});
