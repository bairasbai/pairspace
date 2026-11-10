import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { InvitationMetadata } from '../src/pair-invitation-state.ts';
import { commandId, coupleId, expires, fixture, id, inviteId, mutations, now, origin, request, row, userId } from './pair-invitation-fixture.ts';

it('issues a cryptographic one-time token, persists only hash, and uses fresh locked time for exact ten-minute TTL', async () => {
  const f = fixture();
  const result = await f.handler(request('POST', JSON.stringify({ commandId: commandId.toUpperCase() })));
  expect(result.status).toBe(201);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(result.headers.get('x-content-type-options')).toBe('nosniff');
  const body = await result.json() as { ok: boolean; value: { token: string } };
  const { token, ...publicValue } = body.value;
  expect(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
  expect(JSON.stringify(publicValue).includes(token)).toBe(false);
  expect({ ok: body.ok, value: publicValue }).toEqual({ ok: true, value: { state: 'issued', invitation: {
    id: inviteId, commandId, status: 'pending', createdAt: now.toISOString(), expiresAt: new Date(+now + 600000).toISOString(),
    revokedAt: null, consumedAt: null } } });
  expect(JSON.stringify(f.query.mock.calls).includes(token)).toBe(false);
  expect(mutations(f)).toHaveLength(1);
  expect(mutations(f)[0][1]).toEqual([coupleId, userId, commandId,
    createHash('sha256').update(token).digest('hex'), now.toISOString(), new Date(+now + 600000).toISOString()]);
  const sql = f.query.mock.calls.map(([s]) => s.replace(/\s+/g, ' ').trim());
  expect(sql[0]).toContain('better_auth_identities'); expect(sql[1]).toContain('FROM users WHERE id=$1 FOR UPDATE');
  expect(sql[2]).toContain('FROM "user"'); expect(sql[3]).toContain('FROM "session"');
  expect(sql[5]).toContain('better_auth_identities'); expect(sql[5]).toContain('FOR SHARE');
  expect(sql.findIndex(s => s.includes('FROM couples'))).toBeLessThan(sql.findIndex(s => s.includes('FROM pair_invites')));
  expect(sql.at(-2)).toBe('SELECT clock_timestamp()::text AS now');
  expect(sql.join('\n')).not.toMatch(/ON CONFLICT|UPDATE couples|INSERT INTO users|chat_messages|outbox_events/);
  const second = await fixture().handler(request());
  expect((await second.json() as { value: { token: string } }).value.token === token).toBe(false);
});

it('reads own current metadata or null and never returns token, hash, user or pair IDs', async () => {
  for (const current of [[], [row()], [row({ expires_at: now.toISOString(), created_at: new Date(+now - 600000).toISOString() })]]) {
    const f = fixture({ current }); const response = await f.handler(request('GET'));
    expect(response.status).toBe(200); const body = await response.json() as { value: { state: string; invitation: InvitationMetadata | null } };
    expect(body.value.state).toBe('current');
    expect(body.value.invitation?.status ?? null).toBe(!current.length ? null : current[0].created_at === now.toISOString() ? 'pending' : 'expired');
    expect(/token|hash|userId|coupleId|sessionId/.test(JSON.stringify(body))).toBe(false);
    expect(mutations(f)).toHaveLength(0);
  }
});

it('replays the original command without token or any mutation, even when expired, revoked or consumed', async () => {
  const earlier = new Date(+now - 600000).toISOString();
  for (const target of [row(), row({ created_at: earlier, expires_at: now.toISOString() }),
    row({ revoked_at: now.toISOString() }), row({ consumed_at: now.toISOString() })]) {
    const f = fixture({ target: [target] }); const response = await f.handler(request());
    expect(response.status).toBe(200); const value = (await response.json() as { value: { state: string; token: null; invitation: InvitationMetadata } }).value;
    expect(value.state).toBe('replayed'); expect(value.token === null).toBe(true); expect(value.invitation.id).toBe(inviteId);
    expect(mutations(f)).toHaveLength(0);
  }
});

it('conflicts on a different live command, and atomically revokes an expired current invite before new insertion', async () => {
  const live = fixture({ current: [row({ command_id: id(31) })] });
  const conflict = await live.handler(request()); expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ ok: false, error: 'invitation_exists' }); expect(mutations(live)).toHaveLength(0);
  const expired = fixture({ current: [row({ command_id: id(31), created_at: new Date(+now - 600000).toISOString(), expires_at: now.toISOString() })] });
  expect((await expired.handler(request())).status).toBe(201);
  expect(mutations(expired).map(([sql]) => sql.trim().split(' ')[0])).toEqual(['UPDATE', 'INSERT']);
  expect(mutations(expired)[0][1]).toEqual([coupleId, inviteId, now.toISOString()]);
});

it('revokes only the expected own invite; repeat of historical revoked ID never affects replacement', async () => {
  for (const current of [row(), row({ created_at: new Date(+now - 600000).toISOString(), expires_at: now.toISOString() })]) {
    const f = fixture({ current: [current], target: [current] });
    const response = await f.handler(request('DELETE', JSON.stringify({ inviteId })));
    expect(await response.json()).toEqual({ ok: true, value: { state: 'revoked', revoked: true } });
    expect(mutations(f)).toHaveLength(1); expect(mutations(f)[0][1]).toEqual([coupleId, inviteId, now.toISOString()]);
  }
  const repeat = fixture({ current: [row({ id: id(21), command_id: id(31) })], target: [row({ revoked_at: now.toISOString() })] });
  expect(await (await repeat.handler(request('DELETE', JSON.stringify({ inviteId })))).json())
    .toEqual({ ok: true, value: { state: 'revoked', revoked: false } });
  expect(mutations(repeat)).toHaveLength(0);
  for (const target of [[], [row({ consumed_at: now.toISOString() })]]) {
    const f = fixture({ target }); const response = await f.handler(request('DELETE', JSON.stringify({ inviteId })));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ ok: false, error: 'invitation_unavailable' });
    expect(mutations(f)).toHaveLength(0);
  }
});

