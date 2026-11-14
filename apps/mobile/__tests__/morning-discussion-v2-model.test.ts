import { parseV2Message, parseV2Page, type V2DiscussionMessage } from '../src/auth/morning-discussion-v2-model';
import { slot, id, scope } from './mornings.fixture';
const morning = slot();
const message = (n = 1): V2DiscussionMessage => ({ id: id(100 + n), slotId: morning.id, coupleId: scope.coupleId,
  membershipEpoch: 1, authorId: scope.userId, clientId: id(200 + n), seq: n,
  body: 'Hello\nПривет', createdAt: morning.releaseAt, version: 1, editedAt: null, deletedAt: null });
const page = (messages = [message()]) => ({ readId: id(9), slotId: morning.id, messages,
  hasPrevious: false, hasNext: false, previousCursor: null, nextCursor: null });
const parse = (raw: unknown) => parseV2Page(raw, scope, morning, id(9), 'first');
test('both participants have separate authors and immutable normalized multiline bodies', () => {
  expect(parseV2Message(message(), scope, morning)).toEqual(message());
  expect(parseV2Message({ ...message(), authorId: id(2) }, scope, morning)).not.toBeNull();
  expect(parseV2Message({ ...message(), body: '😀'.repeat(8000) }, scope, morning)).not.toBeNull();
  expect(parseV2Message({ ...message(), body: '😀'.repeat(8001) }, scope, morning)).toBeNull();
});
test.each([
  null, [], { ...message(), id: 'bad' }, { ...message(), clientId: 'bad' }, { ...message(), authorId: id(7) },
  { ...message(), coupleId: id(8) }, { ...message(), slotId: id(11) }, { ...message(), membershipEpoch: 2 },
  { ...message(), extra: 'secret' }, { ...message(), seq: 0 }, { ...message(), seq: 1.5 },
  { ...message(), seq: Number.MAX_SAFE_INTEGER + 1 }, { ...message(), body: null }, { ...message(), body: '  ' },
  { ...message(), body: 'a\r\nb' }, { ...message(), body: 'e\u0301' }, { ...message(), body: '\u0000' },
  { ...message(), createdAt: '2030-02-30T09:00:00.000Z' },
  { ...message(), createdAt: '2030-01-02T09:00:00Z' }, { ...message(), createdAt: 'bad' },
])('rejects malformed/privacy-breaking message %j', raw => {
  expect(parseV2Message(raw, scope, morning)).toBeNull();
});
test('canonical lowercase UUID and validated slot scope are mandatory', () => {
  expect(parseV2Message({ ...message(), id: 'AAAAAAAA-0000-4000-8000-000000000000' }, scope, morning)).toBeNull();
  expect(parseV2Message(message(), { ...scope, membershipEpoch: 2 }, morning)).toBeNull();
  expect(parseV2Message(message(), scope, { ...morning, recipientId: scope.userId })).toBeNull();
  expect(parseV2Page(page([]), scope, { ...morning, coupleId: id(8) }, id(9), 'first')).toBeNull();
});
test('complete 30 row window and empty actual history', () => {
  expect(parse(page(Array.from({ length: 30 }, (_, i) => message(i + 1))))).not.toBeNull();
  expect(parse(page([]))).not.toBeNull();
  expect(parse(page(Array.from({ length: 31 }, (_, i) => message(i + 1))))).toBeNull();
  expect(parse(page([message(1), message(8)]))).not.toBeNull();
});
test.each([
  null, [], { ...page(), readId: id(8) }, { ...page(), slotId: id(99) }, { ...page(), extra: true },
  { ...page(), messages: null }, { ...page(), messages: [null] }, { ...page(), hasNext: 1 },
  { ...page(), hasPrevious: true }, { ...page(), hasNext: true }, { ...page([]), hasNext: true },
  { ...page(), nextCursor: { id: message().id, seq: 1 } },
  page([message(), message()]), page([message(2), message(1)]),
  page([message(), { ...message(2), id: message().id }]),
  page([message(), { ...message(2), clientId: message().clientId }]),
  page([message(), { ...message(2), seq: 1 }]),
])('rejects malformed/unordered/duplicate window %j', raw => { expect(parse(raw)).toBeNull(); });
test('edge cursors and first/last constraints are exact', () => {
  const first = message(), last = message(2), firstCursor = { id: first.id, seq: first.seq }, lastCursor = { id: last.id, seq: last.seq };
  expect(parse({ ...page([first, last]), hasNext: true, nextCursor: lastCursor })).not.toBeNull();
  expect(parse({ ...page([first, last]), hasNext: true, nextCursor: firstCursor })).toBeNull();
  expect(parse({ ...page(), hasNext: true, nextCursor: { ...firstCursor, extra: 1 } })).toBeNull();
  expect(parseV2Page({ ...page([first, last]), hasPrevious: true, previousCursor: firstCursor }, scope, morning, id(9), 'last')).not.toBeNull();
  expect(parseV2Page({ ...page(), hasNext: true, nextCursor: firstCursor }, scope, morning, id(9), 'last')).toBeNull();
  expect(parseV2Page(page(), scope, morning, 'bad', 'first')).toBeNull();
});
test('before and after bind strict sequence and identity to anchor', () => {
  const anchor = { id: id(999), seq: 5 };
  expect(parseV2Page(page([message(3)]), scope, morning, id(9), 'before', anchor)).not.toBeNull();
  expect(parseV2Page(page([message(7)]), scope, morning, id(9), 'after', anchor)).not.toBeNull();
  for (const direction of ['before', 'after'] as const) {
    expect(parseV2Page(page(), scope, morning, id(9), direction)).toBeNull();
    expect(parseV2Page(page(), scope, morning, id(9), direction, { id: 'bad', seq: 5 })).toBeNull();
    expect(parseV2Page(page([message(5)]), scope, morning, id(9), direction, anchor)).toBeNull();
    expect(parseV2Page(page([{ ...message(direction === 'before' ? 3 : 7), id: anchor.id }]), scope, morning, id(9), direction, anchor)).toBeNull();
  }
});

test('command IDs are scoped to each author, not the entire pair', () => {
  expect(parse(page([message(), { ...message(2), authorId: id(2), clientId: message().clientId }]))).not.toBeNull();
});

test('durable recipient opening permits reply timestamp before release after clock rollback', () => {
  expect(parseV2Message({ ...message(), createdAt: morning.createdAt }, scope, morning)).not.toBeNull();
});

test('v2 edits and tombstones require exact canonical monotonic timestamps', () => {
  const edited = { ...message(), version: 2, editedAt: morning.releaseAt };
  expect(parseV2Message(edited, scope, morning)).not.toBeNull();
  expect(parseV2Message({ ...edited, version: 3, body: null, deletedAt: morning.releaseAt }, scope, morning)).not.toBeNull();
  expect(parseV2Message({ ...message(), version: 2, body: null, deletedAt: morning.releaseAt }, scope, morning)).not.toBeNull();
  for (const patch of [{ version: 0 }, { version: 1, editedAt: morning.releaseAt }, { version: 2 },
    { version: 2, editedAt: 'bad' }, { version: 2, editedAt: morning.createdAt },
    { body: null, deletedAt: morning.releaseAt }, { version: 2, deletedAt: morning.releaseAt },
    { version: 2, body: null, deletedAt: morning.createdAt },
    { version: 3, body: null, editedAt: '2030-01-03T09:00:00.000Z', deletedAt: morning.releaseAt }]) {
    expect(parseV2Message({ ...message(), ...patch }, scope, morning)).toBeNull();
  }
});
