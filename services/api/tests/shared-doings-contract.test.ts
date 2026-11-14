import { expect, it } from 'vitest';
import { canAdvanceDoing, completeDoing, exact, followsDoing, instant, integer, kind, normalizeDoingTitle,
  orderDoings, record, uuid, validDoing, type SharedDoing } from '../../../packages/domain/doings/state.ts';
import { id } from './fixtures.ts';
const scope = { coupleId: id(10), membershipEpoch: 1, userId: id(1) };
const start = (parts = 2): SharedDoing => ({ id: id(20), coupleId: scope.coupleId, authorId: scope.userId, recipientId: id(2),
  membershipEpoch: 1, sequence: 1, version: 1, createdAt: '2026-11-10T00:00:00.000Z', contentState: 'active',
  decisionState: 'invited', title: 'Synthetic course', kind: 'course', parts, authorAt: 0 });
const key = (d: SharedDoing) => JSON.stringify(Object.entries(d).sort(([a], [b]) => a.localeCompare(b)));
/** Reference events, not version formulas: enumerate every actual small-course history. */
function events(d: SharedDoing): SharedDoing[] {
  if (d.contentState === 'removed') return [];
  const clean = Object.fromEntries(Object.entries(d).filter(([k]) => !['title', 'kind', 'parts', 'authorAt', 'recipientAt'].includes(k)));
  const result: SharedDoing[] = [{ ...clean, version: d.version + 1, contentState: 'removed',
    decisionState: d.decisionState === 'invited' ? 'withdrawn' : d.decisionState } as SharedDoing];
  if (d.decisionState === 'declined') return result;
  if (d.decisionState === 'invited') result.push({ ...d, decisionState: 'joined', recipientAt: 0, version: d.version + 1 });
  const withoutRecipient = Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'recipientAt'));
  result.push({ ...withoutRecipient, decisionState: 'declined', version: d.version + 1 } as SharedDoing);
  for (let at = d.authorAt + 1; at <= d.parts; at++) result.push({ ...d, authorAt: at, version: d.version + 1 });
  if (d.decisionState === 'joined') for (let at = d.recipientAt + 1; at <= d.parts; at++) result.push({ ...d, recipientAt: at, version: d.version + 1 });
  return result;
}
it('matches transitive reachability of every reference history at1..3 parts, including withdrawal after completion', () => {
  for (let parts = 1; parts <= 3; parts++) {
    const all = new Map<string, SharedDoing>([[key(start(parts)), start(parts)]]), queue = [start(parts)];
    for (let i = 0; i < queue.length; i++) for (const next of events(queue[i])) if (!all.has(key(next))) { all.set(key(next), next); queue.push(next); }
    for (const old of all.values()) {
      expect(validDoing(old, scope)).toBe(true);
      const reachable = new Set([key(old)]), next = [old];
      for (let i = 0; i < next.length; i++) for (const d of events(next[i])) if (!reachable.has(key(d))) { reachable.add(key(d)); next.push(d); }
      for (const d of all.values()) expect(followsDoing(old, d)).toBe(reachable.has(key(d)));
      expect(followsDoing(old, Object.fromEntries(Object.entries(old).reverse()) as SharedDoing)).toBe(true);
      for (const actor of [old.authorId, old.recipientId, id(99)]) {
        const advancing = events(old).filter(n => n.contentState === 'active' && old.contentState === 'active'
          && n.decisionState === old.decisionState && (actor === old.authorId ? n.authorAt > old.authorAt
            : actor === old.recipientId && n.decisionState === 'joined' && old.decisionState === 'joined' && n.recipientAt > old.recipientAt));
        expect(canAdvanceDoing(old, actor)).toBe(advancing.length > 0);
      }
    }
  }
});
it('rejects impossible first snapshots and immutable/terminal regressions while admitting maximum2004 history', () => {
  const d = start(), joined = { ...d, decisionState: 'joined', recipientAt: 0, version: 2 };
  for (const bad of [null, [], 4, {}, { ...d, contentState: 'x' }, { ...d, decisionState: 'x' }, { ...d, decisionState: 'withdrawn' },
    { ...d, id: 'bad' }, { ...d, coupleId: 'bad' }, { ...d, authorId: 'bad' }, { ...d, recipientId: 'bad' }, { ...d, recipientId: d.authorId },
    { ...d, authorId: id(3), recipientId: id(4) }, { ...d, coupleId: id(11) }, { ...d, membershipEpoch: 0 }, { ...d, membershipEpoch: 2 },
    { ...d, sequence: 0 }, { ...d, sequence: 101 }, { ...d, createdAt: 'bad' }, { ...d, version: 0 }, { ...d, version: 2005 },
    { ...d, version: 2004 }, { ...joined, version: 1 }, { ...joined, version: 3 }, { ...d, recipientAt: 0 }, { ...d, title: '' },
    { ...d, title: ' padded ' }, { ...d, title: null }, { ...d, kind: 'invalid' }, { ...d, parts: 0 }, { ...d, parts: 1001 },
    { ...d, authorAt: -1 }, { ...d, authorAt: 3 }, { ...joined, recipientAt: -1 }, { ...joined, recipientAt: 3 }, { ...joined, recipientAt: null }]) expect(validDoing(bad, scope)).toBe(false);
  const max = { ...d, parts: 1000, authorAt: 1000, recipientAt: 1000, decisionState: 'joined', version: 2002 } as SharedDoing;
  expect(validDoing(max, scope)).toBe(true); expect(completeDoing(max)).toBe(true);
  const declined = { ...d, parts: 1000, authorAt: 1000, decisionState: 'declined', version: 2003 } as SharedDoing;
  expect(validDoing(declined, scope)).toBe(true); expect(followsDoing(max, declined)).toBe(true);
  const removed = { id: d.id, coupleId: d.coupleId, authorId: d.authorId, recipientId: d.recipientId, membershipEpoch: 1,
    sequence: 1, createdAt: d.createdAt, contentState: 'removed', decisionState: 'declined', version: 2004 } as SharedDoing;
  expect(validDoing(removed, scope)).toBe(true); expect(followsDoing(declined, removed)).toBe(true);
  for (const bad of [{ ...removed, version: 2 }, { ...removed, decisionState: 'invited' }, { ...removed, decisionState: 'withdrawn', version: 1003 }, { ...removed, decisionState: 'joined', version: 2004 }, { ...removed, authorAt: 0 }]) expect(validDoing(bad, scope)).toBe(false);
  for (const field of ['id', 'coupleId', 'authorId', 'recipientId'] as const) expect(followsDoing(d, { ...d, [field]: id(99) })).toBe(false);
  for (const altered of [{ ...d, createdAt: '2026-11-11T00:00:00.000Z' }, { ...d, membershipEpoch: 2 }, { ...d, sequence: 2 },
    { ...d, title: 'Changed' }, { ...d, version: 2, title: 'Changed', authorAt: 1 }, { ...d, version: 2, kind: 'book', authorAt: 1 },
    { ...d, version: 2, parts: 3, authorAt: 1 }]) expect(followsDoing(d, altered as SharedDoing)).toBe(false);
  const advanced = { ...d, version: 2, authorAt: 1 } as SharedDoing;
  expect(followsDoing(advanced, { ...advanced, version: 3, authorAt: 0 } as SharedDoing)).toBe(false);
  const list = [removed, declined, max, { ...d, sequence: 2 }, d].sort(orderDoings);
  expect(list.slice(0, 2).map(d => d.sequence)).toEqual([2, 1]); expect(list.at(-1)).toBe(removed);
});
it('normalizes bounded single-line Unicode and rejects malformed input, keys, identifiers and clocks', () => {
  expect(normalizeDoingTitle(' e\u0301 ')).toBe('é'); expect(normalizeDoingTitle('🦉'.repeat(200))).not.toBeNull();
  for (const v of [null, 1, '', ' ', '\ud800', '\udfff', 'a\tb', 'x\0', '\u0080', 'x\r\ny', 'x'.repeat(201), 'x'.repeat(801)]) expect(normalizeDoingTitle(v)).toBeNull();
  expect(record({})).toBe(true); expect(record(null)).toBe(false); expect(record([])).toBe(false);
  expect(exact({ a: 1 }, 'a')).toBe(true); expect(exact({ a: 1, b: 2 }, 'a')).toBe(false);
  expect(uuid(id(1))).toBe(true); expect(uuid(1)).toBe(false); expect(uuid('bad')).toBe(false);
  expect(integer(1, 0, 2)).toBe(true); expect(integer(1.5, 0, 2)).toBe(false); expect(integer('1', 0, 2)).toBe(false);
  expect(kind('other')).toBe(true); expect(kind(1)).toBe(false); expect(kind('x')).toBe(false);
  expect(instant(start().createdAt)).toBe(true);
  for (const v of [1, '', '2026-02-30T00:00:00.000Z', '2026-01-01Z', '2026-99-01T00:00:00.000Z']) expect(instant(v)).toBe(false);
});
