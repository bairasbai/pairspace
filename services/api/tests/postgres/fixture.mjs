import { readFile } from 'node:fs/promises';
import { bindSessionAuthority } from '../../src/auth-authority.ts';
import { createBetterAuthAuthority } from '../../src/better-auth-authority.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { withDeadline } from './async-bounds.mjs';
import { localConfiguration, verifyDisposable } from './guard.mjs';

export async function createFixture({ skipBlindRoundsMigration = false, skipAnnualDatesMigration = false, skipSongEditingMigration = false } = {}) {
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
    const explicitSecret = randomBytes(48).toString('base64url');
    const options = {
      database: authPool,
      baseURL: 'http://localhost:3123', secret: explicitSecret, secrets: [{ version: 1, value: explicitSecret }],
      emailAndPassword: { enabled: true }, session: { cookieCache: { enabled: false } },
      logger: { level: 'error' },
    };
    await (await getMigrations(options)).runMigrations();
    for (const name of ['001_chat.sql', '002_auth.sql', '003_better_auth_identity.sql', '004_pair_invites.sql', '005_care_signals.sql', '006_letters.sql', '007_scheduled_letters.sql', '008_pair_leave.sql', '009_shared_tasks.sql', '010_blind_answers.sql', ...(skipBlindRoundsMigration ? [] : ['011_repeatable_blind_rounds.sql']), '012_shared_dates.sql', ...(skipAnnualDatesMigration ? [] : ['013_annual_shared_dates.sql', '014_edit_shared_dates.sql']), '015_shared_memories.sql', '016_shared_songs.sql', '017_shared_song_links.sql', ...(skipSongEditingMigration ? [] : ['018_edit_shared_songs.sql'])]) {
      await domainPool.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
    }
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
      database() {
        const db = {
          now: () => new Date(),
          async transaction(work) {
            const connection = await domainPool.connect();
            let begun = false;
            try {
              await connection.query('BEGIN'); begun = true;
              const value = await work({ query: (sql, params) => connection.query(sql, params) });
              await connection.query('COMMIT'); begun = false;
              return value;
            } finally {
              try { if (begun) await connection.query('ROLLBACK'); } finally { connection.release(); }
            }
          },
        };
        return bindSessionAuthority(db, createBetterAuthAuthority(db, {
          getSession: headers => auth.api.getSession({ headers }), trustedOrigins: ['http://localhost:3123'],
        }));
      },
      async provision(authUserIds, pairId) {
        const ids = authUserIds.map(() => randomUUID());
        const connection = await domainPool.connect();
        try {
          await connection.query('BEGIN');
          await connection.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [pairId]);
          for (let index = 0; index < authUserIds.length; index++) {
            await connection.query('INSERT INTO users(id) VALUES ($1)', [ids[index]]);
            await connection.query('INSERT INTO better_auth_identities VALUES ($1,$2)', [authUserIds[index], ids[index]]);
            await connection.query("INSERT INTO couple_members(couple_id,user_id,slot,status) VALUES($1,$2,$3,'active')", [pairId, ids[index], index + 1]);
          }
          await connection.query("UPDATE couples SET status='active' WHERE id=$1", [pairId]);
          await connection.query('COMMIT');
        } catch (error) { await connection.query('ROLLBACK'); throw error; }
        finally { connection.release(); }
        return ids;
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
