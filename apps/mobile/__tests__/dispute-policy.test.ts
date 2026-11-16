import { createDispute, parseDisputeSchedule, normalizeDisputeClaim, normalizeDisputeCondition,
  validDispute, joinDispute, declineDispute, resolveDispute, removeDispute, canReadDisputeText,
  followsDispute, type Dispute, type DisputeScope } from '../../../packages/domain/disputes/policy.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const author = { coupleId: id(1), userId: id(2), membershipEpoch: 1 };
const recipient = { ...author, userId: id(3) };
const now = '2026-11-16T08:00:00.000Z', joinedTime = '2026-11-16T09:00:00.000Z';
const before = '2026-11-16T20:59:59.999Z', due = '2026-11-16T21:00:00.000Z';
const after = '2026-11-18T08:00:00.000Z';
const input = { id: id(4), recipientId: recipient.userId, claim: 'Synthetic shared claim', condition: 'Optional shared activity',
  judgeDate: '2026-11-17', timezone: 'Europe/Moscow' };
const schedule = { judgeDate: input.judgeDate, timezone: input.timezone };
const invited = () => createDispute(input, author, now, true)!;
const joined = () => joinDispute(invited(), recipient, joinedTime, 1, true)!;
const declined = () => declineDispute(invited(), recipient, joinedTime, 1, true)!;
const resolved = () => resolveDispute(joined(), author, due, 2, author.userId, true)!;
const scopeFor = (value: Dispute) => ({ coupleId: value.coupleId, membershipEpoch: value.membershipEpoch, userId: value.authorId });

