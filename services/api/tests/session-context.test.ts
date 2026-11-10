import { expect, it, vi } from 'vitest';
import type { Database, SqlExecutor } from '../src/contracts.ts';
import { createSessionContextHandler } from '../src/session-context.ts';

const origin = 'https://fixture.invalid';
const userId = '00000000-0000-4000-8000-000000000001';
const coupleId = '00000000-0000-4000-8000-000000000010';
const otherId = '00000000-0000-4000-8000-000000000002';
const sessionId = 'provider-session';
const now = new Date('2026-11-10T00:00:00Z');
const expires = new Date(+now + 60000);
const provider = () => ({ user: { id: 'provider-user', email: 'private@example.test', name: 'Private' },
  session: { id: sessionId, userId: 'provider-user', expiresAt: expires, token: 'never-return-this' } });
const request = (query = '', headers: Record<string, string> = { origin, cookie: 'synthetic-cookie' }) =>
  new Request(`${origin}/v1/session/context${query}`, { headers });
type Rows = Partial<Record<'initial' | 'user' | 'provider' | 'session' | 'clock' | 'mapping' | 'membership' | 'current' | 'couple', unknown[]>>;
function fixture(overrides: Rows = {}) {
  const rows = {
    initial: [{ user_id: userId }], user: [{ deleted_at: null }], provider: [{ id: 'provider-user' }],
    session: [{ created_at: new Date(+now - 10000).toISOString(), expires_at: expires.toISOString() }],
    clock: [{ now: now.toISOString() }], mapping: [{ user_id: userId }],
    membership: [{ couple_id: coupleId }], current: [{ couple_id: coupleId }],
    couple: [{ status: 'active', membership_epoch: 3 }], ...overrides,
  };
  let memberReads = 0;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    void params;
    return { rows: sql.includes('FROM users') ? rows.user : sql.includes('FROM "user"') ? rows.provider
      : sql.includes('FROM "session"') ? rows.session : sql.includes('clock_timestamp') ? rows.clock
        : sql.includes('FROM better_auth_identities') ? (sql.includes('FOR SHARE') ? rows.mapping : rows.initial)
          : sql.includes('FROM couple_members') ? (memberReads++ === 0 ? rows.membership : rows.current) : rows.couple };
  });
  const tx: SqlExecutor = { query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await query(sql, params)).rows as T[] }) };
  const transaction = vi.fn();
  const db: Database = { now: () => now, transaction: work => { transaction(); return work(tx); } };
  const read = vi.fn(async (): Promise<unknown> => provider());
  const handler = createSessionContextHandler(db, { getSession: read, trustedOrigins: [origin, 'pairspace://'] });
  return { handler, read, query, transaction, rows };
}

it('returns only the server-selected ready context after one transaction in chat-compatible lock order', async () => {
  const f = fixture();
  const result = await f.handler(request());
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(result.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await result.json()).toEqual({ ok: true, value: { state: 'ready', sessionId, userId, coupleId, membershipEpoch: 3 } });
  expect(f.transaction).toHaveBeenCalledOnce();
  expect(f.read).toHaveBeenCalledOnce();
  expect(f.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim())).toEqual([
    'SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1',
    'SELECT deleted_at FROM users WHERE id=$1 FOR SHARE',
    'SELECT id FROM "user" WHERE id=$1 FOR SHARE',
    'SELECT "createdAt"::text AS created_at, "expiresAt"::text AS expires_at FROM "session" WHERE id=$1 AND "userId"=$2 FOR SHARE',
    'SELECT clock_timestamp()::text AS now',
    'SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1 FOR SHARE',
    "SELECT couple_id FROM couple_members WHERE user_id=$1 AND status='active'",
    'SELECT status, membership_epoch FROM couples WHERE id=$1 FOR SHARE',
    "SELECT couple_id FROM couple_members WHERE user_id=$1 AND status='active'",
  ]);
  expect(f.query.mock.calls[0][1]).toEqual(['provider-user']);
  expect(f.query.mock.calls[7][1]).toEqual([coupleId]);
});

it('allows valid unmapped sessions without creating users, pairs, mappings or exposing provider data', async () => {
  const f = fixture({ initial: [], mapping: [] });
  const result = await f.handler(request('', { 'expo-origin': 'pairspace://', cookie: 'synthetic', 'content-length': '0' }));
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ ok: true, value: { state: 'unmapped', sessionId } });
  const sql = f.query.mock.calls.map(([value]) => value).join('\n');
  expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|FROM users|FROM couples|FROM couple_members/);
  expect(sql).toContain('FROM "session"');
});

it('distinguishes no membership, waiting/closed pair and membership revoked while acquiring pair lock', async () => {
  for (const overrides of [{ membership: [] }, { couple: [{ status: 'closed', membership_epoch: 4 }] },
    { couple: [{ status: 'waiting_partner', membership_epoch: 1 }] }, { current: [] }]) {
    const f = fixture(overrides);
    const result = await f.handler(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true, value: { state: 'no_active_pair', sessionId, userId } });
  }
});

