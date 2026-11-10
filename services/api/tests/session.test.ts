import { afterEach, beforeEach, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { closeCouple, readHistory, sendMessage } from '../src/chat.ts';
import { adapter, c1, command, createFixture, fixtureNow, history, id, principal } from './fixtures.ts';
let pg: PGlite;
beforeEach(async () => { pg = await createFixture(); });
afterEach(async () => { await pg.close(); });
it('every use case refuses a session revoked after earlier principal verification', async () => {
  const verifiedEarlier = { ...principal };
  await pg.query('UPDATE auth_sessions SET revoked_at=$1 WHERE id=$2', [fixtureNow(), principal.sessionId]);
  const db = adapter(pg);
  expect(await sendMessage(db, verifiedEarlier, command)).toEqual({ ok: false, error: 'unavailable' });
  expect(await readHistory(db, verifiedEarlier, history)).toEqual({ ok: false, error: 'unavailable' });
  expect(await closeCouple(db, verifiedEarlier, c1, 1)).toEqual({ ok: false, error: 'unavailable' });
  expect((await pg.query('SELECT * FROM chat_messages')).rows).toEqual([]);
});
it('requires active user/session and rechecks expiry against trusted transaction clock', async () => {
  const db = adapter(pg);
  for (const candidate of [{ ...principal, sessionId: 'bad' }, { ...principal, sessionId: id(999) },
    { ...principal, tokenExpiresAt: 0 }, { ...principal, tokenExpiresAt: NaN }, { ...principal, tokenExpiresAt: fixtureNow().getTime() / 1000 }]) {
    expect(await sendMessage(db, candidate, command)).toEqual({ ok: false, error: 'unavailable' });
  }
  await pg.query('UPDATE auth_sessions SET expires_at=$1 WHERE id=$2', [fixtureNow(), principal.sessionId]);
  expect(await sendMessage(db, principal, command)).toEqual({ ok: false, error: 'unavailable' });
  await pg.query("UPDATE auth_sessions SET created_at='2027-01-01',expires_at='2100-01-01' WHERE id=$1", [principal.sessionId]);
  expect(await sendMessage(db, principal, command)).toEqual({ ok: false, error: 'unavailable' });
  await pg.query('UPDATE users SET deleted_at=$1 WHERE id=$2', [fixtureNow(), principal.userId]);
  expect(await sendMessage(db, principal, command)).toEqual({ ok: false, error: 'unavailable' });
});
it('invalid trusted clock aborts before messages/outbox and identity FK prevents mismatched session ownership', async () => {
  await expect(sendMessage({ ...adapter(pg), now: () => new Date(NaN) }, principal, command)).rejects.toThrow('invalid_server_clock');
  await expect(pg.query('UPDATE auth_sessions SET user_id=$1 WHERE id=$2', [id(2), principal.sessionId])).rejects.toThrow();
  await expect(pg.query('UPDATE auth_sessions SET expires_at=created_at WHERE id=$1', [principal.sessionId])).rejects.toThrow();
  await expect(pg.query("UPDATE auth_sessions SET revoked_at='2025-01-01' WHERE id=$1", [principal.sessionId])).rejects.toThrow();
  expect((await pg.query('SELECT * FROM outbox_events')).rows).toEqual([]);
});
