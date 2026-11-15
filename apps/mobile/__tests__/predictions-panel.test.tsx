import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { PredictionsPanel } from '../src/auth/PredictionsPanel';
import { predictionsCopy } from '../src/auth/predictionsCopy';
import type { PredictionsActions } from '../src/auth/predictions';
import type { PredictionView } from '../src/auth/predictions-state';
import * as integration from './predictions-fixtures';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const due = '2026-11-16T06:00:00.000Z';
const incoming: PredictionView['predictions'][number] = { id: uuid(9), coupleId: uuid(2), authorId: uuid(4), recipientId: uuid(1),
  membershipEpoch: 1, version: 1, createdAt: '2026-11-15T15:00:00.000Z', releaseAt: due, localDate: '2026-11-16', localTime: '09:00',
  timezone: 'Europe/Moscow', offset: '+03:00', openedAt: null, declinedAt: null, contentState: 'active' };
const own = { ...incoming, authorId: uuid(1), recipientId: uuid(4) };
const opened = { ...incoming, openedAt: due, version: 2 };
const prose = 'Synthetic private prediction\n\nSecond paragraph';
let generation = 0;
function fixture(patch: Partial<PredictionView> = {}) {
  let view: PredictionView = { generation: ++generation, available: true, userId: uuid(1), busy: false,
    checked: true, checkedAt: due, predictions: [incoming], used: 1, capacity: 100, draft: '',
    schedule: { localDate: '', localTime: '', timezone: '', offset: '' }, reader: null, readerStatus: 'closed',
    pending: false, requiresRefresh: false, error: false, status: 'idle', ...patch };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<PredictionView>) => { view = { ...view, ...patch }; for (const listener of listeners) listener(); };
  const api: PredictionsActions = {
    getSnapshot: () => view, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: jest.fn(async () => {}), retry: jest.fn(async () => {}), create: jest.fn(async () => {}),
    open: jest.fn(async () => {}), decline: jest.fn(async () => {}), remove: jest.fn(async () => {}), read: jest.fn(async () => {}),
    close: jest.fn(() => update({ reader: null, readerStatus: 'closed' })),
    setDraft: jest.fn(draft => update({ draft })), cancelDraft: jest.fn(() => update({ draft: '', schedule: { localDate: '', localTime: '', timezone: '', offset: '' } })),
    setSchedule: jest.fn((field, value) => update({ schedule: { ...view.schedule, [field]: value } })),
  };
  return { api, update };
}
for (const locale of ['ru', 'en'] as const) for (const platform of ['ios', 'android'] as const) {
  it(`has explicit voluntary confirmation and accessible calendar inputs in ${locale}/${platform}`, () => {
    const replace = jest.replaceProperty(Platform, 'OS', platform);
    try {
      const f = fixture(), t = predictionsCopy[locale]; render(<PredictionsPanel controller={f.api} locale={locale}/>);
      expect(screen.queryByText(prose)).toBeNull(); expect(screen.getByText(t.notice)).toBeTruthy();
      expect(screen.getByText(t.draftLabel)).toBeTruthy(); expect(screen.getByText(`${t.asOf} ${due}`)).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` })); expect(screen.getByText(t.confirmOpen)).toBeTruthy();
      expect(f.api.open).not.toHaveBeenCalled();
      fireEvent.press(screen.getByRole('button', { name: t.cancel })); expect(screen.queryByText(t.confirmOpen)).toBeNull();
      fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` })); fireEvent.press(screen.getByRole('button', { name: t.confirm }));
      expect(f.api.open).toHaveBeenCalledWith(incoming.id, true); expect(screen.queryByText(t.confirmOpen)).toBeNull();
      for (const [field, value] of Object.entries({ localDate: '2027-01-01', localTime: '09:30', timezone: 'Europe/Moscow', offset: '+03:00' })) {
        const key = field as keyof PredictionView['schedule'];
        expect(screen.getByText(t[key])).toBeTruthy();
        const input = screen.getByLabelText(t[key]); expect(input.props.value).toBe('');
        expect(input.props.autoCapitalize).toBe('none'); expect(input.props.autoCorrect).toBe(false);
        fireEvent.changeText(input, value); expect(f.api.setSchedule).toHaveBeenCalledWith(key, value);
      }
      fireEvent.changeText(screen.getByLabelText(t.draftLabel), '🦉🦉'); expect(screen.getByText(`${t.characters} 2/2000`)).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: t.seal })); expect(f.api.create).toHaveBeenCalledWith(true);
      fireEvent.press(screen.getByRole('button', { name: t.cancelDraft })); expect(f.api.getSnapshot().draft).toBe('');
      fireEvent.press(screen.getByRole('button', { name: t.load })); expect(f.api.load).toHaveBeenCalledTimes(1);
    } finally { replace.restore(); }
  });
}
it('uses server check only: a future device date does not enable opening and rollback removes confirmation', () => {
  const f = fixture({ checkedAt: incoming.createdAt }), t = predictionsCopy.en;
  const date = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2099-01-01T00:00:00Z'));
  try {
    render(<PredictionsPanel controller={f.api} locale="en"/>);
    expect(screen.queryByRole('button', { name: `${t.open} 1` })).toBeNull(); expect(screen.getByText(t.waiting)).toBeTruthy();
    act(() => f.update({ checkedAt: due })); fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` }));
    expect(screen.getByText(t.confirmOpen)).toBeTruthy();
    act(() => f.update({ checkedAt: incoming.createdAt })); expect(screen.queryByText(t.confirmOpen)).toBeNull();
    expect(f.api.open).not.toHaveBeenCalled();
  } finally { date.mockRestore(); }
});
it('author can explicitly read before due; metadata lists never contain the body', () => {
  const f = fixture({ predictions: [own], checkedAt: own.createdAt }), t = predictionsCopy.ru;
  render(<PredictionsPanel controller={f.api} locale="ru"/>);
  expect(screen.queryByRole('button', { name: `${t.open} 1` })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: `${t.readOwn} 1` })); expect(f.api.read).toHaveBeenCalledWith(own.id);
  act(() => f.update({ reader: { prediction: own, text: prose, checkedAt: own.createdAt }, readerStatus: 'opened' }));
  expect(screen.getByText(prose).props.selectable).toBe(true); expect(screen.getByText(t.ownView)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: t.close })); expect(screen.queryByText(prose)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: `${t.remove} 1` })); expect(screen.getByText(t.confirmRemove)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: t.confirm })); expect(f.api.remove).toHaveBeenCalledWith(own.id, true);
});
it('allows refusal while sealed and reports its terminal result without exposing text', () => {
  const f = fixture({ checkedAt: incoming.createdAt }), t = predictionsCopy.en; render(<PredictionsPanel controller={f.api} locale="en"/>);
  fireEvent.press(screen.getByRole('button', { name: `${t.decline} 1` })); expect(screen.getByText(t.confirmDecline)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: t.confirm })); expect(f.api.decline).toHaveBeenCalledWith(incoming.id, true);
  act(() => f.update({ predictions: [{ ...incoming, declinedAt: incoming.createdAt, version: 2 }] }));
  expect(screen.getByText(t.declined)).toBeTruthy(); expect(screen.queryByRole('button', { name: `${t.decline} 1` })).toBeNull();
  expect(screen.queryByRole('button', { name: `${t.open} 1` })).toBeNull(); expect(screen.queryByText(prose)).toBeNull();
});
it('opened reader is explicit, shows schedule and can be read again until removed', () => {
  const f = fixture({ predictions: [opened] }), t = predictionsCopy.en; render(<PredictionsPanel controller={f.api} locale="en"/>);
  fireEvent.press(screen.getByRole('button', { name: `${t.readOpened} 1` })); expect(f.api.read).toHaveBeenCalledWith(opened.id);
  act(() => f.update({ reader: { prediction: opened, text: prose, checkedAt: due }, readerStatus: 'opened' }));
  expect(screen.getByText(t.openedView)).toBeTruthy(); expect(screen.getByText(prose)).toBeTruthy();
  expect(screen.getAllByText(`${t.utc} ${due}`).length).toBe(2);
  act(() => f.update({ predictions: [{ ...opened, contentState: 'removed', version: 3 }], reader: null }));
  expect(screen.getByText(t.removed)).toBeTruthy(); expect(screen.queryByText(prose)).toBeNull();
  expect(screen.queryByRole('button', { name: `${t.readOpened} 1` })).toBeNull();
});
it('generation reset, version changes and controller replacement clear stale confirmations; cleanup closes only old instance', () => {
  const f = fixture(), g = fixture({ predictions: [own], reader: { prediction: own, text: prose, checkedAt: due }, readerStatus: 'opened' }), t = predictionsCopy.ru;
  const mounted = render(<PredictionsPanel controller={f.api} locale="ru"/>);
  fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` }));
  act(() => f.update({ generation: ++generation })); expect(screen.queryByText(t.confirmOpen)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` }));
  act(() => f.update({ predictions: [opened] })); expect(screen.queryByText(t.confirmOpen)).toBeNull();
  act(() => f.update({ predictions: [incoming] })); fireEvent.press(screen.getByRole('button', { name: `${t.decline} 1` }));
  mounted.rerender(<PredictionsPanel controller={g.api} locale="ru"/>);
  expect(screen.queryByText(t.confirmDecline)).toBeNull(); expect(f.api.close).toHaveBeenCalledTimes(1); expect(g.api.close).not.toHaveBeenCalled();
  expect(screen.getByText(prose)).toBeTruthy(); mounted.unmount(); expect(g.api.close).toHaveBeenCalledTimes(1);
});
it('StrictMode unmount calls display cancellation and unavailable state renders no private controls', () => {
  const f = fixture(), t = predictionsCopy.en; const mounted = render(<StrictMode><PredictionsPanel controller={f.api} locale="en"/></StrictMode>);
  act(() => f.update({ available: false, reader: null })); expect(screen.queryByText(t.title)).toBeNull();
  mounted.unmount(); expect(f.api.close).toHaveBeenCalled();
});
it('pending, failed reader, changed reader, capacity, refresh and empty states are honest and disable new choices', () => {
  const f = fixture({ pending: true, status: 'retry', readerStatus: 'error', error: true }), t = predictionsCopy.ru;
  render(<PredictionsPanel controller={f.api} locale="ru"/>);
  expect(screen.getByText(t.pending)).toBeTruthy(); expect(screen.getByText(t.readerError)).toBeTruthy(); expect(screen.getByText(t.error)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` })); expect(screen.queryByText(t.confirmOpen)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: t.retry })); expect(f.api.retry).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('button', { name: t.close })); expect(f.api.close).toHaveBeenCalled();
  act(() => f.update({ pending: false, busy: true, readerStatus: 'loading', status: 'saving' })); expect(screen.getByText(t.reading)).toBeTruthy();
  act(() => f.update({ busy: false, readerStatus: 'changed', status: 'not_due', checked: false, requiresRefresh: true }));
  expect(screen.getByText(t.readerChanged)).toBeTruthy(); expect(screen.getByText(t.unchecked)).toBeTruthy(); expect(screen.getByText(t.not_due)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: t.seal })); expect(f.api.create).not.toHaveBeenCalled();
  act(() => f.update({ checked: true, requiresRefresh: false, used: 100 })); fireEvent.press(screen.getByRole('button', { name: t.seal })); expect(f.api.create).not.toHaveBeenCalled();
  act(() => f.update({ used: 0, predictions: [], checkedAt: null })); expect(screen.getByText(t.empty)).toBeTruthy();
});

