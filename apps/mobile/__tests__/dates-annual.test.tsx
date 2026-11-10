import { fireEvent, render, screen } from '@testing-library/react-native';
import { DatesPanel } from '../src/auth/DatesPanel';
import { datesCopy } from '../src/auth/datesCopy';
import { validDate } from '../src/auth/dates-state';
import { fixture, ack, date, context, error, envelope } from './dates-fixtures';
import { nextOccurrence, type LeapDayPolicy } from '../../../packages/domain/dates/recurrence';

it.each(['leap_years_only', 'feb28', 'mar1'] as const)('requires explicit Feb29 policy, sends and acknowledges %s', async leapDayPolicy => {
  const f = fixture(); f.api.setRecurrence('annual');
  await f.api.create(); expect(f.operation).not.toHaveBeenCalled(); expect(f.api.getSnapshot().status).toBe('invalid');
  f.api.setLeapDayPolicy(leapDayPolicy);
  f.operation.mockResolvedValue(ack({ ...date, recurrence: 'annual', leapDayPolicy }));
  await f.api.create();
  expect(await f.operation.mock.calls[0][0].json()).toMatchObject({ recurrence: 'annual', leap_day_policy: leapDayPolicy });
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', recurrence: 'once', leapDayPolicy: null });
});
it('unknown ACK retains exact schedule while a new draft switches policy, date and recurrence', async () => {
  const f = fixture(); f.api.setRecurrence('annual'); f.api.setLeapDayPolicy('feb28');
  f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.create();
  f.api.setLeapDayPolicy('mar1'); f.api.setLocalDate('2032-02-29'); f.api.setLeapDayPolicy('leap_years_only');
  f.operation.mockResolvedValue(ack({ ...date, recurrence: 'annual', leapDayPolicy: 'feb28' }));
  await f.api.retry();
  expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[0][0].json());
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', localDate: '2032-02-29', recurrence: 'annual', leapDayPolicy: 'leap_years_only' });
});
it('policy resets on changes, survives unchanged fields, and unavailable edits are ignored', () => {
  const f = fixture(); f.api.setLeapDayPolicy('mar1'); expect(f.api.getSnapshot().leapDayPolicy).toBeNull();
  f.api.setRecurrence('annual'); f.api.setLeapDayPolicy('feb28'); f.api.setRecurrence('annual'); f.api.setLocalDate(date.localDate);
  expect(f.api.getSnapshot().leapDayPolicy).toBe('feb28');
  f.api.setLocalDate('2028-03-01'); expect(f.api.getSnapshot().leapDayPolicy).toBeNull();
  f.api.setLeapDayPolicy('mar1'); expect(f.api.getSnapshot().leapDayPolicy).toBeNull();
  f.api.setLocalDate(date.localDate); f.api.setLeapDayPolicy('mar1'); f.api.setRecurrence('once');
  expect(f.api.getSnapshot().leapDayPolicy).toBeNull();
  f.api.setRecurrence('annual'); f.api.cancel(); expect(f.api.getSnapshot().recurrence).toBe('once');
  f.controller.reset(); f.api.setRecurrence('annual'); f.api.setLeapDayPolicy('mar1'); expect(f.api.getSnapshot().recurrence).toBe('once');
});
it.each([
  { recurrence: 'weekly' }, { recurrence: 'annual', leapDayPolicy: null }, { leapDayPolicy: 'feb28' },
  { asOfLocalDate: '1900-02-29' }, { asOfLocalDate: null }, { nextOccurrence: null }, { nextOccurrence: '2029-02-28' },
  { recurrence: 'annual', leapDayPolicy: 'mar1', asOfLocalDate: '2029-01-01', nextOccurrence: '2029-02-28' },
])('rejects inconsistent or malformed server schedule metadata %p', async changes => {
  const f = fixture(); f.operation.mockResolvedValue(ack({ ...date, ...changes }));
  await f.api.create(); expect(f.api.getSnapshot()).toMatchObject({ status: 'retry', dates: [] });
});
it('rejects valid but mismatched ACK recurrence and policy independently', async () => {
  const f = fixture(); f.operation.mockResolvedValue(ack({ ...date, recurrence: 'annual', leapDayPolicy: 'feb28' }));
  await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
  const g = fixture(); g.api.setRecurrence('annual'); g.api.setLeapDayPolicy('mar1');
  g.operation.mockResolvedValue(ack({ ...date, recurrence: 'annual', leapDayPolicy: 'feb28' }));
  await g.api.create(); expect(g.api.getSnapshot().status).toBe('retry');
});
it('validates trusted date metadata independently of spoofed device clock', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2100-12-31T23:59:59Z'));
  try {
    const f = fixture(); const item = { ...date, recurrence: 'annual', leapDayPolicy: 'mar1', asOfLocalDate: '2029-02-28', nextOccurrence: '2029-03-01' };
    f.operation.mockResolvedValue(envelope({ dates: [item], limit: 50 })); await f.api.list();
    expect(f.api.getSnapshot().dates).toEqual([item]);
    expect(validDate({ ...item, asOfLocalDate: null, nextOccurrence: null }, context)).toBe(true);
    expect(validDate({ ...date, asOfLocalDate: '9999-12-31', nextOccurrence: null }, context)).toBe(true);
  } finally { jest.useRealTimers(); }
});
it.each([1900, 2000, 2100])('validates Gregorian policy results in year %s', year => {
  for (const policy of ['leap_years_only', 'feb28', 'mar1'] as LeapDayPolicy[]) {
    const item = { ...date, localDate: '1896-02-29', recurrence: 'annual', leapDayPolicy: policy,
      asOfLocalDate: `${year}-02-28`, nextOccurrence: nextOccurrence('1896-02-29', 'annual', policy, `${year}-02-28`) };
    expect(validDate(item, context)).toBe(true);
  }
});
it.each(['ru', 'en'] as const)('exposes neutral explicit recurrence/policy choices and honest manual metadata in %s', locale => {
  const f = fixture(), t = datesCopy[locale];
  const p = { locale, onDraft: f.api.setDraft, onLocalDate: f.api.setLocalDate, onTimezone: f.api.setTimezone,
    onRecurrence: f.api.setRecurrence, onLeapDayPolicy: f.api.setLeapDayPolicy, onCreate: f.api.create,
    onRetry: f.api.retry, onList: f.api.list, onCancel: f.api.cancel };
  const ui = render(<DatesPanel {...p} view={f.api.getSnapshot()} />);
  fireEvent.press(screen.getByText(t.annual)); ui.rerender(<DatesPanel {...p} view={f.api.getSnapshot()} />);
  expect(f.api.getSnapshot().leapDayPolicy).toBeNull(); expect(screen.getByText(t.leapChoice)).toBeTruthy();
  for (const policy of ['leap_years_only', 'feb28', 'mar1'] as const) {
    fireEvent.press(screen.getByText(t[policy])); expect(f.api.getSnapshot().leapDayPolicy).toBe(policy);
  }
  const item = { ...date, recurrence: 'annual' as const, leapDayPolicy: 'mar1' as const };
  ui.rerender(<DatesPanel {...p} view={{ ...f.api.getSnapshot(), dates: [item], pending: item }} />);
  expect(screen.getByText(`${t.next} ${date.nextOccurrence}`)).toBeTruthy(); expect(screen.getByText(t.manualRefresh)).toBeTruthy();
  ui.rerender(<DatesPanel {...p} view={{ ...f.api.getSnapshot(), dates: [{ ...date, nextOccurrence: null }] }} />);
  expect(screen.getByText(t.noNext)).toBeTruthy();
  ui.rerender(<DatesPanel {...p} view={{ ...f.api.getSnapshot(), dates: [{ ...date, asOfLocalDate: null, nextOccurrence: null }] }} />);
  expect(screen.getByText(t.unknownToday)).toBeTruthy(); expect(screen.getByText(t.unknownNext)).toBeTruthy();
  fireEvent.press(screen.getAllByText(t.once)[0]); expect(f.api.getSnapshot().recurrence).toBe('once');
});
it.each(['once', 'annual'] as const)('unknown ACK cannot rewrite original %s when new draft changes recurrence', async original => {
  const f = fixture(); f.api.setRecurrence(original);
  if (original === 'annual') f.api.setLeapDayPolicy('feb28');
  f.operation.mockResolvedValueOnce(error('temporary', 503)); await f.api.create();
  f.api.setRecurrence(original === 'once' ? 'annual' : 'once');
  if (original === 'once') f.api.setLeapDayPolicy('mar1');
  f.operation.mockResolvedValue(ack({ ...date, recurrence: original, leapDayPolicy: original === 'annual' ? 'feb28' : null }));
  await f.api.retry();
  expect(await f.operation.mock.calls[1][0].json()).toEqual(await f.operation.mock.calls[0][0].json());
  expect(f.api.getSnapshot()).toMatchObject({ status: 'saved', recurrence: original === 'once' ? 'annual' : 'once',
    leapDayPolicy: original === 'once' ? 'mar1' : null });
});
