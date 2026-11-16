import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';
import { DailyQuestionsPanel } from '../src/auth/DailyQuestionsPanel';
import { dailyQuestionsCopy } from '../src/auth/dailyQuestionsCopy';
import type { DailyQuestionsActions } from '../src/auth/daily-questions';
import { emptyDailyQuestions, type DailyView } from '../src/auth/daily-questions-state';
import { createDailySlot } from '../../../packages/domain/daily-question/slot';
import { createDailyAnswerMetadata } from '../../../packages/domain/daily-question/metadata';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { coupleId: id(1), userId: id(2), membershipEpoch: 1 }, at = '2026-11-16T08:00:00.000Z';
const slot = createDailySlot({ id: id(4), participantIds: [id(2), id(3)], timezone: 'UTC' }, scope, at)!;
const own = createDailyAnswerMetadata({ id: id(5) }, slot, scope, at, true)!;
const partner = { ...own, id: id(6), authorId: id(3) };
const today = { day: slot.day, timezone: slot.timezone, catalogVersion: slot.catalogVersion, promptId: slot.promptId, promptRU: slot.promptRU, promptEN: slot.promptEN };
const prose = 'Synthetic displayed private answer';
const reader = { slot, answer: own, text: prose, checkedAt: at, generation: 1 };
function fixture(patch: Partial<DailyView> = {}) {
 let view: DailyView = { ...emptyDailyQuestions, generation: 1, revision: 1, available: true, userId: scope.userId, checked: true, today, checkedAt: at, ...patch };
 const listeners = new Set<() => void>();
 const update = (patch: Partial<DailyView>) => { view = { ...view, ...patch }; for (const listener of listeners) listener(); };
 const api: DailyQuestionsActions = {
  getSnapshot: () => view, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  refresh: jest.fn(async () => {}), loadMore: jest.fn(async () => {}), create: jest.fn(async () => {}), rewrite: jest.fn(async () => {}),
  remove: jest.fn(async () => update({ reader: null, readerStatus: 'closed' })), read: jest.fn(async () => {}), retry: jest.fn(async () => {}),
  close: jest.fn(() => update({ reader: null, readerStatus: 'closed' })),
  setDraft: jest.fn(draft => update({ draft, revision: view.revision + 1 })), cancelDraft: jest.fn(() => update({ draft: '', revision: view.revision + 1 })),
  leaveScreen: jest.fn(() => update({ draft: '', reader: null, readerStatus: 'closed', pending: false, generation: view.generation + 1, revision: view.revision + 1 })),
 };
 return { api, update };
}
const readLabel = (t: typeof dailyQuestionsCopy.en | typeof dailyQuestionsCopy.ru, ownAnswer = true) => `${t.read} · ${slot.day} · ${ownAnswer ? t.own : t.partner}`;
for (const locale of ['ru', 'en'] as const) for (const platform of ['ios', 'android'] as const) {
 it(`discloses historical visibility before confirmed creation in ${locale}/${platform}`, () => {
  const replace = jest.replaceProperty(Platform, 'OS', platform), f = fixture(), t = dailyQuestionsCopy[locale];
  try {
   render(<DailyQuestionsPanel controller={f.api} locale={locale}/>);
   expect(screen.getByText(t.disclosure)).toBeTruthy(); expect(screen.getByText(t.ram)).toBeTruthy();
   expect(screen.getByText(locale === 'ru' ? today.promptRU : today.promptEN)).toBeTruthy();
   expect(screen.getByText(t.noDays)).toBeTruthy(); expect(screen.getByLabelText(t.draftLabel).props.multiline).toBe(true);
   fireEvent.changeText(screen.getByLabelText(t.draftLabel), '🦉🦉'); expect(screen.getByText(`${t.characters} 2/2000`)).toBeTruthy();
   fireEvent.press(screen.getByRole('button', { name: t.submit })); expect(f.api.create).not.toHaveBeenCalled();
   expect(screen.getByText(t.confirmCreate)).toBeTruthy(); expect(screen.getAllByText(t.disclosure)).toHaveLength(2);
   expect(screen.getByText(`${slot.day} · ${slot.timezone}`)).toBeTruthy();
   fireEvent.press(screen.getByRole('button', { name: t.cancel })); expect(screen.queryByText(t.confirmCreate)).toBeNull();
   fireEvent.press(screen.getByRole('button', { name: t.submit })); const confirm = screen.getByRole('button', { name: t.confirm });
   fireEvent.press(confirm); fireEvent.press(confirm); expect(f.api.create).toHaveBeenCalledTimes(1); expect(f.api.create).toHaveBeenCalledWith(true);
   fireEvent.press(screen.getByRole('button', { name: t.skip })); expect(f.api.getSnapshot().draft).toBe(''); expect(f.api.create).toHaveBeenCalledTimes(1);
   fireEvent.press(screen.getByRole('button', { name: t.clear })); fireEvent.press(screen.getByRole('button', { name: t.refresh })); expect(f.api.refresh).toHaveBeenCalledTimes(1);
  } finally { replace.restore(); }
 });
}
it('never autoloads bodies; explicit current own read enables edit without prefill or history completeness', () => {
 const f = fixture({ slots: [{ slot, answers: [own, partner] }] }), t = dailyQuestionsCopy.en;
 render(<DailyQuestionsPanel controller={f.api} locale="en"/>); expect(f.api.read).not.toHaveBeenCalled();
 expect(screen.getByRole('button', { name: t.edit })).toBeDisabled(); expect(screen.getByRole('button', { name: t.submit })).toBeDisabled();
 fireEvent.press(screen.getByRole('button', { name: readLabel(t) })); expect(f.api.read).toHaveBeenCalledWith(own.id);
 act(() => f.update({ reader, readerStatus: 'opened', checked: false }));
 expect(screen.getByText(prose).props.selectable).toBe(true); expect(screen.getByLabelText(t.draftLabel).props.value).toBe('');
 expect(screen.getByRole('button', { name: t.edit })).toBeEnabled();
 fireEvent.changeText(screen.getByLabelText(t.draftLabel), 'New original text'); fireEvent.press(screen.getByRole('button', { name: t.edit }));
 expect(screen.getByText(t.confirmRewrite)).toBeTruthy(); fireEvent.press(screen.getByRole('button', { name: t.confirm })); expect(f.api.rewrite).toHaveBeenCalledWith(own.id, true);
 fireEvent.press(screen.getByRole('button', { name: t.close })); expect(screen.queryByText(prose)).toBeNull();
 fireEvent.press(screen.getByRole('button', { name: readLabel(t, false) })); expect(f.api.read).toHaveBeenCalledWith(partner.id);
});
it.each(['revision', 'version', 'generation', 'actor', 'reader', 'day', 'descriptor', 'replacement'] as const)('stale %s invalidates confirmation', changed => {
 const f = fixture({ slots: [{ slot, answers: [own] }], reader, readerStatus: 'opened' }), t = dailyQuestionsCopy.en;
 const mounted = render(<DailyQuestionsPanel controller={f.api} locale="en"/>); fireEvent.press(screen.getByRole('button', { name: t.edit }));
 const stale = screen.getByRole('button', { name: t.confirm });
 if (changed === 'revision') fireEvent.changeText(screen.getByLabelText(t.draftLabel), 'New');
 if (changed === 'version') act(() => f.update({ slots: [{ slot, answers: [{ ...own, version: 2 }] }] }));
 if (changed === 'generation') act(() => f.update({ generation: 2 }));
 if (changed === 'actor') act(() => f.update({ userId: partner.authorId }));
 if (changed === 'reader') act(() => f.update({ reader: { ...reader } }));
 if (changed === 'descriptor') act(() => f.update({ today: { ...today } }));
 if (changed === 'day') act(() => f.update({ today: { ...today, day: '2026-11-17' } }));
 if (changed === 'replacement') mounted.rerender(<DailyQuestionsPanel controller={fixture({ slots: [{ slot, answers: [own] }], reader, readerStatus: 'opened' }).api} locale="en"/>);
 expect(screen.queryByText(t.confirmRewrite)).toBeNull(); fireEvent.press(stale); expect(f.api.rewrite).not.toHaveBeenCalled();
});
it('remove is confirmed, closes a partner reader immediately, and leaves a terminal tombstone', () => {
 const f = fixture({ slots: [{ slot, answers: [own, partner] }], reader: { ...reader, answer: partner }, readerStatus: 'opened' }), t = dailyQuestionsCopy.en;
 render(<DailyQuestionsPanel controller={f.api} locale="en"/>);
 fireEvent.press(screen.getByRole('button', { name: `${t.remove} · ${slot.day}` })); expect(screen.getByText(t.confirmRemove)).toBeTruthy();
 fireEvent.press(screen.getByRole('button', { name: t.confirm })); expect(f.api.remove).toHaveBeenCalledWith(own.id, true); expect(screen.queryByText(prose)).toBeNull();
 act(() => f.update({ slots: [{ slot, answers: [{ ...own, contentState: 'removed', version: 2, removedAt: at }] }] }));
 expect(screen.getByText(t.removed)).toBeTruthy(); expect(screen.getByRole('button', { name: t.submit })).toBeDisabled(); expect(screen.queryByRole('button', { name: t.edit })).toBeNull();
});
it('past own answers can be read or removed but not rewritten; earlier pages load explicitly', () => {
 const f = fixture({ slots: [{ slot, answers: [own] }], today: { ...today, day: '2026-11-17' }, hasMore: true, nextBeforeDay: slot.day }), t = dailyQuestionsCopy.en;
 render(<DailyQuestionsPanel controller={f.api} locale="en"/>); expect(screen.queryByRole('button', { name: t.edit })).toBeNull();
 fireEvent.press(screen.getByRole('button', { name: readLabel(t) })); expect(f.api.read).toHaveBeenCalledWith(own.id);
 fireEvent.press(screen.getByRole('button', { name: t.loadMore })); expect(f.api.loadMore).toHaveBeenCalledTimes(1);
 expect(screen.getByText(t.historyNotice)).toBeTruthy();
});
it.each(['loading', 'changed', 'error'] as const)('reader %s state shows no unconfirmed body', readerStatus => {
 const f = fixture({ readerStatus }), t = dailyQuestionsCopy.en; render(<DailyQuestionsPanel controller={f.api} locale="en"/>);
 expect(screen.getByText(readerStatus === 'loading' ? t.reading : readerStatus === 'changed' ? t.readerChanged : t.readerError)).toBeTruthy(); expect(screen.queryByText(prose)).toBeNull();
});
it('offline pending keeps same retry and blocks mutations, leaving/background scrubs private RAM', () => {
 const f = fixture({ pending: true, status: 'retry', error: true, draft: prose }), t = dailyQuestionsCopy.en;
 const mounted = render(<DailyQuestionsPanel controller={f.api} locale="en"/>);
 expect(screen.getByText(t.pending)).toBeTruthy(); expect(screen.getByText(t.error)).toBeTruthy(); expect(screen.getByRole('button', { name: t.submit })).toBeDisabled();
 fireEvent.press(screen.getByRole('button', { name: t.retry })); expect(f.api.retry).toHaveBeenCalledTimes(1);
 const callback = jest.mocked(AppState.addEventListener).mock.calls.filter(call => call[0] === 'change').at(-1)![1];
 act(() => callback('active')); expect(f.api.leaveScreen).not.toHaveBeenCalled(); act(() => callback('background')); expect(f.api.leaveScreen).toHaveBeenCalledTimes(1);
 expect(f.api.getSnapshot().draft).toBe(''); mounted.unmount(); expect(f.api.leaveScreen).toHaveBeenCalledTimes(2);
});
it.each(['saving', 'saved', 'invalid', 'conflict', 'unavailable'] as const)('renders status %s with accessible live feedback', status => {
 render(<DailyQuestionsPanel controller={fixture({ status }).api} locale="ru"/>); expect(screen.getByText(dailyQuestionsCopy.ru[status]).props.accessibilityLiveRegion).toBe('polite');
});
it('requires available checked server state for creation and never renders a mismatched reader', () => {
 const f = fixture({ checked: false, today: null, checkedAt: null, reader, readerStatus: 'opened' });
 const mounted = render(<DailyQuestionsPanel controller={f.api} locale="en"/>);
 expect(screen.getByRole('button', { name: dailyQuestionsCopy.en.submit })).toBeDisabled(); expect(screen.queryByText(prose)).toBeNull();
 act(() => f.update({ available: false })); expect(screen.queryByText(dailyQuestionsCopy.en.title)).toBeNull(); mounted.unmount();
});

it('locks today partner reading without own active answer and disables pagination until refresh', () => {
 const f = fixture({ slots: [{ slot, answers: [partner] }], hasMore: true, nextBeforeDay: slot.day, requiresRefresh: true }), t = dailyQuestionsCopy.en;
 render(<DailyQuestionsPanel controller={f.api} locale="en"/>);
 expect(screen.getByRole('button', { name: readLabel(t, false) })).toBeDisabled(); expect(screen.getByRole('button', { name: t.loadMore })).toBeDisabled();
 act(() => f.update({ requiresRefresh: false }));
 expect(screen.getByRole('button', { name: readLabel(t, false) })).toBeDisabled();
 act(() => f.update({ checkedAt: '2026-11-17T08:00:00.000Z', today: { ...today, day: '2026-11-17' } }));
 expect(screen.getByRole('button', { name: readLabel(t, false) })).toBeEnabled();
});
