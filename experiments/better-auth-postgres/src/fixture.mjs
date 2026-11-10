import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { withDeadline } from './async-bounds.mjs';
import { localConfiguration, verifyDisposable } from './guard.mjs';

export async function createFixture() {
  const configuration = localConfiguration(process.env);
  const schema = `ps_case_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ ...configuration.connection, max: 2, application_name: 'pairspace-spike-observer' });
  let authPool;
  let domainPool;
  try {
    await verifyDisposable(admin, configuration);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const common = { ...configuration.connection, options: `-c search_path=${schema},public`, max: 4 };
    authPool = new Pool({ ...common, application_name: `ps-auth-${schema}` });
    domainPool = new Pool({ ...common, application_name: `ps-domain-${schema}` });
    const options = {
      database: authPool,
      baseURL: 'http://localhost:3123', secret: randomBytes(48).toString('base64url'),
      emailAndPassword: { enabled: true }, session: { cookieCache: { enabled: false } },
      logger: { level: 'error' },
    };
    await (await getMigrations(options)).runMigrations();
    await domainPool.query(`
      CREATE TABLE domain_users (id UUID PRIMARY KEY, auth_user_id TEXT UNIQUE NOT NULL REFERENCES "user"(id));
      CREATE TABLE couples (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
      CREATE TABLE memberships (user_id UUID REFERENCES domain_users(id), couple_id TEXT REFERENCES couples(id), active BOOLEAN NOT NULL, PRIMARY KEY(user_id, couple_id));
      CREATE TABLE messages (id UUID PRIMARY KEY, couple_id TEXT NOT NULL REFERENCES couples(id), sender_id UUID NOT NULL REFERENCES domain_users(id), text TEXT NOT NULL, membership_epoch INTEGER NOT NULL);
    `);
    const auth = betterAuth(options);
    async function call(path, body, cookie) {
      const headers = { origin: 'http://localhost:3123' };
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      return auth.handler(new Request(`http://localhost:3123/api/auth/${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
    }
    return {
      admin, authPool, domainPool, call, schema,
      async provision(authUserId, pairId) {
        const id = randomUUID();
        await domainPool.query('INSERT INTO domain_users VALUES ($1, $2)', [id, authUserId]);
        await domainPool.query('INSERT INTO couples VALUES ($1, 1) ON CONFLICT DO NOTHING', [pairId]);
        await domainPool.query('INSERT INTO memberships VALUES ($1, $2, true)', [id, pairId]);
        return id;
      },
      async resolve(cookie) {
        return auth.api.getSession({ headers: new Headers({ cookie }) });
      },
      async waitForAuthDeleteLock() {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const { rows } = await admin.query(`SELECT wait_event_type FROM pg_stat_activity
            WHERE datname = current_database() AND application_name = $1
              AND state = 'active' AND query ~* 'delete.*session'`, [`ps-auth-${schema}`]);
          if (rows.some(row => row.wait_event_type === 'Lock')) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Auth session DELETE never observed waiting on a PostgreSQL lock');
      },
      async close() {
        try {
          await withDeadline(Promise.all([authPool.end(), domainPool.end()]), 5000, 'Pool cleanup');
          await verifyDisposable(admin, configuration);
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        } finally { await withDeadline(admin.end(), 5000, 'Observer cleanup'); }
      },
    };
  } catch (error) {
    // Only the generated schema in the verified disposable database can be removed.
    try {
      await withDeadline(Promise.all([authPool?.end(), domainPool?.end()]), 5000, 'Failed setup cleanup');
      await verifyDisposable(admin, configuration);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally { await withDeadline(admin.end(), 5000, 'Observer cleanup'); }
    throw error;
  }
}
