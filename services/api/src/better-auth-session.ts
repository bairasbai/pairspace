import type { Database, SqlExecutor } from './contracts.ts';
import { providerIdentifier } from './session.ts';

/** Inject the official auth.api.getSession({headers}) from the SAME database/schema.
 * Disable Better Auth cookie cache. Unknown output is validated before use.
 */
export type BetterAuthSessionReader = (headers: Headers) => Promise<unknown>;
export type BetterAuthAuthorityOptions = Readonly<{
  getSession: BetterAuthSessionReader;
  trustedOrigins: readonly string[];
}>;
export type VerifiedBetterAuthSession = Readonly<{
  authUserId: string; sessionId: string; tokenExpiresAt: number;
}>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object'
  && value !== null && !Array.isArray(value);
const date = (value: unknown): number => value instanceof Date ? value.getTime() : NaN;

/** Provider verification only: no domain mapping, provisioning or authorization grant. */
export function createBetterAuthSessionVerifier(db: Database, options: BetterAuthAuthorityOptions) {
  if (!options || typeof options.getSession !== 'function' || !Array.isArray(options.trustedOrigins)
    || !options.trustedOrigins.length || options.trustedOrigins.some(value => typeof value !== 'string'
      || value.length === 0 || value.includes('*') || /\p{Cc}/u.test(value))) throw new Error('invalid_better_auth_config');
  const origins = new Set(options.trustedOrigins);
  return async (request: Request): Promise<VerifiedBetterAuthSession | null> => {
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
    return { authUserId: user.id, sessionId: session.id, tokenExpiresAt: Math.floor(expires / 1000) };
  };
}

/** Call after the domain-user lock (if mapped), before mapping/couple locks. */
export async function recheckBetterAuthSession(tx: SqlExecutor, session: VerifiedBetterAuthSession,
  providerLock: 'share' | 'exclusive' = 'share'): Promise<boolean> {
  // Fixed Better Auth default names, in a trusted shared schema/search_path.
  const authUser = await tx.query<{ id: string }>(
    `SELECT id FROM "user" WHERE id=$1 FOR ${providerLock === 'exclusive' ? 'UPDATE' : 'SHARE'}`, [session.authUserId]);
  if (authUser.rows.length !== 1 || authUser.rows[0].id !== session.authUserId) return false;
  const sessions = await tx.query<{ created_at: string; expires_at: string }>(`
    SELECT "createdAt"::text AS created_at, "expiresAt"::text AS expires_at FROM "session"
    WHERE id=$1 AND "userId"=$2 FOR SHARE`, [session.sessionId, session.authUserId]);
  if (sessions.rows.length !== 1) return false;
  const row = sessions.rows[0];
  const clock = await tx.query<{ now: string }>('SELECT clock_timestamp()::text AS now');
  const now = Date.parse(clock.rows[0]?.now);
  if (!Number.isFinite(now)) throw new Error('invalid_server_clock');
  return now >= Date.parse(row.created_at) && now < Date.parse(row.expires_at)
    && now < session.tokenExpiresAt * 1000;
}