it('requires existing own valid waiting slot and live profile without provisioning, activation or selector overrides', async () => {
  for (const overrides of [{ initial: [] }, { user: [] }, { user: [{}, {}] },
    { user: [{ deleted_at: now.toISOString() }] }, { mapping: [] }, { mapping: [{ user_id: id(99) }] }]) {
    const f = fixture(overrides); const response = await f.handler(request());
    expect(response.status).toBe(409); expect((await response.json() as { error: string }).error).toBe('profile_unavailable'); expect(mutations(f)).toHaveLength(0);
  }
  for (const overrides of [{ membership: [] }, { currentMembership: [] }, { currentMembership: [{ couple_id: id(99) }] },
    { couple: [{ status: 'active', membership_epoch: 1 }] }, { couple: [{ status: 'closed', membership_epoch: 2 }] },
    { members: [{ active_count: 2, own_count: 1 }] }, { members: [{ active_count: 1, own_count: 0 }] }]) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const f = fixture({ target: [row()], ...overrides }); const response = await f.handler(request(method, JSON.stringify(method === 'DELETE' ? { inviteId } : { commandId })));
      expect(response.status).toBe(409); expect((await response.json() as { error: string }).error).toBe('space_unavailable'); expect(mutations(f)).toHaveLength(0);
    }
  }
});

it('strictly validates route, method, queries, JSON shape/media and GET body declarations before session reads', async () => {
  const f = fixture();
  for (const method of ['HEAD', 'PUT', 'PATCH', 'OPTIONS']) {
    const result = await f.handler(request(method)); expect(result.status).toBe(405); expect(result.headers.get('allow')).toBe('GET, POST, DELETE');
  }
  expect((await f.handler(new Request(origin + '/elsewhere'))).status).toBe(404);
  for (const method of ['GET', 'POST', 'DELETE']) {
    expect((await f.handler(request(method, '{}', '?coupleId=' + id(99)))).status).toBe(400);
  }
  for (const method of ['POST', 'DELETE']) {
    for (const body of [null, '', '{', '[]', 'null', '1', 'true', '""', '{}', '{"userId":"spoof"}', '{"commandId":1}',
      JSON.stringify({ commandId, coupleId }), JSON.stringify(method === 'POST' ? { inviteId } : { commandId }), new Uint8Array([0xff])]) {
      expect((await f.handler(request(method, body))).status).toBe(400);
    }
    for (const type of ['', 'text/plain']) expect((await f.handler(request(method, '{}', '', { 'content-type': type }))).status).toBe(415);
    const absentType = request(method); absentType.headers.delete('content-type'); expect((await f.handler(absentType)).status).toBe(415);
  }
  expect((await f.handler(request('GET', null, '', { 'content-length': '2' }))).status).toBe(400);
  expect((await f.handler(request('GET', null, '', { 'transfer-encoding': 'chunked' }))).status).toBe(400);
  const withBody = request('GET'); Object.defineProperty(withBody, 'body', { value: new ReadableStream() });
  expect((await f.handler(withBody)).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
});

it('requires trusted cookie transport and authoritative session, with no fallback, including after each contended lock', async () => {
  const f = fixture();
  for (const headers of [{ cookie: '' }, { authorization: 'Bearer synthetic' }, { origin: 'https://other.invalid' }] as Record<string, string>[]) {
    expect((await f.handler(request('POST', JSON.stringify({ commandId }), '', headers))).status).toBe(401);
  }
  expect(f.read).not.toHaveBeenCalled(); f.read.mockResolvedValueOnce(null); expect((await f.handler(request())).status).toBe(401);
  const expo = request('POST', JSON.stringify({ commandId }), '', { 'expo-origin': 'pairspace://' }); expo.headers.delete('origin');
  expect((await f.handler(expo)).status).toBe(201);
  for (const overrides of [{ provider: [] }, { session: [] }, { session: [{ created_at: expires.toISOString(), expires_at: expires.toISOString() }] }]) {
    const invalid = fixture(overrides); expect((await invalid.handler(request())).status).toBe(401); expect(mutations(invalid)).toHaveLength(0);
  }
  for (const marker of ['FROM better_auth_identities', 'FROM couples', 'FROM pair_invites']) {
    const blocked = fixture(); const original = blocked.query.getMockImplementation()!;
    blocked.query.mockImplementation(async (sql, params) => {
      const result = await original(sql, params);
      if (sql.includes(marker) && (sql.includes('FOR SHARE') || sql.includes('FOR UPDATE'))) blocked.rows.clock = [{ now: expires.toISOString() }];
      return result;
    });
    expect((await blocked.handler(request())).status).toBe(401); expect(mutations(blocked)).toHaveLength(0);
  }
});

it('redacts thrown and uncertain errors without retrying or recovering the raw token', async () => {
  const provider = fixture(); provider.read.mockRejectedValue(new Error('private cookie'));
  const sql = fixture(); sql.query.mockRejectedValue(new Error('private token hash'));
  const commit = fixture(); commit.transaction.mockRejectedValue(new Error('commit acknowledgement lost'));
  for (const f of [provider, sql, commit]) {
    const response = await f.handler(request()); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
    expect(f.transaction.mock.calls.length).toBeLessThanOrEqual(1);
  }
});
