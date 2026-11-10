import type { SqlExecutor } from './contracts.ts';

/** Caller holds the couple lock. Return counts only, never another member's identity. */
export async function isOwnWaitingSpace(tx: SqlExecutor, coupleId: string, userId: string): Promise<boolean> {
  const result = await tx.query<{ active_count: number; own_count: number }>(`
    SELECT count(*)::int AS active_count,
      count(*) FILTER (WHERE user_id=$2 AND slot=1)::int AS own_count
    FROM couple_members WHERE couple_id=$1 AND status='active'`, [coupleId, userId]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !Number.isSafeInteger(row.active_count) || row.active_count < 0
    || !Number.isSafeInteger(row.own_count) || row.own_count < 0 || row.own_count > row.active_count) {
    throw new Error('invalid_waiting_space_data');
  }
  return row.active_count === 1 && row.own_count === 1;
}
