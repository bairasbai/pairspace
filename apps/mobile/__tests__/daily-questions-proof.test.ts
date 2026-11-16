import { createDailySlot } from '../../../packages/domain/daily-question/slot';
import { createDailyAnswerMetadata, rewriteDailyAnswerMetadata, removeDailyAnswerMetadata } from '../../../packages/domain/daily-question/metadata';
import { provesDailyCommand, type DailyProofCommand } from '../src/auth/daily-questions-proof';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { coupleId: id(3), userId: id(1), membershipEpoch: 1 };
const at = '2026-11-16T10:00:00.000Z', later = '2026-11-16T11:00:00.000Z', last = '2026-11-16T12:00:00.000Z';
const slot = createDailySlot({ id: id(4), participantIds: [id(1), id(2)], timezone: 'UTC' }, scope, at)!;
const answer = createDailyAnswerMetadata({ id: id(5) }, slot, scope, at, true)!;
const changed = rewriteDailyAnswerMetadata(answer, slot, scope, later, 1, true)!;
const changedAgain = rewriteDailyAnswerMetadata(changed, slot, scope, last, 2, true)!;
const removed = removeDailyAnswerMetadata(changedAgain, slot, scope, last, 3, true)!;
const command = (kind: DailyProofCommand['kind'], base = kind === 'create' ? null : answer): DailyProofCommand =>
  ({ kind, base, slot: kind === 'create' ? null : slot, expectedDay: slot.day, floor: at, knownIds: [] });
const ack = (current = answer, replay = false) => ({ slot, answer: current, replay, commandId: id(9), checkedAt: last });
it('accepts exact ACK and compatible CURRENT replay after multiple edits/removal', () => {
  expect(provesDailyCommand(command('create'), ack(), scope)).toBe(true);
  expect(provesDailyCommand({ ...command('create'), floor: null }, ack(), scope)).toBe(true);
  expect(provesDailyCommand(command('create'), ack(removed, true), scope)).toBe(true);
  expect(provesDailyCommand(command('rewrite'), ack(changed), scope)).toBe(true);
  expect(provesDailyCommand(command('rewrite'), ack(changedAgain, true), scope)).toBe(true);
  expect(provesDailyCommand(command('rewrite'), ack(removed, true), scope)).toBe(true);
  const directRemoved = removeDailyAnswerMetadata(changed, slot, scope, last, 2, true)!;
  expect(provesDailyCommand(command('rewrite'), ack(directRemoved, true), scope)).toBe(true);
  expect(provesDailyCommand(command('remove', changedAgain), ack(removed), scope)).toBe(true);
  expect(provesDailyCommand(command('create'), ack(changed), scope)).toBe(false);
});
it('rejects forged original slot, scope, events, floor and operation', () => {
  for (const patch of [{ expectedDay: '2026-11-15' }, { floor: later }, { floor: 'bad' }, { knownIds: [answer.id] },
    { slot: { ...slot, promptRU: 'changed' } }, { slot: { ...slot, id: id(88) } }]) {
    expect(provesDailyCommand({ ...command('create'), ...patch }, ack(), scope)).toBe(false);
  }
  expect(provesDailyCommand(command('create'), { ...ack(), slot: { ...slot, day: 'bad' } }, scope)).toBe(false);
  expect(provesDailyCommand(command('create'), ack({ ...answer, authorId: id(2) }), scope)).toBe(false);
  expect(provesDailyCommand(command('create'), ack({ ...answer, version: 99 }), scope)).toBe(false);
  for (const kind of ['rewrite', 'remove'] as const) for (const patch of [{ base: null }, { slot: null }, { floor: null }]) {
    expect(provesDailyCommand({ ...command(kind), ...patch }, ack(removed, true), scope)).toBe(false);
  }
  expect(provesDailyCommand(command('remove'), ack(), scope)).toBe(false);
  expect(provesDailyCommand({ ...command('remove', changedAgain), floor: '2026-11-17T00:00:00.000Z' }, ack(removed), scope)).toBe(false);
  expect(provesDailyCommand({ ...command('rewrite'), floor: last }, ack(changed), scope)).toBe(false);
  expect(provesDailyCommand({ ...command('rewrite'), floor: '2026-11-17T00:00:00.000Z' }, ack(removed, true), scope)).toBe(false);
  expect(provesDailyCommand(command('remove'), ack(removed, true), scope)).toBe(false);
});
