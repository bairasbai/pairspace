// No PG* defaults, connection URLs, secret discovery or remote fallback.
export function localConfiguration(env) {
  if (Object.keys(env).some(name => name.startsWith('PG'))) {
    throw new Error('Inherited PG settings forbidden; use the sanitized disposable runner');
  }
  const database = env.PAIRSPACE_PG_DATABASE;
  const nonce = env.PAIRSPACE_PG_NONCE;
  const password = env.PAIRSPACE_PG_PASSWORD;
  const port = Number(env.PAIRSPACE_PG_PORT);
  if (env.PAIRSPACE_PG_HOST !== '127.0.0.1'
    || env.PAIRSPACE_PG_USER !== 'pairspace_fixture'
    || !/^pairspace_spike_[a-f0-9]{16}$/.test(database ?? '')
    || !/^[a-f0-9]{64}$/.test(nonce ?? '')
    || !/^[a-f0-9]{64}$/.test(password ?? '')
    || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Disposable loopback PostgreSQL configuration required; use scripts/run-postgres.sh');
  }
  return {
    connection: { host: '127.0.0.1', port, user: 'pairspace_fixture', password, database, ssl: false, connectionTimeoutMillis: 3000, query_timeout: 8000, statement_timeout: 7000, lock_timeout: 5000, idle_in_transaction_session_timeout: 10000 },
    nonce,
  };
}

export async function verifyDisposable(pool, expected) {
  const result = await pool.query('SELECT current_database() AS database, nonce FROM public.pairspace_spike_guard');
  if (result.rows.length !== 1 || result.rows[0].database !== expected.connection.database
    || result.rows[0].nonce !== expected.nonce) throw new Error('Disposable database marker mismatch');
}
