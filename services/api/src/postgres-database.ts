import type { Pool } from 'pg';
import type { Database } from './contracts.ts';

export type TransactionLimits = Readonly<{ statementMs: number; lockMs: number }>;

/** Uses the SAME caller-owned pool passed to Better Auth. Does not open or close pools. */
export function createPostgresDatabase(pool: Pool, limits: TransactionLimits): Database {
  return {
    now: () => new Date(),
    async transaction(work) {
      const client = await pool.connect();
      let begun = false;
      // BEGIN may execute before a client timeout loses its acknowledgement.
      // Never return that uncertain connection to the shared provider pool.
      let discard = true;
      try {
        await client.query('BEGIN'); begun = true; discard = false;
        await client.query("SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$2,true)",
          [String(limits.statementMs), String(limits.lockMs)]);
        const value = await work({ query: async <T>(sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params);
          return { rows: result.rows as T[] };
        } });
        await client.query('COMMIT'); begun = false;
        return value;
      } catch (error) {
        try { if (begun) await client.query('ROLLBACK'); }
        catch { discard = true; throw new Error('database_rollback_failed'); }
        throw error;
      } finally { client.release(discard); }
    },
  };
}
