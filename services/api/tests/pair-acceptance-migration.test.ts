import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Database, SqlExecutor } from '../src/contracts.ts';
import { createPairAcceptanceHandler } from '../src/pair-acceptance.ts';
import { createPairInvitationHandler } from '../src/pair-invitations.ts';
import { createWaitingSpaceHandler } from '../src/waiting-space.ts';
import { coupleId, id, origin, ownerId, userId } from './pair-acceptance-fixture.ts';

let pg: PGlite;
let issuedToken: string;
let actualCouple: string;
const options = (user = 'recipient') => ({ trustedOrigins: [origin], getSession: async () => ({ user: { id: user },
  session: { id: user + '-session', userId: user, expiresAt: new Date('2100-01-01') } }) });
const db = (transform?: (sql: string, rows: unknown[]) => unknown[]): Database => ({ now: () => new Date(),
  transaction: work => pg.transaction(tx => work({ query: async <T>(sql: string, params?: unknown[]) => {
    const result = await tx.query<T>(sql, params); return { rows: (transform ? transform(sql, result.rows) : result.rows) as T[] };
  } } satisfies SqlExecutor)) });
const send = (path: string, body: unknown) => new Request(origin + path, { method: 'POST',
  headers: { origin, cookie: 'synthetic-pglite-cookie', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const accept = () => send('/v1/pair-invitations/accept', { token: issuedToken, accept: true });

beforeEach(async () => {
  pg = new PGlite();
  for (const file of ['001_chat.sql', '002_auth.sql', '003_better_auth_identity.sql', '004_pair_invites.sql']) {
    await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  // Minimal authoritative store fixture. Official Better Auth is tested separately on real PostgreSQL.
  await pg.exec('CREATE TABLE "user" (id text PRIMARY KEY); CREATE TABLE "session" (id text PRIMARY KEY, "userId" text, "createdAt" timestamptz, "expiresAt" timestamptz)');
  for (const [auth, domain] of [['owner', ownerId], ['recipient', userId], ['third', id(3)]]) {
    await pg.query('INSERT INTO users(id) VALUES($1)', [domain]);
    await pg.query('INSERT INTO "user"(id) VALUES($1)', [auth]);
    await pg.query('INSERT INTO "session" VALUES($1,$2,$3,$4)', [auth + '-session', auth, '2026-01-01', '2100-01-01']);
    await pg.query('INSERT INTO better_auth_identities VALUES($1,$2)', [auth, domain]);
  }
  const waiting = await createWaitingSpaceHandler(db(), options('owner'))(send('/v1/spaces/waiting', {}));
  expect(waiting.status).toBe(201); actualCouple = (await waiting.json() as { value: { coupleId: string } }).value.coupleId;
  const issued = await createPairInvitationHandler(db(), options('owner'))(send('/v1/spaces/waiting/invite', { commandId: id(50) }));
  expect(issued.status).toBe(201); issuedToken = (await issued.json() as { value: { token: string } }).value.token;
  expect(typeof issuedToken === 'string' && issuedToken.length === 43).toBe(true);
});
afterEach(async () => { await pg.close(); });

it('composes waiting → issuance → preview → accept → replay using unchanged migrations and exact-two constraints', async () => {
  const handler = createPairAcceptanceHandler(db(), options());
  const preview = await handler(send('/v1/pair-invitations/preview', { token: issuedToken }));
  expect(preview.status).toBe(200); expect(Object.keys((await preview.json() as { value: object }).value).sort()).toEqual(['expiresAt', 'state']);
  const first = await handler(accept()); expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, value: { state: 'accepted', sessionId: 'recipient-session', userId,
    coupleId: actualCouple, membershipEpoch: 2, replayed: false } });
  const retry = await handler(accept()); expect(retry.status).toBe(200); expect((await retry.json() as { value: { replayed: boolean } }).value.replayed).toBe(true);
  expect((await pg.query('SELECT status,membership_epoch FROM couples WHERE id=$1', [actualCouple])).rows)
    .toEqual([{ status: 'active', membership_epoch: 2 }]);
  expect((await pg.query('SELECT user_id,slot,status FROM couple_members WHERE couple_id=$1 ORDER BY slot', [actualCouple])).rows)
    .toEqual([{ user_id: ownerId, slot: 1, status: 'active' }, { user_id: userId, slot: 2, status: 'active' }]);
  expect((await pg.query('SELECT consumed_by_user_id, consumed_at IS NOT NULL AS consumed FROM pair_invites')).rows)
    .toEqual([{ consumed_by_user_id: userId, consumed: true }]);
  const third = await createPairAcceptanceHandler(db(), options('third'))(accept()); expect(third.status).toBe(409);
  expect((await handler(send('/v1/pair-invitations/preview', { token: issuedToken }))).status).toBe(409);
  await expect(pg.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1 AND user_id=$2", [actualCouple, userId]))
    .rejects.toMatchObject({ code: '23514' });
  expect((await pg.query('SELECT * FROM outbox_events')).rows).toHaveLength(0);
  expect((await pg.query('SELECT * FROM chat_messages')).rows).toHaveLength(0);
});

it('rolls back actual membership, activation and consume writes after each malformed SQL acknowledgement', async () => {
  for (const marker of ['INSERT INTO couple_members', 'UPDATE couples', 'UPDATE pair_invites']) {
    const handler = createPairAcceptanceHandler(db((sql, rows) => sql.includes(marker) ? [] : rows), options());
    const response = await handler(accept()); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'temporarily_unavailable' });
    expect((await pg.query('SELECT status,membership_epoch FROM couples WHERE id=$1', [actualCouple])).rows)
      .toEqual([{ status: 'waiting_partner', membership_epoch: 1 }]);
    expect((await pg.query('SELECT user_id FROM couple_members WHERE couple_id=$1', [actualCouple])).rows).toEqual([{ user_id: ownerId }]);
    expect((await pg.query('SELECT consumed_at,consumed_by_user_id FROM pair_invites')).rows)
      .toEqual([{ consumed_at: null, consumed_by_user_id: null }]);
  }
  expect((await createPairAcceptanceHandler(db(), options())(accept())).status).toBe(200);
});

it('denies existing live waiting/foreign membership and historical target tuple without rewriting either pair', async () => {
  await pg.query("INSERT INTO couples(id,status) VALUES($1,'waiting_partner')", [coupleId]);
  await pg.query("INSERT INTO couple_members VALUES($1,$2,1,'active')", [coupleId, userId]);
  const handler = createPairAcceptanceHandler(db(), options()); expect((await handler(accept())).status).toBe(409);
  await pg.query("UPDATE couple_members SET status='revoked' WHERE couple_id=$1", [coupleId]);
  await pg.query("INSERT INTO couple_members VALUES($1,$2,2,'revoked')", [actualCouple, userId]);
  expect((await handler(accept())).status).toBe(409);
  expect((await pg.query('SELECT status,membership_epoch FROM couples ORDER BY id')).rows)
    .toEqual([{ status: 'waiting_partner', membership_epoch: 1 }, { status: 'waiting_partner', membership_epoch: 1 }]);
  expect((await pg.query('SELECT consumed_at FROM pair_invites')).rows).toEqual([{ consumed_at: null }]);
});
