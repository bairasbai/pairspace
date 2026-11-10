import type { webcrypto } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTHeaderParameters } from 'jose';
import type { PGlite } from '@electric-sql/pglite';
import { createSessionVerifier, type SessionVerifierConfig } from '../src/auth.ts';
import type { Database } from '../src/contracts.ts';
import { adapter, createFixture, failOn, fixtureNow, id, u1, u2 } from './fixtures.ts';

const issuer = 'https://auth-tests.invalid';
const audience = 'pairspace-api-test';
const subject = 'synthetic-auth-subject';
const sessionId = id(2001);
const nowSeconds = fixtureNow().getTime() / 1000;
const issuedAt = nowSeconds - 60;
const expiresAt = nowSeconds + 240;
let pg: PGlite;
let signingKey: webcrypto.CryptoKey;
let verificationKey: webcrypto.CryptoKey;
let otherKey: webcrypto.CryptoKey;
let otherPublicKey: webcrypto.CryptoKey;
let config: SessionVerifierConfig;

const claims = (changes: Record<string, unknown> = {}): JWTPayload => ({
  iss: issuer, aud: audience, sub: subject, sid: sessionId,
  iat: issuedAt, nbf: issuedAt, exp: expiresAt, ...changes,
});
const token = (changes: Record<string, unknown> = {}, header: JWTHeaderParameters = { alg: 'ES256' },
  key: webcrypto.CryptoKey | Uint8Array = signingKey) => new SignJWT(claims(changes))
  .setProtectedHeader({ typ: 'at+jwt', ...header }).sign(key);
const principal = { userId: u1, sessionId, tokenExpiresAt: expiresAt };
const verify = (db = adapter(pg), options = config) => createSessionVerifier(db, options);

beforeAll(async () => {
  ({ privateKey: signingKey, publicKey: verificationKey } = await generateKeyPair('ES256'));
  ({ privateKey: otherKey, publicKey: otherPublicKey } = await generateKeyPair('ES256'));
  config = { verificationKey, issuer, audience, maxTokenAgeSeconds: 900 };
  pg = await createFixture();
});
beforeEach(async () => {
  await pg.query('DELETE FROM auth_sessions WHERE issuer=$1', [issuer]);
  await pg.query('DELETE FROM auth_identities WHERE issuer=$1', [issuer]);
  await pg.query('UPDATE users SET deleted_at=NULL');
  await pg.query('INSERT INTO auth_identities(issuer,subject,user_id) VALUES($1,$2,$3)', [issuer, subject, u1]);
  await pg.query(`INSERT INTO auth_sessions(id,user_id,issuer,subject,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6)`, [sessionId, u1, issuer, subject,
    new Date((issuedAt - 1) * 1000).toISOString(), new Date((expiresAt + 1) * 1000).toISOString()]);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await pg.close(); });

