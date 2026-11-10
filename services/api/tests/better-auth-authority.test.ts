import { expect, it, vi } from 'vitest';
import type { AuthorizedDatabase, Database, Principal, SqlExecutor } from '../src/contracts.ts';
import { bindSessionAuthority, type SessionAuthority } from '../src/auth-authority.ts';
import { createBetterAuthAuthority, type BetterAuthAuthorityOptions } from '../src/better-auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { activeSession, validPrincipal } from '../src/session.ts';
import { createChatHandler } from '../src/http.ts';

const userId = '00000000-0000-4000-8000-000000000001';
const now = new Date('2026-11-10T00:00:00Z');
const expires = new Date(+now + 60000);
const provider = () => ({ user: { id: 'provider-user' }, session: { id: 'provider-session', userId: 'provider-user', expiresAt: expires } });
const principal: Principal = { source: 'better-auth', userId, authUserId: 'provider-user', sessionId: 'provider-session', tokenExpiresAt: +expires / 1000 };
const synthetic: Principal = { source: 'synthetic-jwt', userId, sessionId: userId, tokenExpiresAt: +expires / 1000 };
const origin = 'https://fixture.invalid';
const request = (headers: Record<string, string> = { origin, cookie: 'synthetic-cookie' }) => new Request(origin, { headers });

function fixture(overrides: Partial<Record<'initial' | 'user' | 'provider' | 'session' | 'clock' | 'mapping', unknown[]>> = {}) {
  const rows = {
    initial: [{ user_id: userId }], user: [{ deleted_at: null }], provider: [{ id: 'provider-user' }],
    session: [{ created_at: new Date(+now - 10000).toISOString(), expires_at: expires.toISOString() }],
    clock: [{ now: now.toISOString() }], mapping: [{ user_id: userId }], ...overrides,
  };
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('JOIN users') ? rows.initial
    : sql.includes('FROM users') ? rows.user : sql.includes('FROM "user"') ? rows.provider
      : sql.includes('FROM "session"') ? rows.session : sql.includes('clock_timestamp') ? rows.clock : rows.mapping }));
  const tx: SqlExecutor = { query: async <T>(sql: string) => ({ rows: (await query(sql)).rows as T[] }) };
  const db: Database = { now: () => now, transaction: work => work(tx) };
  const read = vi.fn(async (): Promise<unknown> => provider());
  const authority = createBetterAuthAuthority(db, { getSession: read, trustedOrigins: [origin, 'pairspace://'] });
  return { db, tx, query, read, authority };
}

it('maps official reader identity and rechecks only authoritative provider SQL before access', async () => {
  const f = fixture();
  expect(await f.authority.authenticate(request())).toEqual(principal);
  expect(f.read.mock.calls).toHaveLength(1);
  expect(await activeSession(f.tx, bindSessionAuthority(f.db, f.authority), principal)).toBe(true);
  expect(f.query.mock.calls.map(([sql]) => sql).join('\n')).not.toContain('auth_sessions');
  expect(await f.authority.authenticate(request({ 'expo-origin': 'pairspace://', cookie: 'synthetic' }))).toEqual(principal);
  const bound = bindSessionAuthority(f.db, f.authority);
  expect(bound.now()).toEqual(now);
  expect(await bound.transaction(async () => 42)).toBe(42);
});

it('requires explicit trusted origin and cookie, and never interprets bearer fallback', async () => {
  const f = fixture();
  for (const headers of [{}, { origin }, { origin: 'https://attacker.invalid', cookie: 'x' },
    { origin, cookie: 'x'.repeat(8193) }, { origin, cookie: 'x', authorization: 'Bearer synthetic' },
    { origin: 'https://attacker.invalid', 'expo-origin': 'pairspace://', cookie: 'x' }]) {
    expect(await f.authority.authenticate(request(headers as Record<string, string>))).toBeNull();
  }
  expect(f.read).not.toHaveBeenCalled();
});

