import type { Database, Principal, SqlExecutor } from './contracts.ts';
import type { SessionAuthority } from './auth-authority.ts';
import { providerIdentifier } from './session.ts';
import { isUuid } from './validation.ts';

/** Inject the official auth.api.getSession({headers}) from the SAME database/schema.
 * Disable Better Auth cookie cache. Unknown output is validated before use.
 */
export type BetterAuthSessionReader = (headers: Headers) => Promise<unknown>;
export type BetterAuthAuthorityOptions = Readonly<{
  getSession: BetterAuthSessionReader;
  trustedOrigins: readonly string[];
}>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const date = (value: unknown): number => value instanceof Date ? value.getTime() : NaN;

export function createBetterAuthAuthority(db: Database, options: BetterAuthAuthorityOptions): SessionAuthority {
  if (!options || typeof options.getSession !== 'function' || !Array.isArray(options.trustedOrigins)
    || !options.trustedOrigins.length || options.trustedOrigins.some(value => typeof value !== 'string'
      || value.length === 0 || value.includes('*') || /\p{Cc}/u.test(value))) throw new Error('invalid_better_auth_config');
  const origins = new Set(options.trustedOrigins);
  return {
    source: 'better-auth',
    async authenticate(request) {
      // Explicit cookie transport. Never reinterpret synthetic bearer credentials.
      const origin = request.headers.get('origin') ?? request.headers.get('expo-origin');
      const cookie = request.headers.get('cookie');
      if (!origin || !origins.has(origin) || !cookie || cookie.length > 8192 || request.headers.has('authorization')) return null;
      const result = await options.getSession(new Headers(request.headers));
      if (!record(result) || !record(result.user) || !record(result.session)) return null;
      const { user, session } = result;
      const expires = date(session.expiresAt);
      const now = db.now().getTime();
      if (!Number.isFinite(now)) throw new Error('invalid_server_clock');
      if (!providerIdentifier(user.id) || !providerIdentifier(session.id) || session.userId !== user.id
        || !Number.isFinite(expires) || expires <= now) return null;
      const mapped = await db.transaction(tx => tx.query<{ user_id: string }>(`
        SELECT i.user_id FROM better_auth_identities i JOIN users u ON u.id=i.user_id
        WHERE i.auth_user_id=$1 AND u.deleted_at IS NULL`, [user.id]));
      if (mapped.rows.length !== 1 || !isUuid(mapped.rows[0].user_id)) return null;
      return { source: 'better-auth', userId: mapped.rows[0].user_id, authUserId: user.id,
        sessionId: session.id, tokenExpiresAt: Math.floor(expires / 1000) };
    },
    recheck: (tx, _db, principal) => recheck(tx, principal),
  };
}

async function recheck(tx: SqlExecutor, principal: Principal): Promise<boolean> {
  if (principal.source !== 'better-auth') return false;
  const user = await tx.query<{ deleted_at: string | null }>('SELECT deleted_at FROM users WHERE id=$1 FOR SHARE', [principal.userId]);
  if (!user.rows[0] || user.rows[0].deleted_at !== null) return false;
  // Fixed Better Auth default names, in a trusted shared schema/search_path.
  const authUser = await tx.query<{ id: string }>('SELECT id FROM "user" WHERE id=$1 FOR SHARE', [principal.authUserId]);
  if (authUser.rows.length !== 1) return false;
  const sessions = await tx.query<{ created_at: string; expires_at: string }>(`
    SELECT "createdAt"::text AS created_at, "expiresAt"::text AS expires_at FROM "session"
    WHERE id=$1 AND "userId"=$2 FOR SHARE`, [principal.sessionId, principal.authUserId]);
  const row = sessions.rows[0];
  if (!row) return false;
  const clock = await tx.query<{ now: string }>('SELECT clock_timestamp()::text AS now');
  const now = Date.parse(clock.rows[0]?.now);
  if (!Number.isFinite(now)) throw new Error('invalid_server_clock');
  if (!(now >= Date.parse(row.created_at) && now < Date.parse(row.expires_at)
    && now < principal.tokenExpiresAt * 1000)) return false;
  const identity = await tx.query<{ user_id: string }>(`
    SELECT user_id FROM better_auth_identities WHERE auth_user_id=$1 AND user_id=$2 FOR SHARE`,
  [principal.authUserId, principal.userId]);
  return identity.rows.length === 1;
}