describe('pinned-key ES256 access-token verification with synthetic accounts', () => {
  it('returns only the database identity, session and verified expiry, never private claim roles or IDs', async () => {
    const signed = await token({ userId: u2, user_id: u2, role: 'admin', couple_id: id(999),
      private_note: 'synthetic-not-for-logs' });
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await verify()(signed)).toEqual(principal);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await verify()(await token({ aud: ['another-resource', audience] }))).toEqual(principal);
  });

  it('rejects malformed, overlong, unsigned and tampered tokens before any database access', async () => {
    const db = adapter(pg);
    const transaction = vi.spyOn(db, 'transaction');
    const check = verify(db);
    const signed = await token();
    const [header, payload, signature] = signed.split('.');
    const tampered = Buffer.from(JSON.stringify(claims({ sub: 'attacker' }))).toString('base64url');
    const unsignedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString('base64url');
    for (const invalid of ['', 'not-a-token', 'a.b.c', 'a.b.c.d', 'x'.repeat(2049),
      `${header}.${tampered}.${signature}`, `${unsignedHeader}.${payload}.`,
      `${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`]) {
      expect(await check(invalid)).toBeNull();
    }
    expect(await check(null as unknown as string)).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a different signer and algorithms, including HMAC confusion using a public key', async () => {
    const check = verify();
    expect(await check(await token({}, { alg: 'ES256' }, otherKey))).toBeNull();
    const hmac = crypto.getRandomValues(new Uint8Array(32));
    expect(await check(await token({}, { alg: 'HS256' }, hmac))).toBeNull();
    const publicBytes = new Uint8Array(await crypto.subtle.exportKey('spki', verificationKey));
    expect(await check(await token({}, { alg: 'HS256' }, publicBytes))).toBeNull();
    const { privateKey } = await generateKeyPair('ES384');
    expect(await check(await token({}, { alg: 'ES384' }, privateKey))).toBeNull();
    expect(await verify(adapter(pg), { ...config, verificationKey: otherPublicKey })(await token())).toBeNull();
  });

  it('pins the access-token type and refuses header-directed keys without fetching anything', async () => {
    const check = verify();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const jwk = await exportJWK(otherPublicKey);
    for (const header of [{ alg: 'ES256', typ: 'JWT' }, { alg: 'ES256', typ: undefined },
      { alg: 'ES256', typ: 'application/at+jwt' }, { alg: 'ES256', typ: 'AT+JWT' },
      { alg: 'ES256', jku: 'https://untrusted.invalid/keys' },
      { alg: 'ES256', x5u: 'https://untrusted.invalid/certificate' }, { alg: 'ES256', jwk }]) {
      expect(await check(await token({}, header))).toBeNull();
    }
    const unknownCritical = await new SignJWT(claims())
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', crit: ['untrusted'], untrusted: true })
      .sign(signingKey, { crit: { untrusted: true } });
    expect(await check(unknownCritical)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await check(await token({}, { alg: 'ES256', kid: 'untrusted-header-is-not-a-key-selector' })))
      .toEqual(principal);
  });

  it('requires matching issuer/audience and every identity/time claim', async () => {
    const check = verify();
    for (const field of ['iss', 'aud', 'sub', 'sid', 'iat', 'nbf', 'exp']) {
      expect(await check(await token({ [field]: undefined }))).toBeNull();
    }
    for (const changes of [{ iss: 'https://another.invalid' }, { iss: [issuer] },
      { aud: 'another-api' }, { aud: [] }, { aud: 1 }, { aud: [audience, 1] }]) {
      expect(await check(await token(changes))).toBeNull();
    }
  });

  it('bounds subject and session claims and treats SQL-like subjects as literal data', async () => {
    const db = adapter(pg);
    const transaction = vi.spyOn(db, 'transaction');
    const check = verify(db);
    for (const sub of ['', ' ', 1, {}, 's'.repeat(201), 'bad\u0000subject', '\u001f', 'bad\u007f', 'bad\u0085']) {
      expect(await check(await token({ sub }))).toBeNull();
    }
    for (const sid of ['', 1, {}, 'not-a-uuid', `${sessionId} OR TRUE`]) {
      expect(await check(await token({ sid }))).toBeNull();
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(await check(await token({ sub: "' OR TRUE; --" }))).toBeNull();
    const longSubject = 's'.repeat(200);
    await pg.query('INSERT INTO auth_identities(issuer,subject,user_id) VALUES($1,$2,$3)', [issuer, longSubject, u1]);
    await pg.query('UPDATE auth_sessions SET subject=$1 WHERE id=$2', [longSubject, sessionId]);
    expect(await check(await token({ sub: longSubject }))).toEqual(principal);
  });

  it('enforces integer NumericDate claims, strict time boundaries and the maximum lifetime', async () => {
    const check = verify();
    for (const field of ['iat', 'nbf', 'exp']) {
      for (const invalid of [String(nowSeconds), null, nowSeconds + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(await check(await token({ [field]: invalid }))).toBeNull();
      }
    }
    for (const changes of [{ exp: nowSeconds }, { exp: nowSeconds - 1 },
      { iat: nowSeconds + 1 }, { nbf: nowSeconds + 1 }, { nbf: issuedAt - 1 },
      { exp: issuedAt }, { exp: issuedAt - 1 }, { nbf: expiresAt },
      { iat: nowSeconds - 901, nbf: nowSeconds - 901 }, { exp: issuedAt + 901 }]) {
      expect(await check(await token(changes))).toBeNull();
    }
    expect(await check(await token({ iat: nowSeconds, nbf: nowSeconds, exp: nowSeconds + 1 })))
      .toEqual({ ...principal, tokenExpiresAt: nowSeconds + 1 });
    expect(await check(await token({ exp: issuedAt + 900 })))
      .toEqual({ ...principal, tokenExpiresAt: issuedAt + 900 });
    expect(await verify(adapter(pg), { ...config, maxTokenAgeSeconds: 299 })(await token())).toBeNull();
    expect(await verify(adapter(pg), { ...config, maxTokenAgeSeconds: 300 })(await token())).toEqual(principal);
  });

  it('checks the trusted clock on each request with no expiration grace period', async () => {
    let instant = nowSeconds * 1000;
    const check = verify({ ...adapter(pg), now: () => new Date(instant) });
    const signed = await token();
    expect(await check(signed)).toEqual(principal);
    instant = expiresAt * 1000 - 1;
    expect(await check(signed)).toEqual(principal);
    instant += 1;
    expect(await check(signed)).toBeNull();
    instant = Number.NaN;
    await expect(check(signed)).rejects.toThrow('invalid_auth_clock');
  });

  it('rejects unknown sessions, mismatched subjects/issuers, and newly revoked or deleted accounts', async () => {
    const check = verify();
    const signed = await token();
    expect(await check(await token({ sid: id(9999) }))).toBeNull();
    expect(await check(await token({ sub: u2 }))).toBeNull();
    // A token from this issuer cannot reuse a session owned by the fixture issuer.
    expect(await check(await token({ sid: id(1001), sub: u1 }))).toBeNull();
    expect(await check(signed)).toEqual(principal);
    await pg.query('UPDATE auth_sessions SET revoked_at=$1 WHERE id=$2', [fixtureNow().toISOString(), sessionId]);
    expect(await check(signed)).toBeNull();
    await pg.query('UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1', [sessionId]);
    expect(await check(signed)).toEqual(principal);
    await pg.query('UPDATE users SET deleted_at=$1 WHERE id=$2', [fixtureNow().toISOString(), u1]);
    expect(await check(signed)).toBeNull();
    await pg.query('UPDATE users SET deleted_at=NULL WHERE id=$1', [u1]);
    expect(await check(signed)).toEqual(principal);
    await pg.query('DELETE FROM auth_sessions WHERE id=$1', [sessionId]);
    expect(await check(signed)).toBeNull();
    await pg.query('DELETE FROM auth_identities WHERE issuer=$1', [issuer]);
    expect(await check(signed)).toBeNull();
  });

  it('rejects database session expiry and a session created after the token issuance', async () => {
    const check = verify();
    const signed = await token();
    await pg.query('UPDATE auth_sessions SET expires_at=$1 WHERE id=$2', [fixtureNow().toISOString(), sessionId]);
    expect(await check(signed)).toBeNull();
    await pg.query('UPDATE auth_sessions SET expires_at=$1 WHERE id=$2',
      [new Date(nowSeconds * 1000 + 1).toISOString(), sessionId]);
    expect(await check(signed)).toEqual(principal);
    await pg.query('UPDATE auth_sessions SET created_at=$1 WHERE id=$2',
      [new Date(issuedAt * 1000 + 1000).toISOString(), sessionId]);
    expect(await check(signed)).toBeNull();
    await pg.query('UPDATE auth_sessions SET created_at=$1 WHERE id=$2',
      [new Date(issuedAt * 1000).toISOString(), sessionId]);
    expect(await check(signed)).toEqual(principal);
  });

  it('compares integer JWT issuance seconds while rejecting a future fractional session', async () => {
    await pg.query('UPDATE auth_sessions SET created_at=$1 WHERE id=$2',
      [new Date(nowSeconds * 1000 + 500).toISOString(), sessionId]);
    const signed = await token({ iat: nowSeconds, nbf: nowSeconds });
    const db = { ...adapter(pg), now: () => new Date(nowSeconds * 1000 + 750) };
    expect(await verify(db)(signed)).toEqual(principal);
    // Same NumericDate second is insufficient: creation must not be in the future.
    expect(await verify({ ...db, now: () => new Date(nowSeconds * 1000 + 250) })(signed)).toBeNull();
  });

  it('fails closed for malformed database principals and propagates database outages', async () => {
    const signed = await token();
    for (const rows of [[], [{ userId: 'not-a-uuid' }], [{ userId: u1 }, { userId: u2 }]]) {
      const malformed: Database = { now: fixtureNow,
        transaction: work => work({ query: async <T>() => ({ rows: rows as T[] }) }) };
      expect(await verify(malformed)(signed)).toBeNull();
    }
    await expect(verify(failOn(adapter(pg), 'auth_sessions'))(signed)).rejects.toThrow('simulated_failure');
    const unavailable: Database = { now: fixtureNow, transaction: async () => { throw new Error('db_unavailable'); } };
    await expect(verify(unavailable)(signed)).rejects.toThrow('db_unavailable');
  });

  it('requires an explicit supported public key, issuer, audience, lifetime and trusted clock', async () => {
    for (const field of ['verificationKey', 'issuer', 'audience', 'maxTokenAgeSeconds']) {
      expect(() => verify(adapter(pg), { ...config, [field]: undefined })).toThrow('invalid_auth_config');
    }
    for (const value of ['', ' ', 1, 'x'.repeat(2049), 'bad\nidentifier']) {
      expect(() => verify(adapter(pg), { ...config, issuer: value as string })).toThrow('invalid_auth_config');
      expect(() => verify(adapter(pg), { ...config, audience: value as string })).toThrow('invalid_auth_config');
    }
    for (const value of [0, -1, 1.5, 901, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => verify(adapter(pg), { ...config, maxTokenAgeSeconds: value })).toThrow('invalid_auth_config');
    }
    const { publicKey: otherCurve } = await generateKeyPair('ES384');
    const { publicKey: rsa } = await generateKeyPair('RS256');
    const secretKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const publicJwk = await exportJWK(verificationKey);
    const noVerifyUsage = await crypto.subtle.importKey('jwk', { ...publicJwk, key_ops: [] },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, []);
    for (const badKey of [null, {}, new Uint8Array(32), signingKey, otherCurve, rsa, secretKey, noVerifyUsage]) {
      expect(() => verify(adapter(pg), { ...config, verificationKey: badKey as webcrypto.CryptoKey })).toThrow('invalid_auth_config');
    }
    expect(() => createSessionVerifier(adapter(pg), undefined as unknown as SessionVerifierConfig)).toThrow('invalid_auth_config');
    expect(() => verify({ ...adapter(pg), now: undefined } as unknown as Database)).toThrow('invalid_auth_config');
    for (const now of [() => new Date(Number.NaN), () => '2026-11-10']) {
      expect(() => verify({ ...adapter(pg), now } as Database)).toThrow('invalid_auth_clock');
    }
    const oneSecondLifetime = verify(adapter(pg), { ...config, maxTokenAgeSeconds: 1 });
    expect(await oneSecondLifetime(await token({ iat: nowSeconds, nbf: nowSeconds, exp: nowSeconds + 1 })))
      .toEqual({ ...principal, tokenExpiresAt: nowSeconds + 1 });
  });

  it('snapshots configuration so later object mutation cannot change trust', async () => {
    const mutable = { ...config };
    const check = verify(adapter(pg), mutable);
    mutable.issuer = 'https://untrusted.invalid';
    mutable.audience = 'untrusted-api';
    mutable.verificationKey = otherPublicKey;
    mutable.maxTokenAgeSeconds = 9000;
    expect(await check(await token())).toEqual(principal);
    expect(await check(await token({ iss: mutable.issuer, aud: mutable.audience }, { alg: 'ES256' }, otherKey)))
      .toBeNull();
  });
});
