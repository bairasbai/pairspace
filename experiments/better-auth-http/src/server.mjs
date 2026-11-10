import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { expo } from '@better-auth/expo';

// Isolated experiment. Never import this harness into the product.
export async function createFixture({ beforeTransaction = async () => {} } = {}) {
  const db = new DatabaseSync(':memory:');
  let auth;
  let authHandler;
  let baseURL;
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/api/auth/')) return await authHandler(request, response);
      const match = /^\/pairs\/([a-zA-Z0-9-]+)\/messages$/.exec(request.url ?? '');
      if (!match || request.method !== 'POST') return json(response, 404, { error: 'not_found' });
      if (request.headers.origin !== baseURL) return json(response, 403, { error: 'forbidden' });
      if (request.headers['content-type'] !== 'application/json') return json(response, 415, { error: 'unsupported_media' });
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) return json(response, 401, { error: 'unauthorized' });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2048) return json(response, 413, { error: 'too_large' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return json(response, 400, { error: 'invalid_request' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || typeof body.text !== 'string'
        || body.text.length === 0 || body.text.length > 200) {
        return json(response, 400, { error: 'invalid_request' });
      }
      // Test-only injected barrier, never an HTTP endpoint.
      await beforeTransaction({ sessionId: session.session.id, pairId: match[1] });
      const result = writeMessage(db, session, match[1], body.text);
      return json(response, result.status, result.body);
    } catch {
      return json(response, 500, { error: 'internal_error' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseURL = `http://127.0.0.1:${server.address().port}`;
  const options = {
    database: db, baseURL, secret: randomBytes(48).toString('base64url'),
    trustedOrigins: [baseURL, 'pairspace-spike://'],
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: false } }, plugins: [expo()],
    logger: { level: 'error' },
  };
  try {
    await (await getMigrations(options)).runMigrations();
    db.exec(`
      CREATE TABLE domain_users (id TEXT PRIMARY KEY, auth_user_id TEXT UNIQUE NOT NULL REFERENCES user(id));
      CREATE TABLE couples (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
      CREATE TABLE memberships (user_id TEXT NOT NULL REFERENCES domain_users(id), couple_id TEXT NOT NULL REFERENCES couples(id), active INTEGER NOT NULL, PRIMARY KEY(user_id, couple_id));
      CREATE TABLE messages (id TEXT PRIMARY KEY, couple_id TEXT NOT NULL REFERENCES couples(id), sender_id TEXT NOT NULL REFERENCES domain_users(id), text TEXT NOT NULL, membership_epoch INTEGER NOT NULL);
    `);
    auth = betterAuth(options);
    authHandler = toNodeHandler(auth);
  } catch (error) {
    server.close(); db.close(); throw error;
  }
  return {
    db, baseURL,
    provision(authUserId, coupleId) {
      const id = randomUUID();
      db.prepare('INSERT INTO domain_users VALUES (?, ?)').run(id, authUserId);
      db.prepare('INSERT OR IGNORE INTO couples VALUES (?, 1)').run(coupleId);
      db.prepare('INSERT INTO memberships VALUES (?, ?, 1)').run(id, coupleId);
      return id;
    },
    async close() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function writeMessage(db, verified, pairId, text) {
  // No await while the transaction is active. This proves serialized SQLite
  // behavior only, not row locking or interprocess PostgreSQL isolation.
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = Date.now();
    const session = db.prepare(`SELECT s.id, s.expiresAt, s.createdAt FROM session s JOIN user u ON u.id = s.userId
      WHERE s.id = ? AND s.userId = ?`)
      .get(verified.session.id, verified.user.id);
    // The pinned SQLite adapter stores dates as ISO text, not epoch numbers.
    const expires = typeof session?.expiresAt === 'string' ? Date.parse(session.expiresAt) : NaN;
    const created = typeof session?.createdAt === 'string' ? Date.parse(session.createdAt) : NaN;
    if (!session || !Number.isFinite(expires) || !Number.isFinite(created) || expires <= now || created > now) {
      db.exec('ROLLBACK');
      return { status: 401, body: { error: 'unauthorized' } };
    }
    const membership = db.prepare(`SELECT d.id, c.epoch FROM domain_users d
      JOIN memberships m ON m.user_id = d.id JOIN couples c ON c.id = m.couple_id
      WHERE d.auth_user_id = ? AND m.couple_id = ? AND m.active = 1`)
      .get(verified.user.id, pairId);
    if (!membership) {
      db.exec('ROLLBACK');
      return { status: 403, body: { error: 'forbidden' } };
    }
    const id = randomUUID();
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(id, pairId, membership.id, text, membership.epoch);
    db.exec('COMMIT');
    return { status: 201, body: { id } };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
