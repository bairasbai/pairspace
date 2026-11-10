import { expect, it, vi } from 'vitest';
import type { Database, SqlExecutor } from '../src/contracts.ts';
import { createProfileProvisionHandler } from '../src/profile-provision.ts';

const origin = 'http://127.0.0.1:3123';
const userId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const sessionId = 'provider-session';
const now = new Date('2026-11-10T00:00:00Z');
const expires = new Date(+now + 60000);
const provider = () => ({ user: { id: 'provider-user', email: 'private@example.test' },
  session: { id: sessionId, userId: 'provider-user', expiresAt: expires, token: 'private-token' } });
const request = (body: string | Uint8Array<ArrayBuffer> | null = '{}', query = '', headers: Record<string, string> = {}) =>
  new Request(`${origin}/v1/profile${query}`, { method: 'POST', body,
    headers: { origin, cookie: 'synthetic-cookie', 'content-type': 'application/json', ...headers } });
type Rows = Partial<Record<'initial' | 'user' | 'provider' | 'session' | 'clock' | 'mapping' | 'insertUser' | 'insertMapping', unknown[]>>;
function fixture(overrides: Rows = {}, retryOverrides?: Rows) {
  const rows = { initial: [{ user_id: userId }], user: [{ deleted_at: null }], provider: [{ id: 'provider-user' }],
    session: [{ created_at: new Date(+now - 10000).toISOString(), expires_at: expires.toISOString() }],
    clock: [{ now: now.toISOString() }], mapping: [{ user_id: userId }],
    insertUser: [{ id: userId }], insertMapping: [{ user_id: userId }], ...overrides };
  let attempt = 0;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    void params;
    const current = attempt === 2 ? { ...rows, ...retryOverrides } : rows;
    return { rows: sql.includes('INSERT INTO users') ? current.insertUser
      : sql.includes('INSERT INTO better_auth_identities') ? current.insertMapping
        : sql.includes('FROM users') ? current.user : sql.includes('FROM "user"') ? current.provider
          : sql.includes('FROM "session"') ? current.session : sql.includes('clock_timestamp') ? current.clock
            : sql.includes('FOR SHARE') ? current.mapping : current.initial };
  });
  const tx: SqlExecutor = { query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await query(sql, params)).rows as T[] }) };
  const transaction = vi.fn(async <T>(work: (tx: SqlExecutor) => Promise<T>) => { attempt++; return work(tx); });
  const db: Database = { now: () => now, transaction: async <T>(work: (tx: SqlExecutor) => Promise<T>) => await transaction(work) as T };
  const read = vi.fn(async (): Promise<unknown> => provider());
  const handler = createProfileProvisionHandler(db, { getSession: read, trustedOrigins: [origin, 'pairspace://'] });
  return { handler, read, query, transaction, rows };
}

it('creates only a DB-random user and verified identity atomically and returns the minimal 201 acknowledgement', async () => {
  const f = fixture({ initial: [], mapping: [] });
  const response = await f.handler(request());
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await response.json()).toEqual({ ok: true, value: { sessionId, userId, created: true } });
  expect(f.transaction).toHaveBeenCalledOnce();
  expect(f.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim())).toEqual([
    'SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1',
    'SELECT id FROM "user" WHERE id=$1 FOR UPDATE',
    'SELECT "createdAt"::text AS created_at, "expiresAt"::text AS expires_at FROM "session" WHERE id=$1 AND "userId"=$2 FOR SHARE',
    'SELECT clock_timestamp()::text AS now',
    'SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1 FOR SHARE',
    'SELECT id FROM "user" WHERE id=$1 FOR SHARE',
    'SELECT "createdAt"::text AS created_at, "expiresAt"::text AS expires_at FROM "session" WHERE id=$1 AND "userId"=$2 FOR SHARE',
    'SELECT clock_timestamp()::text AS now',
    'INSERT INTO users(id) VALUES(gen_random_uuid()) RETURNING id',
    'INSERT INTO better_auth_identities(auth_user_id,user_id) VALUES($1,$2) RETURNING user_id',
  ]);
  expect(f.query.mock.calls.at(-1)?.[1]).toEqual(['provider-user', userId]);
  expect(f.query.mock.calls.some(([sql]) => /UPDATE |DELETE |couples|couple_members|chat_messages|outbox_events|ON CONFLICT/.test(sql))).toBe(false);
});

it('returns the existing live profile on retries, preserving domain → provider → session → mapping order', async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.handler(request(' { } ', '', { 'content-type': 'application/json; charset=utf-8' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, value: { sessionId, userId, created: false } });
  }
  expect(f.transaction).toHaveBeenCalledTimes(2);
  expect(f.query.mock.calls[1][0]).toContain('FROM users WHERE id=$1 FOR SHARE');
  expect(f.query.mock.calls[2][0]).toContain('FROM "user" WHERE id=$1 FOR UPDATE');
  expect(f.query.mock.calls.some(([sql]) => /INSERT|UPDATE users|DELETE/.test(sql))).toBe(false);
});

it('restarts a read-only transaction when another session creates a mapping during the provider lock wait', async () => {
  const f = fixture({ initial: [] }, { initial: [{ user_id: userId }] });
  const response = await f.handler(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, value: { sessionId, userId, created: false } });
  expect(f.transaction).toHaveBeenCalledTimes(2);
  expect(f.query.mock.calls[5][0]).not.toContain('FOR SHARE');
  expect(f.query.mock.calls[6][0]).toContain('FROM users');
  expect(f.query.mock.calls[7][0]).toContain('FOR UPDATE');
  expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
});

