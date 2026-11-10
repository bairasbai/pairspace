import { fireEvent, render, screen } from '@testing-library/react-native';
import { LeavePanel, leaveCopy } from '../src/auth/LeavePanel';
import type { LeaveView } from '../src/auth/leave';
it.each(['ru', 'en'] as const)('renders honest confirmation, pending, retry, closed and unavailable in %s', locale => {
  const props = { locale, onBegin: jest.fn(), onCancel: jest.fn(), onConfirm: jest.fn() };
  const show = (status: LeaveView['status'], available = true) => <LeavePanel {...props} view={{ status, available }} />;
  const ui = render(show('idle', false)); expect(screen.queryByText(leaveCopy[locale].title)).toBeNull();
  ui.rerender(show('idle')); fireEvent.press(screen.getByText(leaveCopy[locale].begin)); expect(props.onBegin).toHaveBeenCalled();
  ui.rerender(show('confirming')); expect(screen.getByText(leaveCopy[locale].consequences)).toBeTruthy();
  fireEvent.press(screen.getByText(leaveCopy[locale].cancel)); fireEvent.press(screen.getByText(leaveCopy[locale].confirm));
  expect(props.onCancel).toHaveBeenCalled(); expect(props.onConfirm).toHaveBeenCalledTimes(1);
  ui.rerender(show('pending')); expect(screen.getByText(leaveCopy[locale].pending)).toBeTruthy();
  expect(screen.queryByText(leaveCopy[locale].cancel)).toBeNull();
  ui.rerender(show('retry')); fireEvent.press(screen.getByText(leaveCopy[locale].retry)); expect(props.onConfirm).toHaveBeenCalledTimes(2);
  expect(screen.getByText(leaveCopy[locale].unknown)).toBeTruthy();
  for (const status of ['closed', 'unavailable'] as const) { ui.rerender(show(status)); expect(screen.getByText(leaveCopy[locale][status])).toBeTruthy(); }
});
