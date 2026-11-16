import { expect, it } from 'vitest';
import { canReadDisputeMetadata, createDisputeMetadata, declineDisputeMetadata, followsDisputeMetadata,
  joinDisputeMetadata, latestDisputeEvent, projectDisputeMetadata, removeDisputeMetadata,
  resolveDisputeMetadata, validDisputeMetadata, type DisputeMetadata, type DisputeScope } from '../../../packages/domain/disputes/metadata.ts';
import { canReadDisputeText, createDispute, declineDispute, followsDispute, joinDispute,
  removeDispute, resolveDispute, validDispute, type Dispute } from '../../../packages/domain/disputes/policy.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const author = { userId: id(1), coupleId: id(3), membershipEpoch: 1 }, recipient = { ...author, userId: id(2) };
const now = '2026-11-16T08:00:00.000Z', due = '2026-11-16T21:00:00.000Z', after = '2026-11-17T09:00:00.000Z';
const input = { id: id(4), recipientId: id(2), judgeDate: '2026-11-17', timezone: 'Europe/Moscow' };
const terms = { claim: 'Synthetic claim', condition: 'Optional synthetic condition' };
const initial = () => createDisputeMetadata(input, author, now, true)!;
const full = () => createDispute({ ...input, ...terms }, author, now, true)!;
const joined = () => joinDisputeMetadata(initial(), recipient, now, 1, true)!;

