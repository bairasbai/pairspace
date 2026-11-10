import { expect, it } from 'vitest';
import { coupleId, expires, fixture, hash, id, mutations, now, origin, ownerId,
  replayRows, request, row, token, userId } from './pair-acceptance-fixture.ts';

it('previews without reservation or identities, then accepts atomically with hash-only lookup and stable user lock ordering', async () => {
  const preview = fixture(); const response = await preview.handler(request(true));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, value: { state: 'available', expiresAt: row().expires_at } });
  expect(mutations(preview)).toHaveLength(0);
  const f = fixture(); const accepted = await f.handler(request());
  expect(accepted.status).toBe(200); expect(accepted.headers.get('cache-control')).toBe('no-store');
  expect(accepted.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await accepted.json()).toEqual({ ok: true, value: { state: 'accepted', sessionId: 'recipient-session',
    userId, coupleId, membershipEpoch: 2, replayed: false } });
  expect(JSON.stringify(f.query.mock.calls).includes(token)).toBe(false);
  const calls = f.query.mock.calls, sql = calls.map(([s]) => s.replace(/\s+/g, ' ').trim());
  expect(calls.filter(([s]) => s.includes('FROM users')).map(([, p]) => p)).toEqual([[ownerId], [userId]]);
  const usersLast = sql.map(s => s.includes('FROM users')).lastIndexOf(true);
  expect(sql.slice(0, usersLast).some(s => /FOR SHARE/.test(s))).toBe(false);
  expect(sql.findIndex(s => s.includes('FROM couples'))).toBeLessThan(sql.findIndex(s => s.includes('FROM pair_invites') && s.includes('FOR UPDATE')));
  expect(calls.filter(([s]) => s.includes('FROM pair_invites')).every(([, p]) => JSON.stringify(p) === JSON.stringify([hash]))).toBe(true);
  expect(calls.filter(([s]) => s.includes('FROM "session"')).every(([, p]) => p?.[0] === 'recipient-session')).toBe(true);
  expect(mutations(f).map(([s]) => s.trim().split(/\s+/).slice(0, 3).join(' ')))
    .toEqual(['INSERT INTO couple_members(couple_id,user_id,slot,status)', "UPDATE couples SET", 'UPDATE pair_invites SET']);
  expect(sql.join('\n')).not.toMatch(/ON CONFLICT|INSERT INTO users|outbox_events|chat_messages/);
});

it('replays only the same currently active recipient and current epoch, including after original TTL without writes', async () => {
  for (const expiry of [row().expires_at, new Date(+now - 1).toISOString()]) {
    const invite = row({ created_at: new Date(+now - 700000).toISOString(), expires_at: expiry,
      consumed_at: new Date(+now - 10000).toISOString(), consumed_by_user_id: userId });
    const f = fixture({ ...replayRows(), invite: [invite], couple: [{ status: 'active', membership_epoch: 3 }] });
    const response = await f.handler(request()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, value: { state: 'accepted', sessionId: 'recipient-session', userId, coupleId,
      membershipEpoch: 3, replayed: true } }); expect(mutations(f)).toHaveLength(0);
    expect((await f.handler(request(true))).status).toBe(409); expect(mutations(f)).toHaveLength(0);
  }
});

