import { vi } from 'vitest';
import type { Database, SqlExecutor } from '../src/contracts.ts';
import { createPairInvitationHandler } from '../src/pair-invitations.ts';
import { id } from './fixtures.ts';
export { id };
export const origin = 'http://127.0.0.1:3123';
export const userId = id(1), coupleId = id(10), inviteId = id(20), commandId = id(30);
export const now = new Date('2026-11-10T00:00:00Z');
export const expires = new Date(+now + 60000);
export const row = (overrides: Record<string, unknown> = {}) => ({ id: inviteId, command_id: commandId, owned: true,
  created_at: now.toISOString(), expires_at: new Date(+now + 600000).toISOString(), revoked_at: null, consumed_at: null, ...overrides });
export const request = (method = 'POST', body: string | Uint8Array<ArrayBuffer> | null = JSON.stringify({ commandId }),
  query = '', headers: Record<string, string> = {}) => new Request(`${origin}/v1/spaces/waiting/invite${query}`, {
  method, body: ['GET', 'HEAD'].includes(method) ? null : body,
  headers: { origin, cookie: 'synthetic-cookie', 'content-type': 'application/json', ...headers },
});
type Rows = Partial<Record<'initial' | 'user' | 'provider' | 'session' | 'clock' | 'mapping' | 'membership'
  | 'currentMembership' | 'couple' | 'members' | 'current' | 'target' | 'inserted' | 'revoked', unknown[]>>;
export function fixture(overrides: Rows = {}) {
  const rows = { initial: [{ user_id: userId }], user: [{ deleted_at: null }], provider: [{ id: 'provider-user' }],
    session: [{ created_at: new Date(+now - 10000).toISOString(), expires_at: expires.toISOString() }],
    clock: [{ now: now.toISOString() }], mapping: [{ user_id: userId }], membership: [{ couple_id: coupleId }],
    currentMembership: [{ couple_id: coupleId }], couple: [{ status: 'waiting_partner', membership_epoch: 1 }],
    members: [{ active_count: 1, own_count: 1 }], current: [], target: [], inserted: [row()], revoked: [{ id: inviteId }], ...overrides };
  let reads = 0;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    void params;
    return { rows: sql.includes('INSERT INTO pair_invites') ? rows.inserted
      : sql.includes('UPDATE pair_invites') ? rows.revoked : sql.includes('FROM pair_invites')
        ? (sql.includes('revoked_at IS NULL') ? rows.current : rows.target)
        : sql.includes('FROM users') ? rows.user : sql.includes('FROM "user"') ? rows.provider
          : sql.includes('FROM "session"') ? rows.session : sql.includes('clock_timestamp') ? rows.clock
            : sql.includes('FROM better_auth_identities') ? (sql.includes('FOR SHARE') ? rows.mapping : rows.initial)
              : sql.includes('count(*)') ? rows.members : sql.includes('FROM couple_members')
                ? (reads++ % 2 === 0 ? rows.membership : rows.currentMembership) : rows.couple };
  });
  const tx: SqlExecutor = { query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await query(sql, params)).rows as T[] }) };
  const transaction = vi.fn(async <T>(work: (tx: SqlExecutor) => Promise<T>) => work(tx));
  const db: Database = { now: () => now, transaction: async <T>(work: (tx: SqlExecutor) => Promise<T>) => await transaction(work) as T };
  const read = vi.fn(async (): Promise<unknown> => ({ user: { id: 'provider-user' },
    session: { id: 'provider-session', userId: 'provider-user', expiresAt: expires, token: 'private-token' } }));
  const handler = createPairInvitationHandler(db, { getSession: read, trustedOrigins: [origin, 'pairspace://'] });
  return { handler, read, query, transaction, rows };
}
export const mutations = (f: ReturnType<typeof fixture>) => f.query.mock.calls.filter(([sql]) => /INSERT|UPDATE pair_invites/.test(sql));