it('constructs metadata without texts and rejects body-bearing create inputs', () => {
  expect(initial()).toEqual(projectDisputeMetadata(full()));
  expect(validDisputeMetadata(initial(), author)).toBe(true);
  expect(validDispute(initial(), author)).toBe(false);
  expect(createDisputeMetadata({ ...input, ...terms }, author, now, true)).toBeNull();
  expect(createDisputeMetadata({ ...input, condition: null }, author, now, true)).toBeNull();
  expect(createDisputeMetadata(input, author, now, false)).toBeNull();
  expect(createDisputeMetadata(input, author, due, true)).toBeNull();
  expect(createDisputeMetadata({ ...input, recipientId: author.userId }, author, now, true)).toBeNull();
});
it('explicit projection never reads or retains text keys or arbitrary extra data', () => {
  const wider = Object.defineProperties({ ...initial(), extra: 'Synthetic extra' }, {
    claim: { get: () => { throw Error('body projection read'); }, enumerable: true },
    condition: { get: () => { throw Error('condition projection read'); }, enumerable: true },
  });
  const projected = projectDisputeMetadata(wider);
  expect(projected).toEqual(initial()); expect(projected).not.toHaveProperty('claim');
  expect(projected).not.toHaveProperty('condition'); expect(projected).not.toHaveProperty('extra');
});
it.each(['claim', 'condition', 'text', 'body', 'extra'])('metadata boundary rejects unexpected key %s', key => {
  const bad = { ...initial(), [key]: null };
  expect(validDisputeMetadata(bad, author)).toBe(false);
  expect(followsDisputeMetadata(initial(), bad, author)).toBe(false);
  expect(followsDisputeMetadata(bad, initial(), author)).toBe(false);
  expect(joinDisputeMetadata(bad, recipient, now, 1, true)).toBeNull();
  expect(canReadDisputeMetadata(bad, recipient, now)).toBe(false);
});
it.each([null, undefined, [], 'scope', {}, { ...author, userId: id(8) }, { ...author, membershipEpoch: 2 }])('metadata scope fails closed %#', value => {
  const scope = value as unknown as DisputeScope;
  expect(validDisputeMetadata(initial(), scope)).toBe(false);
  expect(joinDisputeMetadata(initial(), scope, now, 1, true)).toBeNull();
  expect(declineDisputeMetadata(initial(), scope, now, 1, true)).toBeNull();
  expect(resolveDisputeMetadata(joined(), scope, due, 2, null, true)).toBeNull();
  expect(removeDisputeMetadata(initial(), scope, now, 1, true)).toBeNull();
  expect(canReadDisputeMetadata(initial(), scope, now)).toBe(false);
});
it('metadata and full-content operations commute through projection for every reachable branch', () => {
  const metadata: DisputeMetadata[] = [initial()], content: Dispute[] = [full()];
  const add = (m: DisputeMetadata | null, f: Dispute | null) => {
    expect(m).not.toBeNull(); expect(f).not.toBeNull();
    expect(m).toEqual(projectDisputeMetadata(f!));
    expect(m).not.toHaveProperty('claim'); expect(m).not.toHaveProperty('condition');
    metadata.push(m!); content.push(f!);
  };
  add(joinDisputeMetadata(metadata[0], recipient, now, 1, true), joinDispute(content[0], recipient, now, 1, true));
  add(declineDisputeMetadata(metadata[0], recipient, now, 1, true), declineDispute(content[0], recipient, now, 1, true));
  add(declineDisputeMetadata(metadata[1], recipient, after, 2, true), declineDispute(content[1], recipient, after, 2, true));
  for (const actor of [author, recipient]) for (const winner of [author.userId, recipient.userId, null]) {
    add(resolveDisputeMetadata(metadata[1], actor, due, 2, winner, true), resolveDispute(content[1], actor, due, 2, winner, true));
  }
  const active = metadata.length;
  for (let n = 0; n < active; n++) add(removeDisputeMetadata(metadata[n], author, after, metadata[n].version, true),
    removeDispute(content[n], author, after, content[n].version, true));
  for (let i = 0; i < metadata.length; i++) for (let j = 0; j < metadata.length; j++) for (const actor of [author, recipient]) {
    expect(followsDisputeMetadata(metadata[i], metadata[j], actor)).toBe(followsDispute(content[i], content[j], actor));
    expect(canReadDisputeMetadata(metadata[i], actor, after)).toBe(canReadDisputeText(content[i], actor, after));
  }
});
it('metadata permission, CAS and time gates remain explicit and terminal', () => {
  expect(joinDisputeMetadata(initial(), author, now, 1, true)).toBeNull();
  expect(joinDisputeMetadata(initial(), recipient, due, 1, true)).toBeNull();
  expect(resolveDisputeMetadata(initial(), author, due, 1, null, true)).toBeNull();
  expect(resolveDisputeMetadata(joined(), author, now, 2, null, true)).toBeNull();
  expect(resolveDisputeMetadata(joined(), author, due, 2, id(8), true)).toBeNull();
  const withdrawn = declineDisputeMetadata(joined(), recipient, after, 2, true)!;
  expect(withdrawn.winnerId).toBeNull(); expect(withdrawn.joinedAt).toBe(now);
  expect(latestDisputeEvent(withdrawn)).toBe(after);
  expect(resolveDisputeMetadata(withdrawn, author, after, 3, null, true)).toBeNull();
  const gone = removeDisputeMetadata(withdrawn, author, after, 3, true)!;
  expect(latestDisputeEvent(gone)).toBe(after); expect(canReadDisputeMetadata(gone, author, after)).toBe(false);
  for (const op of [joinDisputeMetadata, declineDisputeMetadata, removeDisputeMetadata]) {
    expect(op(gone, recipient, after, gone.version, true)).toBeNull();
    expect(op(initial(), recipient, now, 99, true)).toBeNull();
    expect(op(initial(), recipient, now, 1, false)).toBeNull();
    expect(op(initial(), recipient, 'bad', 1, true)).toBeNull();
  }
  expect(canReadDisputeMetadata(initial(), author, '2026-11-16T07:59:59.999Z')).toBe(false);
});
it('metadata rejects forged historical edits and preserves resolved outcome after removal', () => {
  const result = resolveDisputeMetadata(joined(), author, due, 2, author.userId, true)!;
  const gone = removeDisputeMetadata(result, author, after, 3, true)!;
  expect(followsDisputeMetadata(result, gone, author)).toBe(true);
  expect(gone.resolvedBy).toBe(author.userId); expect(gone.winnerId).toBe(author.userId);
  for (const patch of [{ winnerId: recipient.userId }, { resolvedBy: recipient.userId }, { resolvedAt: after },
    { joinedAt: '2026-11-16T09:00:00.000Z' }, { judgeDate: '2026-11-18' }, { version: 4 }]) {
    expect(followsDisputeMetadata(result, { ...result, ...patch }, author)).toBe(false);
  }
  expect(followsDisputeMetadata(gone, result, author)).toBe(false);
  expect(validDisputeMetadata({ ...gone, claim: 'restored' }, author)).toBe(false);
});

it.each(['active', 'removed'])('rejects coerced %s contentState without invoking conversion', state => {
  const base = state === 'active' ? initial() : removeDisputeMetadata(initial(), author, now, 1, true)!;
  const coercedStates: unknown[] = [[state], { toString: () => state },
    { toString: () => { throw Error('must not coerce state'); } }];
  for (const contentState of coercedStates) {
    const metadata = { ...base, contentState };
    expect(validDisputeMetadata(metadata, author)).toBe(false);
    expect(validDispute(metadata, author)).toBe(false);
    expect(validDispute({ ...metadata, ...terms }, author)).toBe(false);
    expect(canReadDisputeMetadata(metadata, author, now)).toBe(false);
    expect(canReadDisputeText(metadata, author, now)).toBe(false);
    expect(followsDisputeMetadata(base, metadata, author)).toBe(false);
    expect(followsDisputeMetadata(metadata, base, author)).toBe(false);
  }
});
