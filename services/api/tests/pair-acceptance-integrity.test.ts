import { expect, it } from 'vitest';
import { coupleId, fixture, id, mutations, now, ownerId, request, row, userId } from './pair-acceptance-fixture.ts';

it('fails closed on malformed discovery, identities, memberships, epochs and clocks without mutation', async () => {
  const invalid = [{ initial: [{ user_id: 'bad' }] }, { initial: [{ user_id: userId }, { user_id: userId }] },
    ...[{ id: 'bad' }, { couple_id: 'bad' }, { issuer_user_id: 'bad' }, { token_hash: 1 }, { token_hash: 'invalid' }].map(change => ({ discover: [row(change)] })),
    { discover: [row(), row()] }, { invite: [row(), row()] }, { ownerInitial: [{ auth_user_id: '' }] },
    { ownerInitial: [{ auth_user_id: 'one' }, { auth_user_id: 'two' }] }, { ownerMapping: [{ auth_user_id: 123 }] },
    { mapping: [{ user_id: 'bad' }] }, { ownerMembership: [{ couple_id: 'bad' }] },
    { couple: [] }, { couple: [{ status: 'bad', membership_epoch: 1 }] }, { couple: [{ status: 'waiting_partner', membership_epoch: 0 }] },
    { recipient: [{ couple_id: 'bad', slot: 2, status: 'revoked' }] }, { recipient: [{ couple_id: coupleId, slot: 9, status: 'revoked' }] },
    { recipient: [{ couple_id: coupleId, slot: 2, status: 'bad' }] }, { clock: [] }, { clock: [{ now: 'bad' }] },
    { counts: [] }, ...[{ active_count: -1 }, { issuer_count: 0.1 }, { recipient_count: undefined }, { issuer_count: 2 },
      { recipient_count: 2 }, { issuer_count: 1, recipient_count: 1 }].map(change => ({ counts: [{ active_count: 1, issuer_count: 1, recipient_count: 0, ...change }] }))];
  for (const overrides of invalid) {
    const f = fixture(overrides); const response = await f.handler(request());
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
    expect(mutations(f)).toHaveLength(0); expect(f.rolledBack).toHaveBeenCalledOnce();
  }
});

it('rejects impossible consume/consumer/timestamp states without exposing their metadata', async () => {
  for (const change of [{ command_id: 'bad' }, { created_at: 'bad' }, { expires_at: 'bad' }, { revoked_at: 'bad' },
    { consumed_by_user_id: userId }, { consumed_at: now.toISOString(), consumed_by_user_id: null },
    { consumed_at: now.toISOString(), consumed_by_user_id: 'bad' }, { consumed_at: now.toISOString(), consumed_by_user_id: ownerId },
    { consumed_at: new Date(+now + 1).toISOString(), consumed_by_user_id: userId },
    { consumed_at: now.toISOString(), consumed_by_user_id: userId, revoked_at: now.toISOString() },
    { created_at: new Date(+now - 1000).toISOString(), expires_at: now.toISOString(), consumed_at: now.toISOString(), consumed_by_user_id: userId }]) {
    const f = fixture({ invite: [row(change)] }); const response = await f.handler(request());
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
    expect(mutations(f)).toHaveLength(0);
  }
});

it('throws on each missing or malformed mutation acknowledgement, requiring atomic rollback without retries', async () => {
  const member = { couple_id: coupleId, user_id: userId, slot: 2, status: 'active' };
  const coupled = { id: coupleId, status: 'active', membership_epoch: 2 };
  const consumed = row({ consumed_at: now.toISOString(), consumed_by_user_id: userId });
  const groups = [
    { key: 'inserted', count: 1, values: [[], [member, member], ...[{ couple_id: id(99) }, { user_id: id(99) },
      { slot: 1 }, { status: 'revoked' }].map(change => [{ ...member, ...change }])] },
    { key: 'activated', count: 2, values: [[], [coupled, coupled], ...[{ id: id(99) }, { status: 'waiting_partner' },
      { membership_epoch: 3 }].map(change => [{ ...coupled, ...change }])] },
    { key: 'consumed', count: 3, values: [[], [consumed, consumed], ...[{ id: id(99) }, { command_id: id(99) },
      { couple_id: id(99) }, { issuer_user_id: id(99) }, { token_hash: 'b'.repeat(64) }, { created_at: 'different' },
      { expires_at: 'different' }, { revoked_at: now.toISOString() }, { consumed_at: null },
      { consumed_at: new Date(+now + 1).toISOString() }, { consumed_by_user_id: id(99) }].map(change => [{ ...consumed, ...change }])] },
  ];
  for (const group of groups) for (const rows of group.values) {
    const f = fixture({ [group.key]: rows }); const response = await f.handler(request());
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
    expect(mutations(f)).toHaveLength(group.count); expect(f.rolledBack).toHaveBeenCalledOnce(); expect(f.transaction).toHaveBeenCalledOnce();
  }
  for (const write of ['INSERT INTO couple_members', 'UPDATE couples', 'UPDATE pair_invites']) {
    const f = fixture(), original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, params) => { if (sql.includes(write)) throw new Error('private SQL failure'); return original(sql, params); });
    expect((await f.handler(request())).status).toBe(503); expect(f.rolledBack).toHaveBeenCalledOnce(); expect(f.transaction).toHaveBeenCalledOnce();
  }
});