it('rejects every query selector, methods and body transport before provider verification', async () => {
  const f = fixture();
  for (const query of ['?userId=' + otherId, '?coupleId=' + otherId, '?membershipEpoch=1', '?unknown=1', '?a=1&a=2']) {
    expect((await f.handler(request(query))).status).toBe(400);
  }
  for (const headers of [{ 'content-length': '1' }, { 'content-length': 'abc' }, { 'transfer-encoding': 'chunked' }] as Record<string, string>[]) {
    expect((await f.handler(request('', { origin, cookie: 'synthetic', ...headers }))).status).toBe(400);
  }
  const body = request();
  Object.defineProperty(body, 'body', { value: new ReadableStream() });
  expect((await f.handler(body)).status).toBe(400);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const result = await f.handler(new Request(`${origin}/v1/session/context`, { method, headers: { origin } }));
    expect(result.status).toBe(405); expect(result.headers.get('allow')).toBe('GET');
  }
  expect((await f.handler(new Request(`${origin}/v1/session/context/other`))).status).toBe(404);
  expect(f.read).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
});

it('requires trusted cookie-only official verification and rejects provider absence or malformed output', async () => {
  const f = fixture();
  for (const headers of [{}, { origin }, { origin, cookie: 'x', authorization: 'Bearer x' },
    { origin: 'https://attacker.invalid', 'expo-origin': 'pairspace://', cookie: 'x' }]) {
    const result = await f.handler(request('', headers as Record<string, string>));
    expect(result.status).toBe(401); expect(await result.json()).toEqual({ ok: false, error: 'unauthenticated' });
  }
  expect(f.read).not.toHaveBeenCalled();
  for (const value of [null, [], { ...provider(), user: [] }, { ...provider(), session: [] },
    { ...provider(), session: { ...provider().session, userId: 'different' } }]) {
    f.read.mockResolvedValue(value);
    expect((await f.handler(request())).status).toBe(401);
  }
  expect(f.transaction).not.toHaveBeenCalled();
});

it('rechecks revocation/deletion, database session ownership, expiry and candidate mapping changes', async () => {
  for (const overrides of [
    { user: [] }, { user: [{ deleted_at: now.toISOString() }] }, { user: [{ deleted_at: null }, { deleted_at: null }] },
    { provider: [] }, { provider: [{ id: 'different' }] }, { provider: [{ id: 'provider-user' }, { id: 'provider-user' }] },
    { session: [] }, { session: [{}, {}] },
    { session: [{ created_at: now.toISOString(), expires_at: now.toISOString() }] },
    { session: [{ created_at: expires.toISOString(), expires_at: expires.toISOString() }] },
    { session: [{ created_at: 'invalid', expires_at: expires.toISOString() }] },
    { mapping: [] }, { mapping: [{ user_id: otherId }] }, { initial: [], mapping: [{ user_id: userId }] },
  ]) {
    const f = fixture(overrides);
    const result = await f.handler(request());
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ ok: false, error: 'unauthenticated' });
  }
});

it('fails closed on ambiguous or malformed database context and membership replacement during locking', async () => {
  for (const overrides of [
    { initial: [{ user_id: 'invalid' }] }, { initial: [{ user_id: userId }, { user_id: otherId }] },
    { mapping: [{ user_id: null }] }, { mapping: [{ user_id: userId }, { user_id: otherId }] },
    { membership: [{ couple_id: 'invalid' }] }, { membership: [{ couple_id: coupleId }, { couple_id: otherId }] },
    { current: [{ couple_id: otherId }] }, { current: [{ couple_id: coupleId }, { couple_id: otherId }] },
    { couple: [] }, { couple: [{ status: 'active', membership_epoch: 1 }, { status: 'active', membership_epoch: 2 }] },
    { couple: [{ status: 'unknown', membership_epoch: 1 }] }, { couple: [{ status: 'active', membership_epoch: '3' }] },
    { couple: [{ status: 'active', membership_epoch: 0 }] }, { couple: [{ status: 'active', membership_epoch: 2147483647 }] },
    { clock: [] }, { clock: [{ now: 'invalid' }] },
  ]) {
    const result = await fixture(overrides).handler(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
  }
});

it('refreshes pair and epoch from the database and never caches the prior snapshot', async () => {
  const f = fixture();
  expect(await (await f.handler(request())).json()).toMatchObject({ value: { membershipEpoch: 3 } });
  f.rows.couple = [{ status: 'active', membership_epoch: 4 }];
  expect(await (await f.handler(request())).json()).toMatchObject({ value: { membershipEpoch: 4 } });
  f.rows.current = [{ couple_id: otherId }];
  expect(await (await f.handler(request())).json()).toMatchObject({ value: { coupleId: otherId } });
  f.rows.current = [];
  expect(await (await f.handler(request())).json()).toMatchObject({ value: { state: 'no_active_pair' } });
});

it('redacts provider and transaction failures without returning partial context', async () => {
  const providerFailure = fixture();
  providerFailure.read.mockRejectedValue(new Error('private provider token details'));
  const databaseFailure = fixture();
  databaseFailure.query.mockRejectedValue(new Error('private SQL credentials'));
  for (const f of [providerFailure, databaseFailure]) {
    const result = await f.handler(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
  }
});