it('validates provider output, identity mapping, trusted clock and reader errors', async () => {
  const f = fixture();
  for (const value of [null, {}, { user: {}, session: {} }, { user: {}, session: null },
    { ...provider(), user: { id: '\nspoofed' } }, { ...provider(), user: { id: '' } },
    { ...provider(), session: { ...provider().session, id: ' ' } },
    { ...provider(), session: { ...provider().session, userId: 'other' } },
    { ...provider(), session: { ...provider().session, expiresAt: 'not-a-Date' } },
    { ...provider(), session: { ...provider().session, expiresAt: new Date(NaN) } },
    { ...provider(), session: { ...provider().session, expiresAt: now } }]) {
    f.read.mockResolvedValue(value);
    expect(await f.authority.authenticate(request())).toBeNull();
  }
  for (const initial of [[], [{ user_id: 'invalid' }], [{ user_id: userId }, { user_id: userId }]]) {
    expect(await fixture({ initial }).authority.authenticate(request())).toBeNull();
  }
  const brokenClock = createBetterAuthAuthority({ ...f.db, now: () => new Date(NaN) }, { getSession: async () => provider(), trustedOrigins: [origin] });
  await expect(brokenClock.authenticate(request())).rejects.toThrow('invalid_server_clock');
  f.read.mockRejectedValue(new Error('synthetic_provider_failure'));
  await expect(f.authority.authenticate(request())).rejects.toThrow('synthetic_provider_failure');
});

it('fails transactional validation on deletion, missing owner/session/mapping, expiry and invalid clock', async () => {
  for (const overrides of [{ user: [] }, { user: [{ deleted_at: now.toISOString() }] }, { provider: [] }, { session: [] }, { mapping: [] },
    { session: [{ created_at: now.toISOString(), expires_at: now.toISOString() }] },
    { session: [{ created_at: expires.toISOString(), expires_at: expires.toISOString() }] },
    { session: [{ created_at: 'invalid', expires_at: expires.toISOString() }] }]) {
    const f = fixture(overrides);
    expect(await f.authority.recheck(f.tx, f.db, principal)).toBe(false);
  }
  const f = fixture();
  expect(await f.authority.recheck(f.tx, f.db, { ...principal, tokenExpiresAt: +now / 1000 })).toBe(false);
  expect(await f.authority.recheck(f.tx, f.db, synthetic)).toBe(false);
  for (const clock of [[], [{ now: 'invalid' }]]) {
    const bad = fixture({ clock });
    await expect(bad.authority.recheck(bad.tx, bad.db, principal)).rejects.toThrow('invalid_server_clock');
  }
});

it('requires explicit authority configuration and rejects cross-authority or malformed principals', async () => {
  const f = fixture();
  for (const value of [null, {}, { source: 'unknown' }, { source: 'better-auth' }, { source: 'better-auth', authenticate: () => null }]) {
    expect(() => bindSessionAuthority(f.db, value as unknown as SessionAuthority)).toThrow('invalid_session_authority');
  }
  for (const value of [null, {}, { getSession: () => null, trustedOrigins: [] },
    { getSession: () => null, trustedOrigins: [null] }, { getSession: () => null, trustedOrigins: ['*'] },
    { getSession: () => null, trustedOrigins: [''] }, { getSession: () => null, trustedOrigins: ['\n'] }]) {
    expect(() => createBetterAuthAuthority(f.db, value as unknown as BetterAuthAuthorityOptions)).toThrow('invalid_better_auth_config');
  }
  expect(await activeSession(f.tx, f.db as AuthorizedDatabase, principal)).toBe(false);
  expect(await activeSession(f.tx, bindSessionAuthority(f.db, f.authority), synthetic)).toBe(false);
  expect(validPrincipal(principal)).toBe(true);
  for (const value of [{ ...principal, userId: 'bad' }, { ...principal, authUserId: 'x'.repeat(201) },
    { ...principal, sessionId: '\n' }, { ...principal, source: 'unknown' }, { ...synthetic, sessionId: 'not-a-uuid' }]) {
    expect(validPrincipal(value as Principal)).toBe(false);
  }
  const syntheticAuthority = createSyntheticAuthority(async () => principal);
  expect(await syntheticAuthority.authenticate(request({ authorization: 'Bearer synthetic' }))).toBeNull();
  expect(await syntheticAuthority.recheck(f.tx, f.db, principal)).toBe(false);
  const mixed = bindSessionAuthority(f.db, { ...f.authority, authenticate: async () => synthetic });
  const response = await createChatHandler(mixed)(new Request(`${origin}/v1/couples/${userId}/chat/messages`));
  expect(response.status).toBe(401);
});
