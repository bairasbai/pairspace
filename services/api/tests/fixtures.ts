import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { bindSessionAuthority } from '../src/auth-authority.ts';
import { createSyntheticAuthority } from '../src/synthetic-authority.ts';
import { createChatHandler, type SessionVerifier } from '../src/http.ts';
import type { AuthorizedDatabase as Database, SqlExecutor } from '../src/contracts.ts';

export const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export const [u1, u2, u3, u4, outsider] = [1, 2, 3, 4, 5].map(id);
export const [c1, c2, waiting] = [11, 12, 13].map(id);
export const identityPrincipal = (userId: string) => ({ source: 'synthetic-jwt' as const, userId, sessionId: id(1000 + Number(userId.slice(-12))), tokenExpiresAt: 4102444800 });
export const principal = identityPrincipal(u1);
export const fixtureNow = () => new Date('2026-11-10T00:00:00Z');
export const command = { coupleId: c1, membershipEpoch: 1, clientId: id(101), body: 'Hello' };
export const history = { coupleId: c1, membershipEpoch: 1, limit: 50 };

export const adapter = (pg: PGlite): Database => bindSessionAuthority({
  now: fixtureNow,
  transaction: work => pg.transaction(tx => work({
    query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params),
  })),
}, createSyntheticAuthority(async () => null));
export async function createFixture(path?: string): Promise<PGlite> {
  const pg = new PGlite(path);
  const migration = await readFile(new URL('../migrations/001_chat.sql', import.meta.url), 'utf8');
  const auth = await readFile(new URL('../migrations/002_auth.sql', import.meta.url), 'utf8');
  await pg.transaction(async tx => { await tx.exec(migration); await tx.exec(auth); });
  await pg.transaction(async tx => {
    for (const user of [u1, u2, u3, u4, outsider]) await tx.query('INSERT INTO users(id) VALUES($1)', [user]);
    for (const user of [u1, u2, u3, u4, outsider]) {
      await tx.query('INSERT INTO auth_identities(issuer,subject,user_id) VALUES($1,$2,$3)', ['https://fixture.invalid', user, user]);
      await tx.query('INSERT INTO auth_sessions(id,user_id,issuer,subject,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [identityPrincipal(user).sessionId,user,'https://fixture.invalid',user,'2026-01-01','2100-01-01']);
    }
    for (const couple of [c1, c2, waiting]) await tx.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [couple]);
    for (const [couple, user, slot] of [[c1, u1, 1], [c1, u2, 2], [c2, u3, 1], [c2, u4, 2]]) {
      await tx.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,$3,'active')", [couple, user, slot]);
    }
    await tx.query("UPDATE couples SET status='active' WHERE id IN ($1,$2)", [c1, c2]);
  });
  return pg;
}
export function failOn(db: Database, match: string): Database {
  return {
    now: db.now,
    sessionAuthority: db.sessionAuthority,
    transaction: work => db.transaction(tx => work({
      query: <T>(sql: string, params?: unknown[]) => {
        if (sql.includes(match)) throw new Error('simulated_failure');
        return tx.query<T>(sql, params);
      },
    } satisfies SqlExecutor)),
  };
}

/** Explicit synthetic transport fixture; production handler has no verifier fallback. */
export const createSyntheticChatHandler = (db: Database, verify: SessionVerifier) =>
  createChatHandler(bindSessionAuthority(db, createSyntheticAuthority(verify)));
