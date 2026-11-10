import type { AuthorizedDatabase, Principal, SqlExecutor } from './contracts.ts';
import { isUuid } from './validation.ts';

export const providerIdentifier = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 200 && value.trim() === value && !/\p{Cc}/u.test(value);

export const validPrincipal = (principal: Principal) => isUuid(principal.userId)
  && Number.isSafeInteger(principal.tokenExpiresAt) && principal.tokenExpiresAt > 0
  && (principal.source === 'synthetic-jwt' ? isUuid(principal.sessionId)
    : principal.source === 'better-auth' && providerIdentifier(principal.sessionId) && providerIdentifier(principal.authUserId));

/** Every private use case repeats this check inside its existing SQL transaction. */
export async function activeSession(tx: SqlExecutor, db: AuthorizedDatabase, principal: Principal): Promise<boolean> {
  if (!db.sessionAuthority || db.sessionAuthority.source !== principal.source) return false;
  return db.sessionAuthority.recheck(tx, db, principal);
}
