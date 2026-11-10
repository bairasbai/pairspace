import type { webcrypto } from 'node:crypto';
import { errors, jwtVerify } from 'jose';
import type { Database } from './contracts.ts';
import type { SessionVerifier } from './http.ts';
import { isUuid } from './validation.ts';

export type SessionVerifierConfig = Readonly<{
  /** A trusted ES256 public key supplied by the composition root, never a JWT header. */
  verificationKey: webcrypto.CryptoKey;
  issuer: string;
  audience: string;
  maxTokenAgeSeconds: number;
}>;

const controls = /\p{Cc}/u;
const identifier = (value: unknown, limit: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= limit && value.trim().length > 0 && !controls.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function trustedTime(now: () => Date): Date {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('invalid_auth_clock');
  return new Date(date.getTime());
}

/** Offline verification only. Does not provision accounts, fetch keys, or issue credentials. */
export function createSessionVerifier(db: Database, config: SessionVerifierConfig): SessionVerifier {
  const key = config?.verificationKey;
  if (!(key instanceof CryptoKey) || key.type !== 'public' || key.algorithm.name !== 'ECDSA'
    || !('namedCurve' in key.algorithm) || key.algorithm.namedCurve !== 'P-256'
    || !key.usages.includes('verify') || !identifier(config.issuer, 500)
    || !identifier(config.audience, 2048) || typeof db.now !== 'function'
    || !integer(config.maxTokenAgeSeconds) || config.maxTokenAgeSeconds < 1 || config.maxTokenAgeSeconds > 900) {
    throw new Error('invalid_auth_config');
  }
  const { issuer, audience, maxTokenAgeSeconds } = config;
  const now = db.now.bind(db);
  trustedTime(now);
  return async token => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null;
    const currentDate = trustedTime(now);
    const nowSeconds = Math.floor(currentDate.getTime() / 1000);
    let verified;
    try {
      verified = await jwtVerify(token, key, {
        algorithms: ['ES256'], issuer, audience, typ: 'at+jwt', currentDate,
        clockTolerance: 0, maxTokenAge: maxTokenAgeSeconds,
        requiredClaims: ['iss', 'aud', 'sub', 'sid', 'iat', 'nbf', 'exp'],
      });
    } catch (error) {
      if (error instanceof errors.JOSEError) return null;
      throw error;
    }
    const { payload, protectedHeader } = verified;
    if (protectedHeader.typ !== 'at+jwt'
      || ['jku', 'jwk', 'x5u'].some(field => Object.hasOwn(protectedHeader, field))) return null;
    if (Array.isArray(payload.aud) && !payload.aud.every(value => identifier(value, 2048))) return null;
    const { sub, sid, iat, nbf, exp } = payload;
    if (!identifier(sub, 200) || !isUuid(sid) || !integer(iat) || !integer(nbf) || !integer(exp)
      || iat > nowSeconds || nbf > nowSeconds || exp <= nowSeconds || exp <= iat
      || exp - iat > maxTokenAgeSeconds || nbf < iat || nbf >= exp) return null;
    // Every request rechecks revocation and identity ownership. The chat transaction
    // repeats the session check under lock before accessing any private resource.
    return db.transaction(async tx => {
      const { rows } = await tx.query<{ userId: string }>(`
        SELECT i.user_id AS "userId"
        FROM auth_sessions s
        JOIN auth_identities i ON i.issuer = s.issuer AND i.subject = s.subject AND i.user_id = s.user_id
        JOIN users u ON u.id = i.user_id
        WHERE s.id = $1::uuid AND s.issuer = $2 AND s.subject = $3
          AND s.revoked_at IS NULL AND s.expires_at > $4::timestamptz
          AND floor(extract(epoch FROM s.created_at)) <= $5::double precision
          AND s.created_at <= $4::timestamptz AND u.deleted_at IS NULL
      `, [sid, issuer, sub, currentDate.toISOString(), iat]);
      if (rows.length !== 1 || !isUuid(rows[0].userId)) return null;
      return { userId: rows[0].userId, sessionId: sid, tokenExpiresAt: exp };
    });
  };
}
