import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { Database, SqlExecutor } from '../src/contracts.ts';
import { createPairAcceptanceHandler } from '../src/pair-acceptance.ts';
import { id } from './fixtures.ts';
export { id };
export const origin = 'http://127.0.0.1:3123';
export const userId = id(2), ownerId = id(1), coupleId = id(10), inviteId = id(20), commandId = id(30);
// Synthetic fixture token must never be printed by assertions or diagnostics.
export const token = Buffer.alloc(32, 17).toString('base64url');
export const hash = createHash('sha256').update(token).digest('hex');
export const now = new Date('2026-11-10T00:00:00Z'), expires = new Date(+now + 60000);
export const row = (overrides: Record<string, unknown> = {}) => ({ id: inviteId, command_id: commandId,
  couple_id: coupleId, issuer_user_id: ownerId, token_hash: hash, created_at: now.toISOString(),
  expires_at: new Date(+now + 600000).toISOString(), revoked_at: null, consumed_at: null, consumed_by_user_id: null, ...overrides });
export const request = (preview = false, body: string | Uint8Array<ArrayBuffer> | null = JSON.stringify(preview ? { token } : { token, accept: true }),
  query = '', headers: Record<string, string> = {}) => new Request(`${origin}/v1/pair-invitations/${preview ? 'preview' : 'accept'}${query}`, {
  method: 'POST', body, headers: { origin, cookie: 'synthetic-cookie', 'content-type': 'application/json', ...headers },
});
type Rows = Partial<Record<'initial' | 'mapping' | 'discover' | 'invite' | 'ownerInitial' | 'ownerMapping'
  | 'user' | 'ownerUser' | 'provider' | 'ownerProvider' | 'session' | 'clock' | 'couple' | 'ownerMembership'
  | 'recipient' | 'counts' | 'inserted' | 'activated' | 'consumed', unknown[]>>;
export function fixture(overrides: Rows = {}) {
  const rows = { initial: [{ user_id: userId }], mapping: [{ user_id: userId }], discover: [row()], invite: [row()],
    ownerInitial: [{ auth_user_id: 'owner-provider' }], ownerMapping: [{ auth_user_id: 'owner-provider' }],
    user: [{ deleted_at: null }], ownerUser: [{ deleted_at: null }], provider: [{ id: 'recipient-provider' }],
    ownerProvider: [{ id: 'owner-provider' }], session: [{ created_at: new Date(+now - 10000).toISOString(), expires_at: expires.toISOString() }],
    clock: [{ now: now.toISOString() }], couple: [{ status: 'waiting_partner', membership_epoch: 1 }],
    ownerMembership: [{ couple_id: coupleId }], recipient: [], counts: [{ active_count: 1, issuer_count: 1, recipient_count: 0 }],
    inserted: [{ couple_id: coupleId, user_id: userId, slot: 2, status: 'active' }],
    activated: [{ id: coupleId, status: 'active', membership_epoch: 2 }],
    consumed: [row({ consumed_at: now.toISOString(), consumed_by_user_id: userId })], ...overrides };
  const query = vi.fn(async (sql: string, params?: unknown[]) => ({ rows:
    sql.includes('INSERT INTO couple_members') ? rows.inserted : sql.includes('UPDATE couples') ? rows.activated
      : sql.includes('UPDATE pair_invites') ? rows.consumed
        : sql.includes('FROM pair_invites') ? (sql.includes('FOR UPDATE') ? rows.invite : rows.discover)
          : sql.includes('FROM users') ? (params?.[0] === userId ? rows.user : rows.ownerUser)
            : sql.includes('FROM "user"') ? (params?.[0] === 'recipient-provider' ? rows.provider : rows.ownerProvider)
              : sql.includes('FROM "session"') ? rows.session : sql.includes('clock_timestamp') ? rows.clock
                : sql.includes('FROM better_auth_identities') ? (sql.includes('SELECT user_id')
                  ? (sql.includes('FOR SHARE') ? rows.mapping : rows.initial)
                  : (sql.includes('FOR SHARE') ? rows.ownerMapping : rows.ownerInitial))
                  : sql.includes('count(*)') ? rows.counts : sql.includes('FROM couple_members')
                    ? (sql.includes('SELECT couple_id, slot') ? rows.recipient : rows.ownerMembership) : rows.couple }));
  const tx: SqlExecutor = { query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await query(sql, params)).rows as T[] }) };
  const rolledBack = vi.fn();
  const transaction = vi.fn(async <T>(work: (tx: SqlExecutor) => Promise<T>) => {
    try { return await work(tx); } catch (error) { rolledBack(); throw error; }
  });
  const db: Database = { now: () => now, transaction: async <T>(work: (tx: SqlExecutor) => Promise<T>) => await transaction(work) as T };
  const read = vi.fn(async (): Promise<unknown> => ({ user: { id: 'recipient-provider' }, session: {
    id: 'recipient-session', userId: 'recipient-provider', expiresAt: expires, token: 'private-provider-token' } }));
  const handler = createPairAcceptanceHandler(db, { getSession: read, trustedOrigins: [origin, 'pairspace://'] });
  return { handler, read, query, transaction, rolledBack, rows };
}
export const mutations = (f: ReturnType<typeof fixture>) => f.query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE)\b/.test(sql));
export const replayRows = () => ({ invite: [row({ consumed_at: now.toISOString(), consumed_by_user_id: userId })],
  couple: [{ status: 'active', membership_epoch: 2 }], recipient: [{ couple_id: coupleId, slot: 2, status: 'active' }],
  counts: [{ active_count: 2, issuer_count: 1, recipient_count: 1 }] });
