# Signed-token verification prototype, not a login system

This slice uses `jose` 6.2.17 (MIT, official npm package) for cryptographic JWT verification.
It does not issue tokens, generate runtime keys, call an identity provider, fetch JWKS, create
accounts, persist secrets or implement signup/login/refresh-token rotation. Tests generate ephemeral
in-memory signing keys and synthetic identities only. Nothing has been deployed.

## Trusted configuration
`createSessionVerifier(db, config)` requires a trusted public verification key, issuer, audience and
bounded token age. Algorithm is fixed ES256; token-supplied key material or URLs are never used.
The database adapter supplies a mandatory trusted clock. Signature, issuer, audience, subject,
session ID, typ and numeric time claims are validated before an identity lookup. Zero clock tolerance
is intentional in this prototype. Configuration/key rotation is not a user request parameter.
Invalid credentials return null/opaque401; unexpected database/configuration failures must not be
represented as successful authentication or disclose SQL/token details. HTTP catches unexpected errors.

## SQL mapping and final transaction enforcement
Migration002 adds identity mapping `(issuer,subject) → user_id`, sessions bound to that exact identity,
and user soft deletion. No body-supplied user ID is trusted. Principal now contains mapped user ID,
verified session ID and token expiry; no runtime user-only fallback exists.

Verifier lookup alone is NOT sufficient. Each send/history/close transaction locks and rechecks:
1. User row FOR SHARE, reject deleted/missing user.
2. Session row FOR SHARE, reject wrong owner, missing/revoked/not-yet-created/expired session.
3. Trusted clock and verified token expiry, then couple lock and membership/epoch checks.

All future account/session revokers must use the same lock order: user → session → couple.
A successful revocation completed between signature verification and transaction entry is rejected
by the final check. Revocation that waits behind an already-authorized transaction takes effect for
subsequent transactions. Token/session expiry is an authorization-time snapshot after session lock,
not a promise that a long transaction is cancelled exactly at expiry. A transaction may commit after
that instant; bounded transaction deadlines and a decided stricter policy are release prerequisites.
Session/identity mutable ownership is unsupported; administrative mutations require explicit review.
PGlite tests do not prove concurrent multi-session PostgreSQL lock behavior.

## Client semantics
Opaque401 pauses and preserves text/client IDs, including expired or revoked credentials, without
claiming membership revocation. Opaque403 also pauses. Only trusted explicit revoke/logout clears.
Credential generation must advance on every credential refresh. See TRANSPORT.md for pause/requeue
coordination, trusted revalidation and delayed-response safety. No automatic login/resume is provided.

## Remaining release gates
Real auth provider, signup, secure token storage, refresh/reuse detection, key/JWKS rotation policy,
account/session management endpoints, RLS/roles, database adapter, migrations/backfill, monitoring,
rate limits, TLS/network perimeter, timeout policy, native/two-device tests, penetration review and
independent acceptance remain. This is a verified test slice, not a production auth claim.

Session creation comparison uses floor(epoch created_at) against integer JWT iat, plus a separate
created_at <= trusted current time check. Same-second fractional timestamps are valid only once
the session actually exists in server time; future milliseconds are rejected.
