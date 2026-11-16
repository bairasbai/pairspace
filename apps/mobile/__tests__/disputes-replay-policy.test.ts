import { provesDisputeCommand, type DisputeProofCommand } from '../src/auth/disputes-proof';
import { createDisputeMetadata, joinDisputeMetadata, declineDisputeMetadata, resolveDisputeMetadata,
  removeDisputeMetadata, type DisputeMetadata } from '../src/auth/disputes-state';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const author = { userId: id(1), coupleId: id(3), membershipEpoch: 1 }, recipient = { ...author, userId: id(2) };
const now = '2026-11-16T08:00:00.000Z', due = '2026-11-17T08:00:00.000Z';
const schedule = { judgeDate: '2026-11-17', timezone: 'UTC' };
const created = createDisputeMetadata({ id: id(4), recipientId: id(2), ...schedule }, author, now, true)!;
const joined = joinDisputeMetadata(created, recipient, now, 1, true)!;
const declined = declineDisputeMetadata(joined, recipient, due, 2, true)!;
const resolved = resolveDisputeMetadata(joined, author, due, 2, id(1), true)!;
const removed = removeDisputeMetadata(resolved, author, due, 3, true)!;
const command = (kind: DisputeProofCommand['kind'], base: DisputeMetadata | null = null): DisputeProofCommand =>
  ({ kind, base, ...schedule, winnerId: id(1), floor: now, knownIds: [] });

it('proves exact operation ACKs and legal CURRENT replays without text', () => {
  const cases = [
    { c: command('create'), exact: created, current: removed, scope: author },
    { c: command('join', created), exact: joined, current: removed, scope: recipient },
    { c: command('decline', joined), exact: declined, current: removeDisputeMetadata(declined, author, due, 3, true)!, scope: recipient },
    { c: command('resolve', joined), exact: resolved, current: removed, scope: author },
    { c: command('remove', resolved), exact: removed, current: removed, scope: author },
  ];
  for (const { c, exact, current, scope } of cases) {
    expect(provesDisputeCommand(c, exact, false, scope)).toBe(true);
    expect(provesDisputeCommand(c, current, true, scope)).toBe(true);
    expect(provesDisputeCommand(c, current, false, scope)).toBe(exact.version === current.version);
  }
  expect(provesDisputeCommand({ ...command('create'), floor: null }, created, false, author)).toBe(true);
  const draw = resolveDisputeMetadata(joined, recipient, due, 2, null, true)!;
  expect(provesDisputeCommand({ ...command('resolve', joined), winnerId: null }, draw, false, recipient)).toBe(true);
});
it('rejects changed identities, terms schedule, outcomes, body keys, and malformed enums', () => {
  for (const patch of [{ id: id(99) }, { authorId: id(2), recipientId: id(1) }, { coupleId: id(99) },
    { membershipEpoch: 2 }, { judgeDate: '2026-11-18' }, { timezone: 'Europe/Moscow' },
    { winnerId: id(2) }, { resolvedBy: id(2) }, { contentState: ['removed'] }, { decisionState: ['resolved'] },
    { claim: 'must not enter ACK' }, { condition: null }]) {
    expect(provesDisputeCommand(command('resolve', joined), { ...removed, ...patch } as DisputeMetadata, true, author)).toBe(false);
  }
  expect(provesDisputeCommand({ ...command('create'), judgeDate: 'bad' }, created, true, author)).toBe(false);
  expect(provesDisputeCommand({ ...command('create'), knownIds: [created.id] }, created, true, author)).toBe(false);
  expect(provesDisputeCommand({ ...command('create'), floor: due }, created, true, author)).toBe(false);
});
it('rejects missing original events, invalid floor, wrong role/CAS base and later timestamp rewrites', () => {
  for (const kind of ['join', 'decline', 'resolve', 'remove'] as const) {
    expect(provesDisputeCommand(command(kind), removed, true, author)).toBe(false);
    expect(provesDisputeCommand({ ...command(kind, created), floor: null }, removed, true, author)).toBe(false);
    expect(provesDisputeCommand(command(kind, created), created, true, author)).toBe(false);
  }
  expect(provesDisputeCommand({ ...command('join', created), floor: due }, joined, true, recipient)).toBe(false);
  expect(provesDisputeCommand({ ...command('create'), floor: 'bad' }, created, true, author)).toBe(false);
  expect(provesDisputeCommand(command('join', created), joined, true, author)).toBe(false);
  expect(provesDisputeCommand(command('resolve', { ...joined, version: 99 }), resolved, true, author)).toBe(false);
  expect(provesDisputeCommand(command('resolve', joined), { ...removed, joinedAt: '2026-11-16T09:00:00.000Z' }, true, author)).toBe(false);
  expect(provesDisputeCommand(command('decline', created), declined, true, recipient)).toBe(false);
});