describe('dispute text is bounded, canonical and nonbinding', () => {
  it('normalizes NFC, CRLF and outer whitespace while preserving paragraphs', () => {
    expect(normalizeDisputeClaim(' e\u0301\r\n\r\nnext ')).toBe('é\n\nnext');
    expect(normalizeDisputeCondition(' e\u0301\r\nnext ')).toBe('é\nnext');
    expect(normalizeDisputeClaim('🦉'.repeat(2000))).toBe('🦉'.repeat(2000));
    expect(normalizeDisputeCondition('🦉'.repeat(500))).toBe('🦉'.repeat(500));
    expect(normalizeDisputeCondition(null)).toBeNull(); expect(normalizeDisputeCondition(' \n ')).toBeNull();
  });
  it.each([null, undefined, 1, {}, [], '', ' \n ', 'x'.repeat(2001), '🦉'.repeat(2001), 'x'.repeat(9000),
    'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb', '\ud800', '\udfff', 'a\ud800b'])('rejects malformed claim %#', value => {
    expect(normalizeDisputeClaim(value)).toBeNull();
  });
  it.each([undefined, 1, {}, [], 'x'.repeat(501), '🦉'.repeat(501), 'x'.repeat(9000), 'a\rb', 'a\tb', '\ud800'])('distinguishes malformed condition from absence %#', value => {
    expect(normalizeDisputeCondition(value)).toBeUndefined();
  });
});
describe('calendar date in an explicit canonical zone', () => {
  it('accepts future local dates and canonicalizes aliases', () => {
    expect(parseDisputeSchedule(schedule, now)).toEqual(schedule);
    expect(parseDisputeSchedule({ judgeDate: '2026-11-17', timezone: 'US/Eastern' }, now)?.timezone).toBe('America/New_York');
    expect(parseDisputeSchedule({ judgeDate: '2028-02-29', timezone: 'UTC' }, now)).not.toBeNull();
  });
  it.each([null, [], {}, { ...schedule, extra: true }, { ...schedule, judgeDate: '2026-2-01' },
    { ...schedule, judgeDate: '2027-02-29' }, { ...schedule, judgeDate: '2026-02-30' }, { ...schedule, judgeDate: '1999-12-31' },
    { ...schedule, judgeDate: '2101-01-01' }, { ...schedule, judgeDate: '2026-11-16' }, { ...schedule, judgeDate: '2026-11-15' },
    { ...schedule, timezone: 'bad' }, { ...schedule, timezone: null }, { ...schedule, judgeDate: null }])('rejects schedule %#', value => {
    expect(parseDisputeSchedule(value, now)).toBeNull();
  });
  it.each(['bad', '2026-11-16T08:00:00Z', '2026-02-30T08:00:00.000Z', '2026-11-16T11:00:00.000+03:00'])('rejects untrusted/noncanonical clock %s', clock => {
    expect(parseDisputeSchedule(schedule, clock)).toBeNull();
  });
  it('future local day is not a UTC day or elapsed 24 hours', () => {
    const s = { judgeDate: '2026-11-17', timezone: 'Pacific/Kiritimati' };
    expect(parseDisputeSchedule(s, '2026-11-16T09:59:59.999Z')).toEqual(s);
    expect(parseDisputeSchedule(s, '2026-11-16T10:00:00.000Z')).toBeNull();
  });
  it.each([
    ['2027-03-14', 'America/New_York', '2027-03-14T04:59:59.999Z', '2027-03-14T05:00:00.000Z'],
    ['2027-11-07', 'America/New_York', '2027-11-07T03:59:59.999Z', '2027-11-07T04:00:00.000Z'],
    ['2011-12-30', 'Pacific/Apia', '2011-12-30T09:59:59.999Z', '2011-12-30T10:00:00.000Z'],
  ])('uses real local dates across DST or a skipped day %s/%s', (judgeDate, timezone, previous, threshold) => {
    const created = new Date(Date.parse(previous) - 86400000).toISOString();
    const first = createDispute({ ...input, judgeDate, timezone }, author, created, true)!;
    expect(first).not.toBeNull();
    const accepted = joinDispute(first, recipient, previous, 1, true)!;
    expect(accepted).not.toBeNull();
    expect(resolveDispute(accepted, author, previous, 2, null, true)).toBeNull();
    expect(joinDispute(first, recipient, threshold, 1, true)).toBeNull();
    expect(resolveDispute(accepted, author, threshold, 2, null, true)?.decisionState).toBe('resolved');
  });
});
describe('strict creation and scoped readable metadata', () => {
  it('creates exactly one shared immutable statement, with no implied consent', () => {
    const value = invited(); expect(value).not.toBeNull();
    expect(value).toMatchObject({ version: 1, decisionState: 'invited', contentState: 'active', joinedAt: null,
      declinedAt: null, resolvedAt: null, resolvedBy: null, winnerId: null, removedAt: null, createdAt: now });
    expect(validDispute(value, author)).toBe(true); expect(validDispute(value, recipient)).toBe(true);
    expect(canReadDisputeText(value, author, now)).toBe(true); expect(canReadDisputeText(value, recipient, now)).toBe(true);
    expect(createDispute({ ...input, condition: '' }, author, now, true)).toHaveProperty('condition', null);
    expect(createDispute({ ...input, claim: ' e\u0301 ' }, author, now, true)).toHaveProperty('claim', 'é');
  });
  it.each([null, [], {}, { ...input, extra: true }, { ...input, id: 'bad' }, { ...input, recipientId: author.userId },
    { ...input, recipientId: 'bad' }, { ...input, claim: '' }, { ...input, condition: 'x'.repeat(501) },
    { ...input, condition: undefined }, { ...input, judgeDate: 'bad' }])('rejects invalid creation %#', value => {
    expect(createDispute(value, author, now, true)).toBeNull();
  });
  it.each([{ ...author, userId: 'bad' }, { ...author, coupleId: 'bad' }, { ...author, membershipEpoch: 0 },
    { ...author, membershipEpoch: 1.5 }, { ...author, membershipEpoch: 2147483647 }])('rejects invalid scope %#', scope => {
    expect(createDispute(input, scope, now, true)).toBeNull(); expect(validDispute(invited(), scope)).toBe(false);
  });
  it.each([{ ...author, userId: id(90) }, { ...author, coupleId: id(91) }, { ...author, membershipEpoch: 2 }])('denies other participant/pair/epoch %#', scope => {
    expect(validDispute(invited(), scope)).toBe(false); expect(canReadDisputeText(invited(), scope, now)).toBe(false);
    expect(joinDispute(invited(), scope, now, 1, true)).toBeNull(); expect(removeDispute(invited(), scope, now, 1, true)).toBeNull();
    expect(declineDispute(invited(), scope, now, 1, true)).toBeNull(); expect(resolveDispute(joined(), scope, due, 2, null, true)).toBeNull();
  });
  it('requires confirmation, valid trusted clock and no future-created text', () => {
    expect(createDispute(input, author, now, false)).toBeNull(); expect(createDispute(input, author, 'bad', true)).toBeNull();
    expect(canReadDisputeText(invited(), author, '2026-11-16T07:59:59.999Z')).toBe(false);
    expect(canReadDisputeText(invited(), author, 'bad')).toBe(false);
  });
});
describe('consent, verdict, withdrawal and author removal', () => {
  it('only recipient joins, only before the date; no implicit expiry or loss', () => {
    expect(joinDispute(invited(), author, now, 1, true)).toBeNull();
    expect(joinDispute(invited(), recipient, before, 1, true)).toHaveProperty('joinedAt', before);
    expect(joinDispute(invited(), recipient, due, 1, true)).toBeNull();
    expect(joinDispute(invited(), recipient, after, 1, true)).toBeNull();
    expect(resolveDispute(invited(), author, after, 1, author.userId, true)).toBeNull();
    expect(declineDispute(invited(), recipient, after, 1, true)).toMatchObject({ decisionState: 'declined', winnerId: null, resolvedAt: null });
  });
  it.each([author.userId, recipient.userId, null])('either member may record outcome %s once, only after join and due', winner => {
    for (const actor of [author, recipient]) {
      expect(resolveDispute(joined(), actor, before, 2, winner, true)).toBeNull();
      const result = resolveDispute(joined(), actor, due, 2, winner, true)!;
      expect(result).toMatchObject({ version: 3, decisionState: 'resolved', winnerId: winner, resolvedBy: actor.userId, resolvedAt: due });
      expect(resolveDispute(result, actor, after, 3, winner, true)).toBeNull();
      expect(declineDispute(result, recipient, after, 3, true)).toBeNull();
    }
  });
  it.each(['draw', id(90), '', undefined, 1])('rejects nonparticipant winner %#', winner => {
    expect(resolveDispute(joined(), author, due, 2, winner, true)).toBeNull();
  });
  it('withdrawal after joining and after due is not losing; texts remain shared until author removal', () => {
    const result = declineDispute(joined(), recipient, after, 2, true)!;
    expect(result).toMatchObject({ version: 3, decisionState: 'declined', joinedAt: joinedTime, declinedAt: after, winnerId: null, resolvedAt: null });
    expect(canReadDisputeText(result, author, after)).toBe(true); expect(canReadDisputeText(result, recipient, after)).toBe(true);
    expect(resolveDispute(result, author, after, 3, null, true)).toBeNull(); expect(joinDispute(result, recipient, after, 3, true)).toBeNull();
    expect(declineDispute(invited(), author, now, 1, true)).toBeNull();
  });
  it.each(['join', 'decline', 'remove', 'resolve'] as const)('%s requires exact CAS, confirmation and monotonic time', kind => {
    const value = kind === 'resolve' ? joined() : invited(), actor = kind === 'join' || kind === 'decline' ? recipient : author;
    const run = (time: string, version: number, confirm: boolean) => kind === 'resolve' ? resolveDispute(value, actor, time, version, null, confirm)
      : kind === 'join' ? joinDispute(value, actor, time, version, confirm)
        : kind === 'decline' ? declineDispute(value, actor, time, version, confirm) : removeDispute(value, actor, time, version, confirm);
    expect(run(kind === 'resolve' ? due : now, value.version, false)).toBeNull();
    expect(run(kind === 'resolve' ? due : now, value.version + 1, true)).toBeNull();
    expect(run('bad', value.version, true)).toBeNull(); expect(run('2026-11-15T08:00:00.000Z', value.version, true)).toBeNull();
  });
  it('author removal works in every decision state, omits both text keys and is terminal', () => {
    for (const value of [invited(), joined(), declined(), resolved(), declineDispute(joined(), recipient, after, 2, true)!]) {
      expect(removeDispute(value, recipient, after, value.version, true)).toBeNull();
      const gone = removeDispute(value, author, after, value.version, true)!;
      expect(gone).toMatchObject({ decisionState: value.decisionState, version: value.version + 1, removedAt: after, contentState: 'removed' });
      expect(gone).not.toHaveProperty('claim'); expect(gone).not.toHaveProperty('condition');
      expect(validDispute(gone, author)).toBe(true); expect(canReadDisputeText(gone, recipient, after)).toBe(false);
      expect(joinDispute(gone, recipient, after, gone.version, true)).toBeNull(); expect(declineDispute(gone, recipient, after, gone.version, true)).toBeNull();
      expect(resolveDispute(gone, author, after, gone.version, null, true)).toBeNull(); expect(removeDispute(gone, author, after, gone.version, true)).toBeNull();
    }
  });
});
describe('strict metadata rejects invented or rewritten events', () => {
  it.each([
    { body: 'not allowed' }, { claim: ' untrimmed ' }, { claim: 'e\u0301' }, { claim: null }, { condition: '' }, { condition: undefined },
    { condition: 3 }, { id: 'bad' }, { authorId: 'bad' }, { recipientId: 'bad' }, { recipientId: author.userId },
    { createdAt: 'bad' }, { createdAt: due }, { judgeDate: '2026-02-30' }, { timezone: 'US/Eastern' }, { contentState: 'unknown' },
    { version: 0 }, { version: 2 }, { version: 1.5 }, { decisionState: 'joined' },
    { joinedAt: 'bad' }, { joinedAt: '2026-11-15T08:00:00.000Z' }, { joinedAt: due, decisionState: 'joined', version: 2 },
    { resolvedBy: author.userId }, { winnerId: author.userId }, { removedAt: after },
    { resolvedAt: due, resolvedBy: author.userId, winnerId: null, decisionState: 'resolved', version: 2 },
  ])('rejects malformed metadata patch %#', patch => {
    expect(validDispute({ ...invited(), ...patch }, author)).toBe(false);
  });
  it.each([null, undefined, [], {}, 'text'])('rejects non-records and missing fields %#', value => {
    expect(validDispute(value, author)).toBe(false); expect(followsDispute(value, invited(), author)).toBe(false);
    expect(followsDispute(invited(), value, author)).toBe(false);
  });
  it.each([
    { resolvedAt: before }, { resolvedAt: '2026-11-16T08:30:00.000Z' }, { resolvedBy: id(99) }, { resolvedBy: 'bad' },
    { winnerId: id(99) }, { winnerId: 'draw' }, { joinedAt: null }, { declinedAt: due, version: 4 },
  ])('rejects forged resolution %#', patch => { expect(validDispute({ ...resolved(), ...patch }, author)).toBe(false); });
  it('enforces chronological refusal/removal and completely absent body keys after removal', () => {
    expect(validDispute({ ...joined(), decisionState: 'declined', declinedAt: now, version: 3 }, author)).toBe(false);
    const gone = removeDispute(resolved(), author, after, 3, true)!;
    expect(validDispute({ ...gone, removedAt: joinedTime }, author)).toBe(false);
    expect(validDispute({ ...gone, removedAt: null }, author)).toBe(false);
    expect(validDispute({ ...gone, claim: null }, author)).toBe(false); expect(validDispute({ ...gone, condition: null }, author)).toBe(false);
    expect(validDispute({ ...gone, contentState: 'active' }, author)).toBe(false);
    expect(canReadDisputeText(joined(), recipient, now)).toBe(false);
  });
});
describe('progression proves actual reachability rather than version growth', () => {
  it('matches every pair in the legal consent/refusal/verdict/removal DAG, including equal event timestamps', () => {
    const values: Dispute[] = [invited()];
    const edges: [number, number][] = [];
    const add = (from: number, value: Dispute | null) => {
      expect(value).not.toBeNull(); const index = values.push(value!) - 1; edges.push([from, index]); return index;
    };
    const j = add(0, joinDispute(values[0], recipient, now, 1, true));
    add(0, declineDispute(values[0], recipient, now, 1, true));
    add(j, declineDispute(values[j], recipient, now, 2, true));
    for (const actor of [author, recipient]) for (const winner of [author.userId, recipient.userId, null]) {
      add(j, resolveDispute(values[j], actor, due, 2, winner, true));
    }
    const activeLength = values.length;
    for (let n = 0; n < activeLength; n++) add(n, removeDispute(values[n], author, after, values[n].version, true));
    const reachable = (from: number, to: number): boolean => from === to || edges.some(([start, end]) => start === from && reachable(end, to));
    for (let from = 0; from < values.length; from++) for (let to = 0; to < values.length; to++) {
      expect(validDispute(values[from], author)).toBe(true);
      expect(followsDispute(values[from], values[to], author)).toBe(reachable(from, to));
      expect(followsDispute(values[from], values[to], recipient)).toBe(reachable(from, to));
    }
  });
  it.each([{ id: id(99) }, { coupleId: id(99) }, { authorId: id(99) }, { recipientId: id(99) }, { membershipEpoch: 2 },
    { createdAt: '2026-11-15T08:00:00.000Z' }, { judgeDate: '2026-11-18' }, { timezone: 'UTC' },
    { claim: 'Different canonical claim' }, { condition: 'Different canonical condition' }])('rejects immutable field rewriting %#', patch => {
    const old = invited(), next = { ...old, ...patch };
    expect(followsDispute(old, next, author)).toBe(false);
  });
  it('forbids inserting consent before an already observed decline even if the new object is valid', () => {
    const old = declined(), inserted = { ...old, joinedAt: now, version: 3 };
    expect(validDispute(inserted, author)).toBe(true); expect(followsDispute(old, inserted, author)).toBe(false);
    expect(followsDispute(old, { ...inserted, claim: 'Changed' }, author)).toBe(false);
  });
  it('rejects changed verdict/resolver, removal resurrection and changed past timestamps', () => {
    const old = resolved();
    expect(followsDispute(old, { ...old, winnerId: recipient.userId }, author)).toBe(false);
    expect(followsDispute(old, { ...old, resolvedBy: recipient.userId }, author)).toBe(false);
    expect(followsDispute(old, { ...old, resolvedAt: after }, author)).toBe(false);
    const gone = removeDispute(old, author, after, old.version, true)!;
    expect(followsDispute(gone, old, author)).toBe(false);
    expect(followsDispute(gone, { ...gone, removedAt: '2026-11-19T08:00:00.000Z' }, author)).toBe(false);
    expect(followsDispute(joined(), { ...joined(), joinedAt: now }, author)).toBe(false);
  });
  it('does not mutate objects and accepts fully identical active/removed snapshots', () => {
    const old = Object.freeze(invited());
    const next = joinDispute(old, recipient, now, 1, true)!;
    expect(old.version).toBe(1); expect(followsDispute(old, { ...old }, scopeFor(old))).toBe(true);
    const gone = removeDispute(next, author, after, next.version, true)!;
    expect(followsDispute(gone, { ...gone }, scopeFor(gone))).toBe(true);
  });
});

it.each([null, undefined, [], 'scope', 1])('rejects malformed runtime scope %# without throwing', value => {
  const scope = value as unknown as DisputeScope;
  expect(createDispute(input, scope, now, true)).toBeNull(); expect(validDispute(invited(), scope)).toBe(false);
  expect(canReadDisputeText(invited(), scope, now)).toBe(false); expect(followsDispute(invited(), invited(), scope)).toBe(false);
  expect(joinDispute(invited(), scope, now, 1, true)).toBeNull(); expect(declineDispute(invited(), scope, now, 1, true)).toBeNull();
  expect(removeDispute(invited(), scope, now, 1, true)).toBeNull(); expect(resolveDispute(joined(), scope, due, 2, null, true)).toBeNull();
});
