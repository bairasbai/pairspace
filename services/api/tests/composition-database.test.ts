import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresDatabase } from '../src/postgres-database.ts';

function fixture() {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => { void _sql; void _params; return { rows: [{ value: 42 }] }; });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, query, release, connect };
}
it('uses one borrowed connection for bounded transaction and typed query results', async () => {
  const f = fixture(); const db = createPostgresDatabase(f.pool, { statementMs: 7000, lockMs: 5000 });
  expect(db.now()).toBeInstanceOf(Date);
  const result = await db.transaction(async tx => (await tx.query<{ value: number }>('SELECT value', ['synthetic'])).rows[0].value);
  expect(result).toBe(42);
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', "SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$2,true)", 'SELECT value', 'COMMIT']);
  expect(f.query.mock.calls[1][1]).toEqual(['7000', '5000']);
  expect(f.release).toHaveBeenCalledWith(false);
});
it('rolls back failed work/commit and discards connection after rollback failure', async () => {
  for (const point of ['work', 'COMMIT', 'ROLLBACK']) {
    const f = fixture();
    f.query.mockImplementation(async sql => {
      if (sql === point) throw new Error('synthetic query failure');
      return { rows: [] };
    });
    const db = createPostgresDatabase(f.pool, { statementMs: 7000, lockMs: 5000 });
    await expect(db.transaction(async () => {
      if (point !== 'COMMIT') throw new Error('synthetic work failure');
      return 42;
    })).rejects.toThrow(point === 'ROLLBACK' ? 'database_rollback_failed' : /synthetic/);
    expect(f.query).toHaveBeenCalledWith('ROLLBACK');
    expect(f.release).toHaveBeenCalledWith(point === 'ROLLBACK');
  }
});
it('discards on BEGIN failure and propagates pool-acquisition failure without fake success', async () => {
  const f = fixture(); f.query.mockRejectedValue(new Error('begin failure'));
  await expect(createPostgresDatabase(f.pool, { statementMs: 7000, lockMs: 5000 }).transaction(async () => 42)).rejects.toThrow('begin failure');
  expect(f.release).toHaveBeenCalledWith(true);
  expect(f.query).not.toHaveBeenCalledWith('ROLLBACK');
  f.connect.mockRejectedValue(new Error('pool failure')); f.release.mockClear();
  await expect(createPostgresDatabase(f.pool, { statementMs: 7000, lockMs: 5000 }).transaction(async () => 42)).rejects.toThrow('pool failure');
  expect(f.release).not.toHaveBeenCalled();
});

it('discards an executed BEGIN with lost acknowledgement without running domain work', async () => {
  const f = fixture();
  let transactionOpen = false;
  f.query.mockImplementation(async sql => {
    if (sql === 'BEGIN') {
      transactionOpen = true; // Server executes before the client loses its acknowledgement.
      throw new Error('Query read timeout');
    }
    return { rows: [] };
  });
  f.release.mockImplementation((discard: boolean) => {
    expect(transactionOpen).toBe(true);
    expect(discard).toBe(true); // Destroy, never return this open transaction to the pool.
    transactionOpen = false;
  });
  const work = vi.fn(async () => 42);
  await expect(createPostgresDatabase(f.pool, { statementMs: 7000, lockMs: 5000 })
    .transaction(work)).rejects.toThrow('Query read timeout');
  expect(work).not.toHaveBeenCalled();
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN']);
  expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(transactionOpen).toBe(false);
});
