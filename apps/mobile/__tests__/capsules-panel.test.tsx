import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';
import * as live from './capsules-fixtures';
import { CapsulesPanel } from '../src/auth/CapsulesPanel';
import { CapsuleReader } from '../src/auth/CapsuleReader';
import { capsulesCopy } from '../src/auth/capsulesCopy';
import type { CapsulesActions } from '../src/auth/capsules';
import type { CapsuleView } from '../src/auth/capsules-state';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const early = '2026-11-15T15:00:00.000Z', due = '2026-11-16T06:00:00.000Z';
const own: CapsuleView['capsules'][number] = { id: uuid(9), coupleId: uuid(2), authorId: uuid(1), membershipEpoch: 1,
  version: 1, createdAt: early, sealedAt: early, releaseAt: due, localDate: '2026-11-16', localTime: '09:00', timezone: 'Europe/Moscow', offset: '+03:00', contentState: 'active' };
const prose = 'Synthetic private letter\n\nSecond paragraph';
function fixture(patch: Partial<CapsuleView> = {}) {
  let view: CapsuleView = { generation: 1, revision: 0, available: true, userId: uuid(1), busy: false, checked: true, checkedAt: early,
    capsules: [], capacity: 1, used: 0, draft: '', schedule: { localDate: '', localTime: '', timezone: '', offset: '' },
    reader: null, readerStatus: 'closed', pending: false, requiresRefresh: false, error: false, status: 'idle', ...patch };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<CapsuleView>) => { view = { ...view, ...patch }; for (const listener of listeners) listener(); };
  const api: CapsulesActions = {
    getSnapshot: () => view, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: jest.fn(async () => {}), retry: jest.fn(async () => {}), create: jest.fn(async () => {}), reseal: jest.fn(async () => {}),
    remove: jest.fn(async () => {}), read: jest.fn(async () => {}), close: jest.fn(() => update({ reader: null, readerStatus: 'closed' })),
    setDraft: jest.fn(draft => update({ draft, revision: view.revision + 1 })), cancelDraft: jest.fn(() => update({ draft: '', revision: view.revision + 1 })),
    setSchedule: jest.fn((field, value) => update({ schedule: { ...view.schedule, [field]: value }, revision: view.revision + 1 })),
    suggestYear: jest.fn(), leaveScreen: jest.fn(() => update({ draft: '', reader: null, readerStatus: 'closed', pending: false, generation: view.generation + 1, revision: view.revision + 1 })),
  };
  return { api, update };
}
for (const locale of ['ru', 'en'] as const) for (const platform of ['ios', 'android'] as const) {
  it(`requires explicit confirmation and labels calendar form in ${locale}/${platform}`, () => {
    const replacement = jest.replaceProperty(Platform, 'OS', platform), f = fixture(), t = capsulesCopy[locale];
    try {
      render(<CapsulesPanel controller={f.api} locale={locale}/>);
      expect(screen.getByText(t.notice)).toBeTruthy(); expect(screen.getByText(t.visibility)).toBeTruthy();
      for (const [field, value] of Object.entries({ localDate: '2027-01-01', localTime: '09:30', timezone: 'Europe/Moscow', offset: '+03:00' })) {
        const key = field as keyof CapsuleView['schedule'], input = screen.getByLabelText(t[key]);
        expect(input.props.autoCapitalize).toBe('none'); expect(input.props.autoCorrect).toBe(false);
        fireEvent.changeText(input, value); expect(f.api.setSchedule).toHaveBeenCalledWith(key, value);
      }
      fireEvent.changeText(screen.getByLabelText(t.draftLabel), '🦉🦉'); expect(screen.getByText(`${t.characters} 2/2000`)).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: t.suggest })); expect(f.api.suggestYear).toHaveBeenCalledTimes(1);
      fireEvent.press(screen.getByRole('button', { name: t.seal })); expect(f.api.create).not.toHaveBeenCalled();
      expect(screen.getByText(t.confirmCreate)).toBeTruthy(); fireEvent.press(screen.getByRole('button', { name: t.cancel }));
      fireEvent.press(screen.getByRole('button', { name: t.seal }));
      const confirmation = screen.getByRole('button', { name: t.confirm });
      fireEvent.press(confirmation); fireEvent.press(confirmation); expect(f.api.create).toHaveBeenCalledTimes(1);
      expect(f.api.create).toHaveBeenCalledWith(true);
      fireEvent.press(screen.getByRole('button', { name: t.cancelDraft })); expect(f.api.getSnapshot().draft).toBe('');
      fireEvent.press(screen.getByRole('button', { name: t.load })); expect(f.api.load).toHaveBeenCalledTimes(1);
    } finally { replacement.restore(); }
  });
}
it('ignores device time, permits reseal only before old server due and reads only explicitly after due', () => {
  const f = fixture({ capsules: [own], used: 1 }), t = capsulesCopy.en;
  const time = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2099-01-01'));
  try {
    render(<CapsulesPanel controller={f.api} locale="en"/>);
    expect(screen.queryByRole('button', { name: t.read })).toBeNull(); expect(screen.getByText(t.waiting)).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: t.reseal })); expect(screen.getByText(t.confirmReseal)).toBeTruthy();
    act(() => f.update({ checkedAt: due })); expect(screen.queryByText(t.confirmReseal)).toBeNull();
    expect(screen.queryByRole('button', { name: t.reseal })).toBeNull(); expect(f.api.read).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: t.read })); expect(f.api.read).toHaveBeenCalledWith(own.id);
    act(() => f.update({ reader: { capsule: own, text: prose, checkedAt: due }, readerStatus: 'opened' }));
    expect(screen.getByText(prose).props.selectable).toBe(true);
    fireEvent.press(screen.getByRole('button', { name: t.close })); expect(screen.queryByText(prose)).toBeNull();
  } finally { time.mockRestore(); }
});
it.each(['form', 'version', 'actor', 'generation', 'replacement'] as const)('invalidates confirmation when %s changes', change => {
  const f = fixture({ capsules: [own], used: 1 }), t = capsulesCopy.en;
  const rendered = render(<CapsulesPanel controller={f.api} locale="en"/>);
  fireEvent.press(screen.getByRole('button', { name: t.reseal })); const stale = screen.getByRole('button', { name: t.confirm });
  if (change === 'form') fireEvent.changeText(screen.getByLabelText(t.draftLabel), 'changed');
  if (change === 'version') act(() => f.update({ capsules: [{ ...own, version: 2 }] }));
  if (change === 'actor') act(() => f.update({ userId: uuid(4) }));
  if (change === 'generation') act(() => f.update({ generation: 2 }));
  if (change === 'replacement') rendered.rerender(<CapsulesPanel controller={fixture({ capsules: [own], used: 1 }).api} locale="en"/>);
  expect(screen.queryByText(t.confirmReseal)).toBeNull(); fireEvent.press(stale); expect(f.api.reseal).not.toHaveBeenCalled();
});
it('confirms reseal using only a new draft and removal leaves no create capacity', () => {
  const f = fixture({ capsules: [own], used: 1 }), t = capsulesCopy.ru; render(<CapsulesPanel controller={f.api} locale="ru"/>);
  expect(screen.getByLabelText(t.draftLabel).props.value).toBe('');
  fireEvent.changeText(screen.getByLabelText(t.draftLabel), 'New text');
  fireEvent.press(screen.getByRole('button', { name: t.reseal })); fireEvent.press(screen.getByRole('button', { name: t.confirm }));
  expect(f.api.reseal).toHaveBeenCalledWith(own.id, true);
  fireEvent.press(screen.getByRole('button', { name: t.remove })); expect(screen.getByText(t.confirmRemove)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: t.confirm })); expect(f.api.remove).toHaveBeenCalledWith(own.id, true);
  act(() => f.update({ capsules: [{ ...own, contentState: 'removed', version: 2 }] }));
  expect(screen.getByText(t.removed)).toBeTruthy(); expect(screen.getByRole('button', { name: t.seal })).toBeDisabled();
});
it('offline unknown commands expose retry but block new mutation and clear reader/draft on leaving', () => {
  const f = fixture({ pending: true, status: 'retry', error: true, draft: prose }), t = capsulesCopy.en;
  const rendered = render(<CapsulesPanel controller={f.api} locale="en"/>);
  expect(screen.getByText(t.pending)).toBeTruthy(); expect(screen.getByText(t.error)).toBeTruthy();
  expect(screen.getByRole('button', { name: t.seal })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: t.retry })); expect(f.api.retry).toHaveBeenCalledTimes(1);
  rendered.unmount(); expect(f.api.leaveScreen).toHaveBeenCalledTimes(1); expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.getSnapshot().pending).toBe(false);
});
it.each(['loading', 'changed', 'error'] as const)('shows safe reader %s state without text', readerStatus => {
  const f = fixture({ readerStatus }), t = capsulesCopy.en; render(<CapsulesPanel controller={f.api} locale="en"/>);
  expect(screen.getByText(readerStatus === 'loading' ? t.reading : readerStatus === 'changed' ? t.readerChanged : t.readerError)).toBeTruthy();
  expect(screen.queryByText(prose)).toBeNull();
});
it('does not render another author metadata or a stale reader', () => {
  const f = fixture({ capsules: [{ ...own, authorId: uuid(4) }], reader: { capsule: own, text: prose, checkedAt: due }, readerStatus: 'opened' });
  render(<CapsulesPanel controller={f.api} locale="en"/>); expect(screen.queryByText(prose)).toBeNull(); expect(screen.queryByText(`${capsulesCopy.en.utc} ${due}`)).toBeNull();
});
it.each([{ ...own, authorId: uuid(4) }, { ...own, contentState: 'removed' as const }, own])('reader refuses unauthorized or premature state %#', capsule => {
  render(<CapsuleReader reader={{ capsule, text: prose, checkedAt: early }} userId={uuid(1)} locale="en"/>); expect(screen.queryByText(prose)).toBeNull();
});
it('is absent when unavailable', () => {
  render(<CapsulesPanel controller={fixture({ available: false }).api} locale="en"/>); expect(screen.queryByText(capsulesCopy.en.title)).toBeNull();
});