it('requires exactly the bounded canonical token and explicit true acceptance, no selectors or GET', async () => {
  const f = fixture();
  for (const preview of [true, false]) {
    for (const method of ['GET', 'HEAD', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = await f.handler(new Request(`${origin}/v1/pair-invitations/${preview ? 'preview' : 'accept'}`, { method }));
      expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('POST');
    }
    expect((await f.handler(request(preview, '{}', '?token=forbidden'))).status).toBe(400);
    for (const body of [null, '', '{', 'null', '[]', '1', 'true', '{}', new Uint8Array([255]),
      JSON.stringify({ token, accept: !preview, coupleId }), JSON.stringify({ token: 1 }),
      JSON.stringify(preview ? { accept: true } : { token }),
      ...['', 'a'.repeat(42), 'a'.repeat(44), ' '.repeat(43), token + '=', token.slice(0, -1) + 'F'].map(value =>
        JSON.stringify(preview ? { token: value } : { token: value, accept: true }))]) {
      expect((await f.handler(request(preview, body))).status).toBe(400);
    }
    for (const type of ['', 'text/plain']) expect((await f.handler(request(preview, '{}', '', { 'content-type': type }))).status).toBe(415);
    const absent = request(preview); absent.headers.delete('content-type'); expect((await f.handler(absent)).status).toBe(415);
  }
  for (const accept of [false, null, 1, 'true']) expect((await f.handler(request(false, JSON.stringify({ token, accept })))).status).toBe(400);
  expect((await f.handler(new Request(origin + '/elsewhere'))).status).toBe(404);
  expect(f.read).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
});

it('requires official current cookie transport and fresh authoritative session after all lock waits', async () => {
  const f = fixture();
  for (const headers of [{ cookie: '' }, { authorization: 'Bearer synthetic' }, { origin: 'https://other.invalid' }] as Record<string, string>[]) {
    expect((await f.handler(request(false, undefined, '', headers))).status).toBe(401);
  }
  expect(f.read).not.toHaveBeenCalled(); f.read.mockResolvedValueOnce(null); expect((await f.handler(request())).status).toBe(401);
  const expo = request(true, undefined, '', { 'expo-origin': 'pairspace://', 'content-type': 'application/json; charset=utf-8' });
  expo.headers.delete('origin'); expect((await f.handler(expo)).status).toBe(200);
  for (const overrides of [{ provider: [] }, { session: [] }, { session: [{ created_at: expires.toISOString(), expires_at: expires.toISOString() }] }]) {
    const f = fixture(overrides); expect((await f.handler(request())).status).toBe(401); expect(mutations(f)).toHaveLength(0);
  }
  for (const marker of ['FROM users', 'FROM better_auth_identities', 'FROM couples', 'FROM pair_invites']) {
    const blocked = fixture(); const original = blocked.query.getMockImplementation()!;
    blocked.query.mockImplementation(async (sql, params) => {
      const result = await original(sql, params);
      if (sql.includes(marker) && /FOR SHARE|FOR UPDATE/.test(sql)) blocked.rows.clock = [{ now: expires.toISOString() }];
      return result;
    });
    expect((await blocked.handler(request())).status).toBe(401); expect(mutations(blocked)).toHaveLength(0);
  }
});

it('requires existing live stable profiles/providers and does not follow remapped identities', async () => {
  for (const overrides of [{ initial: [] }, { user: [] }, { user: [{ deleted_at: now.toISOString() }] },
    { mapping: [] }, { mapping: [{ user_id: id(99) }] }]) {
    const f = fixture(overrides); const response = await f.handler(request());
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ ok: false, error: 'profile_unavailable' });
    expect(mutations(f)).toHaveLength(0);
  }
  for (const overrides of [{ ownerUser: [] }, { ownerUser: [{ deleted_at: now.toISOString() }] }, { ownerInitial: [] },
    { ownerMapping: [] }, { ownerMapping: [{ auth_user_id: 'replacement-provider' }] }, { ownerProvider: [] },
    { ownerProvider: [{ id: 'replacement-provider' }] }]) {
    const f = fixture(overrides); const response = await f.handler(request());
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ ok: false, error: 'invitation_unavailable' });
    expect(mutations(f)).toHaveLength(0);
  }
});

