import { fireEvent, render } from '@testing-library/react-native';
import { MorningDiscussionMutationsPanel, mutationCopy } from '../src/auth/MorningDiscussionMutationsPanel';
import type { DiscussionEditor, DiscussionDelete, createMorningDiscussionMutations } from '../src/auth/morning-discussion-mutations';
function fixture() {
  const actions: ReturnType<typeof createMorningDiscussionMutations>['actions'] = { beginEdit: jest.fn(), beginDelete: jest.fn(),
    setEditDraft: jest.fn(), cancelEdit: jest.fn(), reloadEdit: jest.fn(async () => {}), saveEdit: jest.fn(async () => {}),
    cancelDelete: jest.fn(), confirmDelete: jest.fn(async () => {}), retryEdit: jest.fn(async () => {}), retryDelete: jest.fn(async () => {}) };
  const editor: DiscussionEditor = { targetId: 'reply', slotId: 'morning', version: 2, draft: 'private', status: 'editing', needsReload: false };
  const deletion: DiscussionDelete = { status: 'idle' };
  return { actions, editor, deletion, slotId: 'morning', targetVisible: true, busy: false };
}
for (const locale of ['ru', 'en'] as const) {
  test(`${locale}: edit/save/reload/cancel require explicit intent`, () => {
    const f = fixture(), t = mutationCopy[locale]; const screen = render(<MorningDiscussionMutationsPanel locale={locale} {...f} />);
    expect(f.actions.saveEdit).not.toHaveBeenCalled(); expect(f.actions.reloadEdit).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByLabelText(t.body), 'new'); expect(f.actions.setEditDraft).toHaveBeenCalledWith('new');
    fireEvent.press(screen.getByText(t.save)); expect(f.actions.saveEdit).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByText(t.reload)); expect(f.actions.reloadEdit).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByText(t.cancel)); expect(f.actions.cancelEdit).toHaveBeenCalledTimes(1);
  });
  test(`${locale}: protected other morning draft is hidden, never silently cleared`, () => {
    const f = fixture(), t = mutationCopy[locale]; const screen = render(<MorningDiscussionMutationsPanel locale={locale} {...f} slotId="other" />);
    screen.getByText(t.other); expect(screen.queryByLabelText(t.body)).toBeNull(); expect(f.actions.cancelEdit).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText(t.cancel)); expect(f.actions.cancelEdit).toHaveBeenCalledTimes(1);
  });
  test(`${locale}: deletion confirmation binds exact token and shows metadata, not original body`, () => {
    const f = fixture(), t = mutationCopy[locale]; const deletion: DiscussionDelete = { status: 'confirming', confirmation: {
      token: 'protected-token', id: 'reply', slotId: 'morning', seq: 12, createdAt: '2030-01-02T09:00:00.000Z' } };
    const screen = render(<MorningDiscussionMutationsPanel locale={locale} {...f} deletion={deletion} />);
    screen.getByText(t.warning); screen.getByText('#12 · 2030-01-02T09:00:00.000Z');
    expect(f.actions.confirmDelete).not.toHaveBeenCalled(); fireEvent.press(screen.getByText(t.confirm));
    expect(f.actions.confirmDelete).toHaveBeenCalledWith('protected-token'); fireEvent.press(screen.getByText(t.cancelDelete));
    expect(f.actions.cancelDelete).toHaveBeenCalledTimes(1);
    screen.rerender(<MorningDiscussionMutationsPanel locale={locale} {...f} deletion={deletion} slotId="other" />);
    expect(screen.queryByText(t.confirm)).toBeNull();
  });
  test(`${locale}: deleted reply leaves new private draft unsent and save blocked`, () => {
    const f = fixture(), t = mutationCopy[locale];
    const screen = render(<MorningDiscussionMutationsPanel locale={locale} {...f}
      editor={{ ...f.editor, draft: 'new private text', status: 'deleted', needsReload: true }} deletion={{ status: 'deleted' }} />);
    screen.getByText(t.deletedDraft); screen.getByText(t.tombstone); expect(screen.getByLabelText(t.body).props.value).toBe('new private text');
    fireEvent.press(screen.getByText(t.save)); fireEvent.press(screen.getByText(t.reload));
    expect(f.actions.saveEdit).not.toHaveBeenCalled(); expect(f.actions.reloadEdit).not.toHaveBeenCalled();
  });
  test(`${locale}: unknown retry, conflict and protective limit remain explicit`, () => {
    const f = fixture(), t = mutationCopy[locale];
    const screen = render(<MorningDiscussionMutationsPanel locale={locale} {...f} editor={{ ...f.editor, status: 'unknown' }} deletion={{ status: 'unknown' }} />);
    expect(f.actions.retryEdit).not.toHaveBeenCalled(); expect(f.actions.retryDelete).not.toHaveBeenCalled();
    fireEvent.press(screen.getByText(t.retryEdit)); fireEvent.press(screen.getByText(t.retryDelete));
    expect(f.actions.retryEdit).toHaveBeenCalledTimes(1); expect(f.actions.retryDelete).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByText(t.save)); expect(f.actions.saveEdit).not.toHaveBeenCalled();
    screen.rerender(<MorningDiscussionMutationsPanel locale={locale} {...f} suspended editor={{ ...f.editor, status: 'conflict', needsReload: true, error: 'cancel_edit_first' }} />);
    screen.getByText(t.conflict); screen.getByText(t.cancelFirst); screen.getByText(t.suspended);
    fireEvent.press(screen.getByText(t.save)); expect(f.actions.saveEdit).not.toHaveBeenCalled();
    screen.rerender(<MorningDiscussionMutationsPanel locale={locale} {...f} editor={{ ...f.editor, status: 'saved', error: 'offline' }} deletion={{ status: 'error', error: 'offline' }} />);
    screen.getByText(t.saved); expect(screen.getAllByText(t.error)).toHaveLength(2);
  });
}