it('backgrounding scrubs private state and invalidates a pending confirmation', () => {
  const listener = jest.mocked(AppState.addEventListener), f = fixture({ capsules: [own], used: 1, draft: prose }), t = capsulesCopy.en;
  try {
    render(<CapsulesPanel controller={f.api} locale="en"/>);
    fireEvent.press(screen.getByRole('button', { name: t.reseal })); expect(screen.getByText(t.confirmReseal)).toBeTruthy();
    const callback = listener.mock.calls.filter(call => call[0] === 'change').at(-1)![1];
    act(() => callback('background')); expect(f.api.leaveScreen).toHaveBeenCalledTimes(1);
    expect(f.api.getSnapshot().draft).toBe(''); expect(screen.queryByText(t.confirmReseal)).toBeNull();
    act(() => callback('active')); expect(f.api.leaveScreen).toHaveBeenCalledTimes(1);
    act(() => callback('inactive')); expect(f.api.leaveScreen).toHaveBeenCalledTimes(2);
  } finally { listener.mockClear(); }
});

it.each(['create', 'reseal'] as const)('real controller %s immediately hides submitted text through lost ACK and immutable retry', async kind => {
  const f = live.fixture(), t = capsulesCopy.en;
  await f.load(kind === 'create' ? [] : [live.own], live.before);
  f.schedule(kind === 'create' ? live.schedule : { ...live.schedule, localDate: '2026-11-13' });
  const held = live.deferred(); f.operation.mockImplementationOnce(() => held.promise);
  render(<CapsulesPanel controller={f.api} locale="en"/>);
  expect(screen.getByLabelText(t.draftLabel).props.value).toBe(live.prose);
  fireEvent.press(screen.getByRole('button', { name: kind === 'create' ? t.seal : t.reseal }));
  fireEvent.press(screen.getByRole('button', { name: t.confirm }));
  // Submission, not a successful response, must revoke the form's copy.
  expect(screen.getByLabelText(t.draftLabel).props.value).toBe('');
  expect(screen.queryByText(live.prose)).toBeNull(); expect(f.api.getSnapshot().draft).toBe('');
  await act(async () => { await live.settle(); });
  expect(f.api.getSnapshot().busy).toBe(true);
  await act(async () => { held.resolve(live.error('temporarily_unavailable', 503)); await live.settle(); });
  expect(f.api.getSnapshot().status).toBe('retry');
  expect(screen.getByLabelText(t.draftLabel).props.value).toBe(''); expect(screen.queryByText(live.prose)).toBeNull();
  // A later draft is unrelated to the hidden, immutable retry payload.
  fireEvent.changeText(screen.getByLabelText(t.draftLabel), 'A new unrelated draft');
  f.operation.mockResolvedValueOnce(live.ack(kind === 'create' ? live.own : live.resealed, true, live.uuid(3),
    kind === 'create' ? live.before : live.resealed.sealedAt));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.retry })); await live.settle(); });
  const original = await f.operation.mock.calls[1][0].json();
  expect(original.text).toBe(live.prose); expect(await f.operation.mock.calls[2][0].json()).toEqual(original);
  expect(f.api.getSnapshot().status).toBe('saved'); expect(f.api.getSnapshot().pending).toBe(false);
  expect(screen.getByLabelText(t.draftLabel).props.value).toBe('A new unrelated draft'); expect(screen.queryByText(live.prose)).toBeNull();
});