it('uniformly denies unknown/self/changed/revoked/expired tokens and membership conflicts, without mutation or identity leaks', async () => {
  const expired = row({ created_at: new Date(+now - 600000).toISOString(), expires_at: now.toISOString() });
  const variants = [{ discover: [] }, { discover: [row({ issuer_user_id: userId })] }, { discover: [row({ token_hash: 'b'.repeat(64) })] },
    { invite: [] }, ...[{ id: id(99) }, { couple_id: id(99) }, { issuer_user_id: id(99) }, { token_hash: 'b'.repeat(64) },
      { revoked_at: now.toISOString() }].map(change => ({ invite: [row(change)] })), { invite: [expired] },
    { couple: [{ status: 'active', membership_epoch: 1 }] }, { couple: [{ status: 'closed', membership_epoch: 1 }] },
    { couple: [{ status: 'waiting_partner', membership_epoch: 2147483646 }] }, { ownerMembership: [] }, { ownerMembership: [{ couple_id: id(99) }] },
    { recipient: [{ couple_id: id(99), slot: 1, status: 'active' }] }, { recipient: [{ couple_id: coupleId, slot: 2, status: 'revoked' }] },
    { counts: [{ active_count: 2, issuer_count: 1, recipient_count: 0 }] }, { counts: [{ active_count: 1, issuer_count: 0, recipient_count: 0 }] }];
  for (const overrides of variants) for (const preview of [true, false]) {
    const f = fixture(overrides); const response = await f.handler(request(preview));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ ok: false, error: 'invitation_unavailable' });
    expect(mutations(f)).toHaveLength(0);
  }
});

it('revalidates independently after preview and denies consumed tokens to third parties or changed pair memberships', async () => {
  const f = fixture(); expect((await f.handler(request(true))).status).toBe(200);
  f.rows.invite = [row({ revoked_at: now.toISOString() })]; expect((await f.handler(request())).status).toBe(409);
  for (const overrides of [{ invite: [row({ consumed_at: now.toISOString(), consumed_by_user_id: id(99) })] },
    { recipient: [] }, { recipient: [{ couple_id: id(99), slot: 2, status: 'active' }] },
    { recipient: [{ couple_id: coupleId, slot: 1, status: 'active' }] }, { recipient: [{ couple_id: coupleId, slot: 2, status: 'revoked' }] },
    { counts: [{ active_count: 2, issuer_count: 1, recipient_count: 0 }] }, { counts: [{ active_count: 3, issuer_count: 1, recipient_count: 1 }] },
    { couple: [{ status: 'closed', membership_epoch: 2 }] }]) {
    const f = fixture({ ...replayRows(), ...overrides }); expect((await f.handler(request())).status).toBe(409); expect(mutations(f)).toHaveLength(0);
  }
});

it('uses lock-time invitation expiry and never extends it from a stale application clock', async () => {
  for (const marker of ['FROM better_auth_identities', 'FROM couples', 'FROM pair_invites']) {
    const f = fixture({ invite: [row({ expires_at: new Date(+now + 500).toISOString() })] });
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, params) => {
      const result = await original(sql, params);
      if (sql.includes(marker) && /FOR SHARE|FOR UPDATE/.test(sql)) f.rows.clock = [{ now: new Date(+now + 500).toISOString() }];
      return result;
    });
    expect((await f.handler(request())).status).toBe(409); expect(mutations(f)).toHaveLength(0);
  }
});

it('redacts provider, SQL and uncertain commit errors with no automatic retry', async () => {
  const provider = fixture(); provider.read.mockRejectedValue(new Error('private provider details'));
  const sql = fixture(); sql.query.mockRejectedValue(new Error('private SQL'));
  const commit = fixture(); commit.transaction.mockRejectedValue(new Error('commit acknowledgement lost'));
  for (const f of [provider, sql, commit]) {
    const response = await f.handler(request()); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' }); expect(f.transaction.mock.calls.length).toBeLessThanOrEqual(1);
  }
});

it('supports either UUID ordering without provider locks preceding the second domain lock', async () => {
  const f = fixture({ discover: [row({ issuer_user_id: id(9) })], invite: [row({ issuer_user_id: id(9) })] });
  // Preview exercises the reverse lexical ordering without mutation acknowledgement fixtures.
  expect((await f.handler(request(true))).status).toBe(200);
  expect(f.query.mock.calls.filter(([sql]) => sql.includes('FROM users')).map(([, p]) => p)).toEqual([[userId], [id(9)]]);
});
