import { expect, it, vi } from 'vitest';
import type { Database, SqlExecutor } from '../src/contracts.ts';
import { createWaitingSpaceHandler } from '../src/waiting-space.ts';

const origin = 'http://127.0.0.1:3123';
const userId = '00000000-0000-4000-8000-000000000001';
const coupleId = '00000000-0000-4000-8000-000000000010';
const otherId = '00000000-0000-4000-8000-000000000002';
const sessionId = 'provider-session';
const now = new Date('2026-11-10T00:00:00Z');
const expires = new Date(+now + 60000);
const provider = () => ({ user: { id: 'provider-user', email: 'private@example.test' },
  session: { id: sessionId, userId: 'provider-user', expiresAt: expires, token: 'private-token' } });
const request = (body: string | Uint8Array<ArrayBuffer> | null = '{}', query = '', headers: Record<string, string> = {}) =>
  new Request(`${origin}/v1/spaces/waiting${query}`, { method: 'POST', body,
    headers: { origin, cookie: 'synthetic-cookie', 'content-type': 'application/json', ...headers } });
type Rows = Partial<Record<'initial' | 'user' | 'provider' | 'session' | 'clock' | 'mapping' | 'membership'
  | 'current' | 'couple' | 'members' | 'insertCouple' | 'insertMember', unknown[]>>;
function fixture(overrides: Rows = {}) {
  const rows = { initial: [{ user_id: userId }], user: [{ deleted_at: null }], provider: [{ id: 'provider-user' }],
    session: [{ created_at: new Date(+now - 10000).toISOString(), expires_at: expires.toISOString() }],
    clock: [{ now: now.toISOString() }], mapping: [{ user_id: userId }], membership: [], current: [{ couple_id: coupleId }],
    couple: [{ status: 'waiting_partner', membership_epoch: 1 }], members: [{ active_count: 1, own_count: 1 }],
    insertCouple: [{ id: coupleId }], insertMember: [{ couple_id: coupleId }], ...overrides };
  let memberReads = 0;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    void params;
    return { rows: sql.includes('INSERT INTO couples') ? rows.insertCouple
      : sql.includes('INSERT INTO couple_members') ? rows.insertMember
        : sql.includes('FROM users') ? rows.user : sql.includes('FROM "user"') ? rows.provider
          : sql.includes('FROM "session"') ? rows.session : sql.includes('clock_timestamp') ? rows.clock
            : sql.includes('FROM better_auth_identities') ? (sql.includes('FOR SHARE') ? rows.mapping : rows.initial)
              : sql.includes('count(*)') ? rows.members : sql.includes('FROM couple_members')
                ? (memberReads++ === 0 ? rows.membership : rows.current) : rows.couple };
  });
  const tx: SqlExecutor = { query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await query(sql, params)).rows as T[] }) };
  const transaction = vi.fn(async <T>(work: (tx: SqlExecutor) => Promise<T>) => work(tx));
  const db: Database = { now: () => now, transaction: async <T>(work: (tx: SqlExecutor) => Promise<T>) => await transaction(work) as T };
  const read = vi.fn(async (): Promise<unknown> => provider());
  const handler = createWaitingSpaceHandler(db, { getSession: read, trustedOrigins: [origin, 'pairspace://'] });
  return { handler, read, query, transaction, rows };
}
const inserts = (f: ReturnType<typeof fixture>) => f.query.mock.calls.filter(([sql]) => sql.includes('INSERT'));