it('never follows mappings that disappear/change on retry and never resurrects missing/deleted users', async () => {
  for (const retry of [{ initial: [] }, { initial: [{ user_id: otherId }] },
    { initial: [{ user_id: userId }], user: [] },
    { initial: [{ user_id: userId }], user: [{ deleted_at: now.toISOString() }] },
    { initial: [{ user_id: userId }], mapping: [] }]) {
    const f = fixture({ initial: [] }, retry);
    const response = await f.handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'profile_unavailable' });
    expect(f.transaction).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  }
  for (const overrides of [{ user: [] }, { user: [{ deleted_at: now.toISOString() }] }, { user: [{}, {}] },
    { mapping: [] }, { mapping: [{ user_id: otherId }] }]) {
    const f = fixture(overrides);
    expect((await f.handler(request())).status).toBe(409);
    expect(f.transaction).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  }
});

it('accepts only POST application/json empty objects and rejects every caller identity selector', async () => {
  const f = fixture();
  for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const result = await f.handler(new Request(`${origin}/v1/profile`, { method }));
    expect(result.status).toBe(405); expect(result.headers.get('allow')).toBe('POST');
  }
  expect((await f.handler(new Request(`${origin}/v1/profile/other`))).status).toBe(404);
  for (const query of ['?userId=' + otherId, '?sessionId=spoof', '?authUserId=spoof', '?coupleId=' + otherId, '?unknown=1']) {
    expect((await f.handler(request('{}', query))).status).toBe(400);
  }
  for (const body of [null, '', '{', '[]', 'null', 'true', '1', '""', '{"userId":"spoof"}',
    '{"sessionId":"spoof"}', '{"authUserId":"spoof"}', '{"coupleId":"spoof"}', '{"created":true}',
    '{"__proto__":{}}', '{"a":1,"a":2}', new Uint8Array([0xff])]) {
    expect((await f.handler(request(body))).status).toBe(400);
  }
  for (const type of ['', 'text/plain', 'application/x-www-form-urlencoded']) {
    expect((await f.handler(request('{}', '', { 'content-type': type }))).status).toBe(415);
  }
  const absentType = request(); absentType.headers.delete('content-type');
  expect((await f.handler(absentType)).status).toBe(415);
  expect(f.read).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
});

it('requires a valid trusted cookie-only official session, with no bearer or body-identity fallback', async () => {
  const f = fixture();
  for (const headers of [{ cookie: '' }, { authorization: 'Bearer synthetic' }, { origin: 'https://attacker.invalid' }] as Record<string, string>[]) {
    expect((await f.handler(request('{}', '', headers))).status).toBe(401);
  }
  expect(f.read).not.toHaveBeenCalled();
  f.read.mockResolvedValueOnce(null);
  expect((await f.handler(request())).status).toBe(401);
  expect(f.transaction).not.toHaveBeenCalled();
  const expo = request('{}', '', { 'expo-origin': 'pairspace://' }); expo.headers.delete('origin');
  expect((await f.handler(expo)).status).toBe(200);
});

it('rechecks provider existence, matching session, ownership, creation and expiry before writes', async () => {
  for (const overrides of [{ provider: [] }, { provider: [{ id: 'different' }] }, { session: [] },
    { session: [{ created_at: expires.toISOString(), expires_at: expires.toISOString() }] },
    { session: [{ created_at: now.toISOString(), expires_at: now.toISOString() }] }]) {
    const f = fixture({ initial: [], mapping: [], ...overrides });
    const response = await f.handler(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  }
  const f = fixture();
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, params) => {
    const result = await original(sql, params);
    if (sql.includes('FROM better_auth_identities') && sql.includes('FOR SHARE')) {
      f.rows.clock = [{ now: expires.toISOString() }];
    }
    return result;
  });
  expect((await f.handler(request())).status).toBe(401);
});

it('rejects malformed data and throws after invalid INSERT results so a real transaction must roll back', async () => {
  for (const overrides of [{ initial: [{ user_id: 'invalid' }] }, { initial: [{ user_id: userId }, { user_id: otherId }] },
    { mapping: [{ user_id: null }] }, { clock: [] }, { clock: [{ now: 'invalid' }] },
    { insertUser: [] }, { insertUser: [{ id: 'invalid' }] }, { insertMapping: [] },
    { insertMapping: [{ user_id: otherId }] }, { insertMapping: [{ user_id: null }] }]) {
    const f = fixture({ initial: [], mapping: [], ...overrides });
    const response = await f.handler(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
  }
});

it('redacts provider/database errors and never retries uncertain transaction failures', async () => {
  const reader = fixture(); reader.read.mockRejectedValue(new Error('private provider token'));
  const sql = fixture(); sql.query.mockRejectedValue(new Error('private SQL details'));
  const uncertain = fixture(); uncertain.transaction.mockRejectedValue(new Error('commit acknowledgement lost'));
  for (const f of [reader, sql, uncertain]) {
    const response = await f.handler(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
    expect(f.transaction.mock.calls.length).toBeLessThanOrEqual(1);
  }
});
