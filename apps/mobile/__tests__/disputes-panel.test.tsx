import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';
import { DisputesPanel } from '../src/auth/DisputesPanel';
import { disputesCopy } from '../src/auth/disputesCopy';
import { emptyDisputes, type DisputeView, type DisputeMetadata } from '../src/auth/disputes-state';
import type { DisputesActions } from '../src/auth/disputes';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const early = '2026-11-15T12:00:00.000Z', due = '2026-11-16T12:00:00.000Z';
const q: DisputeMetadata = { id: id(3), coupleId: id(4), authorId: id(1), recipientId: id(2), membershipEpoch: 1,
  version: 1, createdAt: early, judgeDate: '2026-11-16', timezone: 'UTC', contentState: 'active', decisionState: 'invited',
  joinedAt: null, declinedAt: null, resolvedAt: null, resolvedBy: null, winnerId: null, removedAt: null };
const terms = { dispute: q, claim: 'Synthetic terms', condition: 'Optional nonbinding note', checkedAt: early, generation: 1 };
function fixture(patch: Partial<DisputeView> = {}) {
  let view: DisputeView = { ...emptyDisputes, generation: 1, available: true, checked: true, checkedAt: early, userId: id(2), disputes: [q], used: 1, ...patch };
  const listeners = new Set<() => void>();
  const update = (p: Partial<DisputeView>) => { view = { ...view, ...p }; listeners.forEach(fn => fn()); };
  const edit = (field: 'draftClaim' | 'draftCondition' | 'judgeDate' | 'timezone') => jest.fn((text: string) => update({ [field]: text, revision: view.revision + 1 }));
  const api: DisputesActions = { getSnapshot: () => view, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh: jest.fn(async () => {}), retry: jest.fn(async () => {}), create: jest.fn(async () => {}), join: jest.fn(async () => {}),
    decline: jest.fn(async () => {}), resolve: jest.fn(async () => {}), remove: jest.fn(async () => {}), read: jest.fn(async () => {}),
    close: jest.fn(() => update({ reader: null, readerStatus: 'closed' })), setClaim: edit('draftClaim'), setCondition: edit('draftCondition'),
    setJudgeDate: edit('judgeDate'), setTimezone: edit('timezone'),
    leaveScreen: jest.fn(() => update({ ...emptyDisputes, generation: view.generation + 1 })),
  };
  return { api, update };
}
for (const locale of ['ru', 'en'] as const) for (const platform of ['ios', 'android'] as const) {
  it(`renders explicit read and consent, calendar form, labels ${locale}/${platform}`, () => {
    const os = jest.replaceProperty(Platform, 'OS', platform), f = fixture(), t = disputesCopy[locale];
    try {
      render(<DisputesPanel controller={f.api} locale={locale}/>);
      expect(screen.getByText(t.notice)).toBeTruthy(); expect(screen.getByText(t.terms)).toBeTruthy();
      expect(screen.getByRole('button', { name: t.join })).toBeDisabled(); expect(f.api.read).not.toHaveBeenCalled();
      fireEvent.press(screen.getByRole('button', { name: t.read })); expect(f.api.read).toHaveBeenCalledWith(q.id);
      act(() => f.update({ reader: terms, readerStatus: 'opened', checked: false }));
      expect(screen.getByText(terms.claim).props.selectable).toBe(true); expect(screen.getByText(terms.condition)).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: t.join })); expect(f.api.join).not.toHaveBeenCalled();
      expect(screen.getByText(t.confirmJoin)).toBeTruthy();
      const confirm = screen.getByRole('button', { name: t.confirm }); fireEvent.press(confirm); fireEvent.press(confirm);
      expect(f.api.join).toHaveBeenCalledTimes(1); expect(f.api.join).toHaveBeenCalledWith(q.id, true);
      act(() => f.update({ checked: true }));
      for (const [label, value] of [['claim', 'New claim'], ['condition', 'New note'], ['judgeDate', '2026-12-01'], ['timezone', 'UTC']] as const) fireEvent.changeText(screen.getByLabelText(t[label]), value);
      expect(f.api.setClaim).toHaveBeenCalledWith('New claim'); expect(f.api.setTimezone).toHaveBeenCalledWith('UTC');
      fireEvent.press(screen.getByRole('button', { name: t.create })); expect(screen.getByText(t.confirmCreate)).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: t.cancel })); fireEvent.press(screen.getByRole('button', { name: t.create }));
      fireEvent.press(screen.getByRole('button', { name: t.confirm })); expect(f.api.create).toHaveBeenCalledWith(true);
      fireEvent.press(screen.getByRole('button', { name: t.clear })); expect(f.api.getSnapshot().draftClaim).toBe('');
      fireEvent.press(screen.getByRole('button', { name: t.load })); expect(f.api.refresh).toHaveBeenCalledTimes(1);
      fireEvent.press(screen.getByRole('button', { name: t.close })); expect(screen.queryByText(terms.claim)).toBeNull();
    } finally { os.restore(); }
  });
}
it.each(['form', 'version', 'generation', 'actor', 'reader', 'replacement'] as const)('invalidates consent on %s change', change => {
  const f = fixture({ reader: terms, readerStatus: 'opened' }), t = disputesCopy.en;
  const rendered = render(<DisputesPanel controller={f.api} locale="en"/>);
  fireEvent.press(screen.getByRole('button', { name: t.join })); const stale = screen.getByRole('button', { name: t.confirm });
  if (change === 'form') fireEvent.changeText(screen.getByLabelText(t.claim), 'changed');
  if (change === 'version') act(() => f.update({ disputes: [{ ...q, version: 2, joinedAt: early, decisionState: 'joined' }] }));
  if (change === 'generation') act(() => f.update({ generation: 2 }));
  if (change === 'actor') act(() => f.update({ userId: id(1) }));
  if (change === 'reader') fireEvent.press(screen.getByRole('button', { name: t.close }));
  if (change === 'replacement') rendered.rerender(<DisputesPanel controller={fixture().api} locale="en"/>);
  expect(screen.queryByText(t.confirmJoin)).toBeNull(); fireEvent.press(stale); expect(f.api.join).not.toHaveBeenCalled();
});
it('server date controls participation and verdict, never device date; decline is not loss', () => {
  const time = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2099-01-01'));
  const f = fixture({ reader: terms, readerStatus: 'opened' }), t = disputesCopy.en;
  try {
    render(<DisputesPanel controller={f.api} locale="en"/>); expect(screen.getByRole('button', { name: t.join })).toBeEnabled();
    act(() => f.update({ checkedAt: due })); expect(screen.getByRole('button', { name: t.join })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: t.decline })); fireEvent.press(screen.getByRole('button', { name: t.confirm })); expect(f.api.decline).toHaveBeenCalledWith(q.id, true);
    const joined = { ...q, version: 2, decisionState: 'joined' as const, joinedAt: early };
    act(() => f.update({ disputes: [joined], reader: null }));
    expect(screen.getByRole('button', { name: t.draw })).toBeDisabled();
    act(() => f.update({ reader: { ...terms, dispute: joined, checkedAt: due }, readerStatus: 'opened' }));
    for (const [label, winner] of [[t.authorWins, q.authorId], [t.recipientWins, q.recipientId], [t.draw, null]] as const) {
      fireEvent.press(screen.getByRole('button', { name: label })); expect(screen.getByText(t.confirmResolve)).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: t.confirm })); expect(f.api.resolve).toHaveBeenLastCalledWith(q.id, winner, true);
    }
    act(() => f.update({ userId: q.authorId })); fireEvent.press(screen.getByRole('button', { name: t.remove })); expect(screen.getByText(t.confirmRemove)).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: t.confirm })); expect(f.api.remove).toHaveBeenCalledWith(q.id, true);
  } finally { time.mockRestore(); }
});
it.each(['loading', 'changed', 'error'] as const)('does not expose reader text during %s', state => {
  const f = fixture({ readerStatus: state, reader: terms }), t = disputesCopy.en;
  render(<DisputesPanel controller={f.api} locale="en"/>); expect(screen.queryByText(terms.claim)).toBeNull();
  expect(screen.getByText(state === 'loading' ? t.reading : state === 'changed' ? t.readerChanged : t.readerError)).toBeTruthy();
});
it('shows retry without success and scrubs RAM on background/unmount', () => {
  const f = fixture({ pending: true, status: 'retry', error: true, reader: terms, readerStatus: 'opened' }), t = disputesCopy.en;
  const rendered = render(<DisputesPanel controller={f.api} locale="en"/>);
  expect(screen.getByText(t.pending)).toBeTruthy(); expect(screen.getByText(t.error)).toBeTruthy(); expect(screen.queryByText(terms.claim)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: t.retry })); expect(f.api.retry).toHaveBeenCalledTimes(1);
  const callback = jest.mocked(AppState.addEventListener).mock.calls.filter(c => c[0] === 'change').at(-1)![1];
  act(() => callback('background')); expect(f.api.getSnapshot().reader).toBeNull(); rendered.unmount(); expect(f.api.leaveScreen).toHaveBeenCalledTimes(2);
});
it('shows empty/removed/resolved outcomes and no body or author action to recipient', () => {
  const f = fixture({ disputes: [], used: 0 }), t = disputesCopy.en; render(<DisputesPanel controller={f.api} locale="en"/>);
  expect(screen.getByText(t.empty)).toBeTruthy();
  for (const winnerId of [null, q.authorId, q.recipientId]) {
    act(() => f.update({ disputes: [{ ...q, contentState: 'removed', decisionState: 'resolved', resolvedAt: due, winnerId }], used: 100 }));
    expect(screen.getByText(t.removed)).toBeTruthy(); expect(screen.getByText(winnerId === null ? t.draw : winnerId === q.authorId ? t.authorWins : t.recipientWins)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.remove })).toBeNull(); expect(screen.getByRole('button', { name: t.create })).toBeDisabled();
  }
});
it.each(['close', 'reopen', 'other'] as const)('invalidates outcome confirmation when reader %s', change => {
  const joined = { ...q, version: 2, decisionState: 'joined' as const, joinedAt: early };
  const reader = { ...terms, dispute: joined, checkedAt: due };
  const f = fixture({ disputes: [joined], reader, readerStatus: 'opened', checkedAt: due }), t = disputesCopy.en;
  render(<DisputesPanel controller={f.api} locale="en"/>);
  fireEvent.press(screen.getByRole('button', { name: t.draw })); const stale = screen.getByRole('button', { name: t.confirm });
  expect(screen.getByText(terms.claim)).toBeTruthy(); expect(screen.getByText(terms.condition)).toBeTruthy();
  if (change === 'close') fireEvent.press(screen.getByRole('button', { name: t.close }));
  if (change === 'reopen') act(() => f.update({ reader: { ...reader } }));
  if (change === 'other') act(() => f.update({ reader: { ...reader, dispute: { ...joined, id: id(7) } } }));
  expect(screen.queryByText(t.confirmResolve)).toBeNull(); fireEvent.press(stale); expect(f.api.resolve).not.toHaveBeenCalled();
});