it('atomically inserts one DB-random waiting couple and own live slot, with minimal acknowledgement', async () => {
  const f = fixture();
  const response = await f.handler(request(' { } ', '', { 'content-type': 'application/json; charset=utf-8' }));
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await response.json()).toEqual({ ok: true, value: { sessionId, userId, coupleId, membershipEpoch: 1, created: true } });
  expect(f.transaction).toHaveBeenCalledOnce();
  const sql = f.query.mock.calls.map(([value]) => value.replace(/\s+/g, ' ').trim());
  expect(sql.slice(0, 6)).toEqual([
    'SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1',
    'SELECT deleted_at FROM users WHERE id=$1 FOR UPDATE',
    'SELECT id FROM "user" WHERE id=$1 FOR SHARE',
    'SELECT "createdAt"::text AS created_at, "expiresAt"::text AS expires_at FROM "session" WHERE id=$1 AND "userId"=$2 FOR SHARE',
    'SELECT clock_timestamp()::text AS now',
    'SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1 FOR SHARE',
  ]);
  expect(inserts(f).map(([value]) => value.replace(/\s+/g, ' ').trim())).toEqual([
    "INSERT INTO couples(id,status,membership_epoch) VALUES(gen_random_uuid(),'waiting_partner',1) RETURNING id",
    "INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,1,'active') RETURNING couple_id",
  ]);
  expect(inserts(f)[1][1]).toEqual([coupleId, userId]);
  expect(sql.join('\n')).not.toMatch(/UPDATE couples|DELETE|ON CONFLICT|INSERT INTO users|chat_messages|outbox_events/);
});

it('returns an existing own single-slot waiting space without creating, changing or activating anything', async () => {
  const f = fixture({ membership: [{ couple_id: coupleId }], couple: [{ status: 'waiting_partner', membership_epoch: 4 }] });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.handler(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true, value: { sessionId, userId, coupleId, membershipEpoch: 4, created: false } });
  }
  expect(inserts(f)).toHaveLength(0);
  expect(f.query.mock.calls.find(([sql]) => sql.includes('FROM couples'))?.[0]).toContain('FOR UPDATE');
  expect(f.query.mock.calls.find(([sql]) => sql.includes('count(*)'))?.[1]).toEqual([coupleId, userId]);
});

it('never bypasses an active pair, a closed live membership or inconsistent waiting space', async () => {
  for (const overrides of [{ couple: [{ status: 'active', membership_epoch: 1 }] },
    { couple: [{ status: 'closed', membership_epoch: 2 }] }, { current: [] }, { current: [{ couple_id: otherId }] },
    { members: [{ active_count: 0, own_count: 0 }] }, { members: [{ active_count: 1, own_count: 0 }] },
    { members: [{ active_count: 2, own_count: 1 }] }]) {
    const f = fixture({ membership: [{ couple_id: coupleId }], ...overrides });
    const result = await f.handler(request());
    expect(result.status).toBe(409); expect(await result.json()).toEqual({ ok: false, error: 'space_unavailable' });
    expect(inserts(f)).toHaveLength(0);
  }
});

it('requires an existing live mapped profile and never follows a changed mapping', async () => {
  for (const overrides of [{ initial: [] }, { user: [] }, { user: [{}, {}] },
    { user: [{ deleted_at: now.toISOString() }] }, { mapping: [] }, { mapping: [{ user_id: otherId }] }]) {
    const f = fixture(overrides); const result = await f.handler(request());
    expect(result.status).toBe(409); expect(await result.json()).toEqual({ ok: false, error: 'profile_unavailable' });
    expect(inserts(f)).toHaveLength(0);
  }
});

it('accepts only POST JSON empty objects with no caller identity or membership selectors', async () => {
  const f = fixture();
  for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const result = await f.handler(new Request(`${origin}/v1/spaces/waiting`, { method }));
    expect(result.status).toBe(405); expect(result.headers.get('allow')).toBe('POST');
  }
  expect((await f.handler(new Request(`${origin}/v1/spaces/waiting/other`))).status).toBe(404);
  for (const query of ['?userId=' + otherId, '?sessionId=spoof', '?authUserId=spoof', '?coupleId=' + otherId, '?membershipEpoch=1']) {
    expect((await f.handler(request('{}', query))).status).toBe(400);
  }
  for (const body of [null, '', '{', '[]', 'null', 'true', '1', '""', '{"userId":"spoof"}',
    '{"sessionId":"spoof"}', '{"authUserId":"spoof"}', '{"coupleId":"spoof"}', '{"created":true}',
    '{"slot":1}', '{"membershipEpoch":1}', '{"__proto__":{}}', new Uint8Array([0xff])]) {
    expect((await f.handler(request(body))).status).toBe(400);
  }
  for (const type of ['', 'text/plain', 'application/x-www-form-urlencoded']) {
    expect((await f.handler(request('{}', '', { 'content-type': type }))).status).toBe(415);
  }
  const absentType = request(); absentType.headers.delete('content-type');
  expect((await f.handler(absentType)).status).toBe(415);
  expect(f.read).not.toHaveBeenCalled(); expect(f.transaction).not.toHaveBeenCalled();
});

