import type { AuthorizedDatabase, Database, Principal, SqlExecutor } from './contracts.ts';

export interface SessionAuthority {
  readonly source: 'synthetic-jwt' | 'better-auth';
  authenticate(request: Request): Promise<Principal | null>;
  recheck(tx: SqlExecutor, db: Database, principal: Principal): Promise<boolean>;
}

/** Composition root chooses exactly one authority; never a fallback chain. */
export function bindSessionAuthority(db: Database, authority: SessionAuthority): AuthorizedDatabase {
  if (!authority || !['synthetic-jwt', 'better-auth'].includes(authority.source)
    || typeof authority.authenticate !== 'function' || typeof authority.recheck !== 'function') {
    throw new Error('invalid_session_authority');
  }
  return { now: () => db.now(), transaction: work => db.transaction(work), sessionAuthority: authority };
}
