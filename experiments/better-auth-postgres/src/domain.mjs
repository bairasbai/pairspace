import { randomUUID } from 'node:crypto';

// PostgreSQL contract: user -> authoritative session -> couple -> membership.
// The experiment covers revoke-session DELETE versus FOR SHARE. It does not
// establish lock ordering for every Better Auth account-management operation.
export async function writeMessage(pool, verified, pairId, text, { afterLocks = async () => {} } = {}) {
  const connection = await pool.connect();
  let begun = false;
  try {
    await connection.query('BEGIN'); begun = true;
    await connection.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '7s'");
    const user = await connection.query('SELECT id FROM "user" WHERE id = $1 FOR SHARE', [verified.user.id]);
    if (user.rowCount !== 1) { await connection.query('ROLLBACK'); begun = false; return 401; }
    const session = await connection.query(`SELECT id, "expiresAt", "createdAt" FROM "session"
      WHERE id = $1 AND "userId" = $2 FOR SHARE`, [verified.session.id, verified.user.id]);
    // clock_timestamp(), sampled AFTER the session lock is acquired. PostgreSQL
    // now()/transaction_timestamp() would be stale after waiting for a lock.
    const time = await connection.query('SELECT clock_timestamp() AS now');
    const now = time.rows[0].now;
    const row = session.rows[0];
    if (!row || !(now instanceof Date) || !(row.expiresAt instanceof Date) || !(row.createdAt instanceof Date)
      || !Number.isFinite(+now) || !Number.isFinite(+row.expiresAt) || !Number.isFinite(+row.createdAt)
      || row.expiresAt <= now || row.createdAt > now) {
      await connection.query('ROLLBACK'); begun = false; return 401;
    }
    const couple = await connection.query('SELECT epoch FROM couples WHERE id = $1 FOR SHARE', [pairId]);
    const membership = await connection.query(`SELECT d.id FROM domain_users d
      JOIN memberships m ON m.user_id = d.id
      WHERE d.auth_user_id = $1 AND m.couple_id = $2 AND m.active = true FOR SHARE OF d, m`, [verified.user.id, pairId]);
    if (couple.rowCount !== 1 || membership.rowCount !== 1) {
      await connection.query('ROLLBACK'); begun = false; return 403;
    }
    await afterLocks(); // Test-only barrier; production would not expose this.
    await connection.query('INSERT INTO messages VALUES ($1, $2, $3, $4, $5)', [randomUUID(), pairId, membership.rows[0].id, text, couple.rows[0].epoch]);
    await connection.query('COMMIT'); begun = false;
    return 201;
  } finally {
    try { if (begun) await connection.query('ROLLBACK'); }
    finally { connection.release(); }
  }
}