for (const locale of ['ru', 'en'] as const) it(`removed metadata preserves decisions without calling withdrawn content sealed: ${locale}`, () => {
  const f = fixture({ predictions: [{ ...incoming, contentState: 'removed', version: 2 }] }), t = predictionsCopy[locale];
  render(<PredictionsPanel controller={f.api} locale={locale}/>);
  expect(screen.getByText(t.withdrawn)).toBeTruthy(); expect(screen.getByText(t.removed)).toBeTruthy(); expect(screen.queryByText(t.sealed)).toBeNull();
  expect(screen.queryByRole('button', { name: `${t.open} 1` })).toBeNull();
  act(() => f.update({ predictions: [{ ...opened, contentState: 'removed', version: 3 }] }));
  expect(screen.getByText(t.opened)).toBeTruthy(); expect(screen.queryByText(t.withdrawn)).toBeNull();
  act(() => f.update({ predictions: [{ ...incoming, declinedAt: due, contentState: 'removed', version: 3 }] }));
  expect(screen.getByText(t.declined)).toBeTruthy(); expect(screen.queryByText(t.withdrawn)).toBeNull();
});

it('real controller opening ACK remains body-free; explicit read and unmount fence late private responses', async () => {
  const f = integration.fixture(), t = predictionsCopy.en;
  await f.load([integration.incoming]);
  const mounted = render(<PredictionsPanel controller={f.api} locale="en"/>);
  fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` })); f.operation.mockResolvedValueOnce(integration.ack(integration.opened));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.confirm })); await integration.settle(); });
  expect(f.api.getSnapshot().predictions[0]).toEqual(integration.opened); expect(f.api.getSnapshot().reader).toBeNull();
  expect(screen.queryByText(integration.prose)).toBeNull();
  const late = integration.deferred(); f.operation.mockImplementationOnce(() => late.promise);
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: `${t.readOpened} 1` })); await integration.settle(); });
  expect(f.api.getSnapshot().readerStatus).toBe('loading'); mounted.unmount();
  await act(async () => { late.resolve(integration.detail()); await integration.settle(); });
  expect(f.api.getSnapshot().reader).toBeNull();
  render(<PredictionsPanel controller={f.api} locale="en"/>); expect(screen.queryByText(integration.prose)).toBeNull();
  f.operation.mockResolvedValueOnce(integration.detail());
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: `${t.readOpened} 1` })); await integration.settle(); });
  expect(screen.getByText(integration.prose)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: t.close })); expect(f.api.getSnapshot().reader).toBeNull();
});
