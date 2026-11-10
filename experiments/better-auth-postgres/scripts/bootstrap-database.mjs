import { Pool } from 'pg';
import { withDeadline } from '../src/async-bounds.mjs';
import { localConfiguration } from '../src/guard.mjs';
const configuration = localConfiguration(process.env);
// Only the new cluster started by run-postgres.sh supplies these credentials.
const admin = new Pool({ ...configuration.connection, database: 'postgres', max: 1 });
try {
  const { rows } = await admin.query('SELECT version() AS version');
  console.log(rows[0].version);
  await admin.query(`CREATE DATABASE ${configuration.connection.database}`);
} finally { await withDeadline(admin.end(), 5000, 'Bootstrap admin cleanup'); }
const pool = new Pool({ ...configuration.connection, max: 1 });
try {
  await pool.query('CREATE TABLE public.pairspace_spike_guard (nonce TEXT NOT NULL)');
  await pool.query('INSERT INTO public.pairspace_spike_guard VALUES ($1)', [configuration.nonce]);
} finally { await withDeadline(pool.end(), 5000, 'Bootstrap pool cleanup'); }
