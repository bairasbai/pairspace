import { fireEvent, render } from '@testing-library/react-native';
import { MorningsPanel, morningCopy } from '../src/auth/MorningsPanel';
import { fixture, id, slot } from './mornings.fixture';
import type { MorningView } from '../src/auth/mornings';
for (const locale of ['ru', 'en'] as const) {
  test(`${locale}: recipient privacy, explicit opening, exact immutable snapshot`, () => {
    const f = fixture(), t = morningCopy[locale], open = jest.fn(), close = jest.fn();
    const incoming = { ...slot(10, true), state: 'available' as const };
    const view: MorningView = { ...f.actions.getSnapshot(), selected: incoming };
    const screen = render(<MorningsPanel locale={locale} view={view} actions={{ ...f.actions, open, close }} />);
    screen.getByText('2030-01-02 09:00 · UTC +00:00 · UTC 2030-01-02T09:00:00.000Z');
    screen.getByText(t.openNotice); screen.getByText(t.notice);
    expect(screen.queryByText(t.prepared)).toBeNull(); expect(screen.queryByText(t.unprepared)).toBeNull();
    expect(screen.queryByLabelText(t.body)).toBeNull(); expect(open).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText(t.open)); expect(open).toHaveBeenCalledWith(id(10));
    screen.rerender(<MorningsPanel locale={locale} view={{ ...view, selected: { ...incoming, openedAt: incoming.releaseAt },
      opened: { slot: incoming, body: 'line one\nline two' } }} actions={{ ...f.actions, open, close }} />);
    screen.getByText(t.reread); screen.getByText('line one\nline two');
    fireEvent.press(screen.getByText(t.close)); expect(close).toHaveBeenCalledTimes(1);
  });
  test(`${locale}: fold requires explicit choice and confirmation cancel never sends`, () => {
    const f = fixture(), t = morningCopy[locale], chooseOffset = jest.fn(), cancelConfirmation = jest.fn(), confirm = jest.fn();
    const view: MorningView = { ...f.actions.getSnapshot(), localDate: '2030-11-03', preferences: [
      { userId: id(2), timezone: 'America/New_York', localTime: '01:30', version: 1 }],
      choices: [{ offset: '-04:00', releaseAt: '2030-11-03T05:30:00.000Z' }, { offset: '-05:00', releaseAt: '2030-11-03T06:30:00.000Z' }] };
    const actions = { ...f.actions, chooseOffset, cancelConfirmation, confirm };
    const screen = render(<MorningsPanel locale={locale} view={view} actions={actions} />);
    screen.getByText(t.choice); expect(chooseOffset).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText('-05:00 · UTC 2030-11-03T06:30:00.000Z')); expect(chooseOffset).toHaveBeenCalledWith('-05:00');
    screen.rerender(<MorningsPanel locale={locale} view={{ ...view, confirmation: { token: 'token', kind: 'assign',
      preference: view.preferences[0], localDate: view.localDate, offset: '-05:00', releaseAt: view.choices[1].releaseAt } }} actions={actions} />);
    screen.getByText(t.assignment); fireEvent.press(screen.getByText(t.cancel)); expect(cancelConfirmation).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
  });
  test(`${locale}: sender fill is explicit; missed differs from empty; controls preserve drafts`, async () => {
    const f = fixture(), t = morningCopy[locale]; await f.actions.list(); f.actions.selectSlot(id(10));
    const requestFill = jest.fn(), setDraft = jest.fn(), clearDraft = jest.fn(), selectSlot = jest.fn();
    const actions = { ...f.actions, requestFill, setDraft, clearDraft, selectSlot };
    const view = f.actions.getSnapshot();
    const screen = render(<MorningsPanel locale={locale} view={view} actions={actions} />);
    screen.getByText(t.unprepared); expect(screen.queryByText(t.reread)).toBeNull();
    fireEvent.changeText(screen.getByLabelText(t.body), 'new draft'); expect(setDraft).toHaveBeenCalledWith('new draft');
    fireEvent.press(screen.getByText(t.fill)); expect(requestFill).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByText(t.clear)); expect(clearDraft).toHaveBeenCalled();
    screen.rerender(<MorningsPanel locale={locale} view={{ ...view, slots: [], selected: null, savedDraftSlots: [slot(10)],
      error: 'draft_limit' }} actions={actions} />);
    screen.getByText(t.empty); screen.getByText(t.draftLimit); expect(screen.queryByText(t.missed)).toBeNull();
    fireEvent.press(screen.getByText(`${t.saved}: 2030-01-02 09:00`)); expect(selectSlot).toHaveBeenCalledWith(id(10));
    screen.rerender(<MorningsPanel locale={locale} view={{ ...view, slots: [{ ...slot(), state: 'missed' }], selected: null }} actions={actions} />);
    screen.getByText(t.missed); expect(screen.queryByText(t.empty)).toBeNull();
  });
  test(`${locale}: inactive panel is absent; gap/pending/error are honest and retry explicit`, () => {
    const f = fixture(), t = morningCopy[locale], retry = jest.fn(), confirm = jest.fn();
    const screen = render(<MorningsPanel locale={locale} view={{ ...f.actions.getSnapshot(), available: false }} actions={f.actions} />);
    expect(screen.queryByText(t.title)).toBeNull();
    screen.rerender(<MorningsPanel locale={locale} view={{ ...f.actions.getSnapshot(), localDate: '2030-03-10',
      preferences: [{ userId: id(2), timezone: 'UTC', localTime: '09:00', version: 1 }], pendingId: id(55), error: 'offline',
      confirmation: { token: 'fill-token', kind: 'fill', slot: slot() } }} actions={{ ...f.actions, retry, confirm }} />);
    screen.getByText(t.gap); screen.getByText(t.pending); screen.getByText(t.error); screen.getByText(t.fillNotice);
    expect(retry).not.toHaveBeenCalled(); fireEvent.press(screen.getByText(t.retry)); expect(retry).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByText(t.confirm)); expect(confirm).toHaveBeenCalledWith('fill-token');
  });
}
test('all navigation and preference controls dispatch only explicit input', () => {
  const f = fixture(), t = morningCopy.en;
  const list = jest.fn(), oldest = jest.fn(), latest = jest.fn(), older = jest.fn(), newer = jest.fn();
  const setPreference = jest.fn(), setLocalDate = jest.fn(), savePreference = jest.fn(), requestAssignment = jest.fn(), openLastAvailable = jest.fn();
  const actions = { ...f.actions, list, oldest, latest, older, newer, setPreference, setLocalDate, savePreference, requestAssignment, openLastAvailable };
  const s = slot(), cursor = { id: s.id, releaseAt: s.releaseAt };
  const view: MorningView = { ...f.actions.getSnapshot(), localDate: s.localDate, offset: s.offset,
    choices: [{ offset: s.offset, releaseAt: s.releaseAt }], slots: [s],
    preferences: [{ userId: id(1), timezone: 'UTC', localTime: '09:00', version: 1 }],
    history: { readId: id(9), serverNow: s.createdAt, preferences: [], slots: [s], hasOlder: true, hasNewer: true,
      olderCursor: cursor, newerCursor: cursor, lastAvailableId: s.id } };
  const screen = render(<MorningsPanel locale="en" view={view} actions={actions} />);
  fireEvent.changeText(screen.getByLabelText(t.zone), 'Europe/London');
  fireEvent.changeText(screen.getByLabelText(t.time), '10:00');
  fireEvent.changeText(screen.getByLabelText(t.date), '2030-01-03');
  expect(setPreference.mock.calls).toEqual([[{ timezone: 'Europe/London' }], [{ localTime: '10:00' }]]);
  expect(setLocalDate).toHaveBeenCalledWith('2030-01-03');
  for (const label of [t.save, t.assign, t.refresh, t.oldest, t.latest, t.older, t.newer, t.last]) fireEvent.press(screen.getByText(label));
  for (const handler of [savePreference, requestAssignment, list, oldest, latest, older, newer, openLastAvailable]) expect(handler).toHaveBeenCalledTimes(1);
  const selectSlot = jest.fn(); screen.rerender(<MorningsPanel locale="en" view={view} actions={{ ...actions, selectSlot }} />);
  fireEvent.press(screen.getByText(`${t.select}: ${s.localDate} ${s.localTime}`)); expect(selectSlot).toHaveBeenCalledWith(s.id);
});
