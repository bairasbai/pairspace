import { fireEvent, render } from '@testing-library/react-native';
import { MorningDiscussionsPanel, discussionCopy } from '../src/auth/MorningDiscussionsPanel';
import type { MorningDiscussionView, createMorningDiscussionsController } from '../src/auth/morning-discussions';
import { id, slot } from './mornings.fixture';
const opened = { ...slot(), prepared: true, state: 'available' as const };
function setup() {
  const actions: ReturnType<typeof createMorningDiscussionsController>['actions'] = {
    getSnapshot: () => view, subscribe: jest.fn(() => () => {}), open: jest.fn(async () => {}), close: jest.fn(),
    first: jest.fn(async () => {}), last: jest.fn(async () => {}), older: jest.fn(async () => {}), newer: jest.fn(async () => {}),
    setDraft: jest.fn(), clearDraft: jest.fn(), selectDraft: jest.fn(), send: jest.fn(async () => {}), retry: jest.fn(async () => {}),
    beginEdit: jest.fn(), setEditDraft: jest.fn(), cancelEdit: jest.fn(), reloadEdit: jest.fn(async () => {}), saveEdit: jest.fn(async () => {}),
    beginDelete: jest.fn(), cancelDelete: jest.fn(), confirmDelete: jest.fn(async () => {}), retryEdit: jest.fn(async () => {}), retryDelete: jest.fn(async () => {}),
  };
  const messages = [1, 2].map(n => ({ id: id(100 + n), clientId: id(200 + n), slotId: opened.id,
    coupleId: opened.coupleId, membershipEpoch: 1, seq: n, authorId: id(n), body: `reply ${n}\nsecond line`, createdAt: opened.releaseAt, version: 1, editedAt: null, deletedAt: null }));
  const view: MorningDiscussionView = { available: true, userId: id(1), slot: opened, messages, draft: 'private draft',
    savedDraftSlots: [opened], editor: { draft: '', needsReload: false, status: 'idle' }, deletion: { status: 'idle' }, busy: false, status: 'ready', history: { readId: id(9), slotId: opened.id,
      messages, hasPrevious: true, hasNext: true, previousCursor: { id: messages[0].id, seq: 1 }, nextCursor: { id: messages[1].id, seq: 2 } } };
  return { actions, view, onOpenSaved: jest.fn() };
}
for (const locale of ['ru', 'en'] as const) {
  test(`${locale}: all reads and writes are explicit; authors and multiline text are separate`, () => {
    const f = setup(), t = discussionCopy[locale];
    const screen = render(<MorningDiscussionsPanel locale={locale} {...f} openedSlot={opened} />);
    screen.getByText(t.notice); screen.getByText(`${t.own} · ${opened.releaseAt}`);
    screen.getByText(`${t.partner} · ${opened.releaseAt}`); screen.getByText('reply 1\nsecond line');
    expect(f.actions.open).not.toHaveBeenCalled(); expect(f.actions.send).not.toHaveBeenCalled(); expect(f.actions.first).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText(t.open)); expect(f.actions.open).toHaveBeenCalledWith(opened);
    for (const name of ['refresh', 'first', 'last', 'older', 'newer', 'send', 'clear', 'close'] as const) fireEvent.press(screen.getByText(t[name]));
    expect(f.actions.first).toHaveBeenCalledTimes(2);
    for (const action of [f.actions.last, f.actions.older, f.actions.newer, f.actions.send, f.actions.clearDraft, f.actions.close]) expect(action).toHaveBeenCalledTimes(1);
    fireEvent.changeText(screen.getByLabelText(t.body), 'changed'); expect(f.actions.setDraft).toHaveBeenCalledWith('changed');
    fireEvent.press(screen.getByText(`${t.saved}: 2030-01-02 09:00 · UTC +00:00`)); expect(f.onOpenSaved).toHaveBeenCalledWith(opened);
  });
  test(`${locale}: old A never renders below B; pending A retry stays visible and date-bound`, () => {
    const f = setup(), t = discussionCopy[locale];
    const view = { ...f.view, pendingId: id(888), pendingSlot: opened, status: 'unknown' as const };
    const screen = render(<MorningDiscussionsPanel locale={locale} {...f} view={view} openedSlot={{ ...opened, id: id(20) }} />);
    expect(screen.queryByText('reply 1\nsecond line')).toBeNull(); expect(screen.queryByLabelText(t.body)).toBeNull();
    screen.getByText(`${t.pending}: 2030-01-02 09:00 · UTC +00:00`); expect(screen.queryByText(id(888))).toBeNull();
    fireEvent.press(screen.getByText(t.retry)); expect(f.actions.retry).toHaveBeenCalledTimes(1);
    expect(f.actions.send).not.toHaveBeenCalled();
  });
  test(`${locale}: sent notice does not fetch; empty/cap/error and busy controls are truthful`, () => {
    const f = setup(), t = discussionCopy[locale];
    const view = { ...f.view, messages: [], history: { ...f.view.history!, messages: [] }, status: 'sent' as const, error: 'draft_limit' };
    const screen = render(<MorningDiscussionsPanel locale={locale} {...f} view={view} openedSlot={opened} />);
    screen.getByText(t.sent); screen.getByText(t.limit); screen.getByText(t.empty); expect(f.actions.first).not.toHaveBeenCalled();
    screen.rerender(<MorningDiscussionsPanel locale={locale} {...f} view={{ ...view, busy: true, error: 'offline', pendingId: id(8) }} openedSlot={opened} />);
    screen.getByText(t.error);
    for (const label of [t.open, t.send, t.retry, t.refresh, t.first, t.last, t.older, t.newer]) fireEvent.press(screen.getByText(label));
    expect(f.actions.open).not.toHaveBeenCalled(); expect(f.actions.send).not.toHaveBeenCalled(); expect(f.actions.retry).not.toHaveBeenCalled();
  });
  test(`${locale}: recipient must have explicitly opened; unavailable panel disappears`, () => {
    const f = setup(), t = discussionCopy[locale]; const incoming = { ...slot(10, true), state: 'available' as const };
    const screen = render(<MorningDiscussionsPanel locale={locale} {...f} openedSlot={incoming} />);
    expect(screen.queryByText(t.open)).toBeNull();
    screen.rerender(<MorningDiscussionsPanel locale={locale} {...f} openedSlot={{ ...incoming, openedAt: incoming.releaseAt }} />);
    screen.getByText(t.open);
    screen.rerender(<MorningDiscussionsPanel locale={locale} {...f} openedSlot={null} />); expect(screen.queryByText(t.open)).toBeNull();
    screen.rerender(<MorningDiscussionsPanel locale={locale} {...f} view={{ ...f.view, available: false }} openedSlot={opened} />);
    expect(screen.queryByText(t.saved)).toBeNull();
  });
}
test('v1 has no edit marker; real edit and restored text versions retain it; tombstone has no body/actions', () => {
  const f = setup(), t = discussionCopy.en;
  const screen = render(<MorningDiscussionsPanel locale="en" {...f} openedSlot={opened} />);
  expect(screen.queryByText('Edited')).toBeNull();
  fireEvent.press(screen.getByText('Edit my reply')); expect(f.actions.beginEdit).toHaveBeenCalledWith(f.view.messages[0].id);
  fireEvent.press(screen.getByText('Delete my reply for both')); expect(f.actions.beginDelete).toHaveBeenCalledWith(f.view.messages[0].id);
  for (const version of [2, 3]) {
    screen.rerender(<MorningDiscussionsPanel locale="en" {...f} openedSlot={opened}
      view={{ ...f.view, messages: [{ ...f.view.messages[0], version, editedAt: opened.releaseAt }] }} />);
    screen.getByText('Edited'); screen.getByText('reply 1\nsecond line');
  }
  screen.rerender(<MorningDiscussionsPanel locale="en" {...f} openedSlot={opened} view={{ ...f.view,
    messages: [{ ...f.view.messages[0], version: 4, editedAt: opened.releaseAt, deletedAt: opened.releaseAt, body: null }] }} />);
  screen.getByText('Reply deleted'); expect(screen.queryByText('reply 1\nsecond line')).toBeNull();
  expect(screen.queryByText('Edit my reply')).toBeNull(); expect(screen.queryByText('Delete my reply for both')).toBeNull();
  screen.getByLabelText(t.body);
});