it('requires a trusted official cookie session with no fallback and supports Expo-origin', async () => {
  const f = fixture();
  for (const headers of [{ cookie: '' }, { authorization: 'Bearer synthetic' }, { origin: 'https://attacker.invalid' }] as Record<string, string>[]) {
    expect((await f.handler(request('{}', '', headers))).status).toBe(401);
  }
  expect(f.read).not.toHaveBeenCalled();
  f.read.mockResolvedValueOnce(null);
  expect((await f.handler(request())).status).toBe(401);
  expect(f.transaction).not.toHaveBeenCalled();
  const expo = request('{}', '', { 'expo-origin': 'pairspace://' }); expo.headers.delete('origin');
  expect((await f.handler(expo)).status).toBe(201);
});

it('rechecks authoritative session revocation and expiry before creation and after mapping/couple locks', async () => {
  for (const overrides of [{ provider: [] }, { session: [] },
    { session: [{ created_at: expires.toISOString(), expires_at: expires.toISOString() }] },
    { session: [{ created_at: now.toISOString(), expires_at: now.toISOString() }] }]) {
    const f = fixture(overrides); const result = await f.handler(request());
    expect(result.status).toBe(401); expect(inserts(f)).toHaveLength(0);
  }
  for (const after of ['mapping', 'membership', 'couple']) {
    const f = fixture(after === 'couple' ? { membership: [{ couple_id: coupleId }] } : {});
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, params) => {
      const result = await original(sql, params);
      if (after === 'mapping' && sql.includes('FROM better_auth_identities') && sql.includes('FOR SHARE')
        || after === 'membership' && sql.includes('FROM couple_members') || after === 'couple' && sql.includes('FROM couples')) {
        f.rows.clock = [{ now: expires.toISOString() }];
      }
      return result;
    });
    expect((await f.handler(request())).status).toBe(401); expect(inserts(f)).toHaveLength(0);
  }
});

it('rejects invalid database rows and throws on malformed insert results so the whole transaction rolls back', async () => {
  for (const overrides of [{ initial: [{ user_id: 'bad' }] }, { initial: [{ user_id: userId }, { user_id: otherId }] },
    { mapping: [{ user_id: null }] }, { clock: [] }, { insertCouple: [] }, { insertCouple: [{ id: 'invalid' }] },
    { insertMember: [] }, { insertMember: [{ couple_id: otherId }] }]) {
    const f = fixture(overrides); const result = await f.handler(request());
    expect(result.status).toBe(503); expect(await result.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
  }
  for (const overrides of [{ membership: [{ couple_id: 'bad' }] }, { current: [{ couple_id: 'bad' }] },
    { couple: [] }, { couple: [{ status: 'unknown', membership_epoch: 1 }] },
    { couple: [{ status: 'waiting_partner', membership_epoch: 0 }] },
    { members: [] }, { members: [{ active_count: '1', own_count: 1 }] }, { members: [{ active_count: -1, own_count: 0 }] },
    { members: [{ active_count: 1, own_count: '1' }] }, { members: [{ active_count: 1, own_count: -1 }] },
    { members: [{ active_count: 1, own_count: 2 }] }]) {
    const f = fixture({ membership: [{ couple_id: coupleId }], ...overrides });
    expect((await f.handler(request())).status).toBe(503); expect(inserts(f)).toHaveLength(0);
  }
});

it('redacts provider/database errors and does not automatically retry uncertain transactions', async () => {
  const reader = fixture(); reader.read.mockRejectedValue(new Error('private provider token'));
  const sql = fixture(); sql.query.mockRejectedValue(new Error('private SQL details'));
  const uncertain = fixture(); uncertain.transaction.mockRejectedValue(new Error('commit acknowledgement lost'));
  for (const f of [reader, sql, uncertain]) {
    const response = await f.handler(request());
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
    expect(f.transaction.mock.calls.length).toBeLessThanOrEqual(1);
  }
});
