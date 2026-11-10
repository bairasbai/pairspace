# Typed session authority in the API core

Status: implemented, author checks passed; pending independent review. This is product-core source integration, not a released login system or a deployed API.

## Selection and trusted composition

`bindSessionAuthority(database, authority)` is mandatory before calling the chat handler/use cases. Exactly one authority is selected. Principals carry a source tag; mismatched or missing authority fails closed. No cookie→JWT, Better Auth→auth_sessions or verifier-error fallback exists.

- `createSyntheticAuthority(verify)` explicitly selects the existing signed-token/test prototype and its auth_sessions recheck. Tests opt into it. It is not automatically chosen by the handler.
- `createBetterAuthAuthority(database, {getSession, trustedOrigins})` binds an official Better Auth getSession reader from the **same trusted PostgreSQL database/schema**. The integration fixture passes `headers => auth.api.getSession({headers})`, with cookie cache disabled. Only cookie transport and explicitly trusted exact Origin/Expo-origin are accepted. Bearer credentials are rejected on this authority.
- No service bootstrap automatically enables this provider. Existing mobile bearer transport is unchanged. A controlled composition/frontend migration remains separate work.

Provider output is runtime-validated. The provider user maps to an independent domain UUID using migration 003's better_auth_identities table. This is an identity map, not a second session store. Mapping mutations are unsupported until reviewed. No production account provisioning/backfill is included.

## Transactional source of truth

The existing send/history/close code, sequencing, deduplication, membership checks and content-free outbox remain unchanged except for the session authority boundary. Each existing transaction rechecks domain user → Better Auth user → **the same Better Auth session row** → identity mapping, then the existing couple/membership lock protocol. Provider tables use default fixed names "user" and "session" in the trusted pool search_path, shared with domain tables. Untrusted schema/table selection is not supported.

PostgreSQL clock_timestamp() is sampled after acquiring the session lock. Session ownership, createdAt, expiresAt, domain soft deletion and mapping are rechecked. The principal expiry is conservatively floored to seconds, so it may reject up to 999ms early; the database expiry is also checked. It never extends validity.

A completed revoke blocks subsequent send/history/close. If the product transaction holds the session FOR SHARE lock first, official Better Auth revoke DELETE waits until the already-authorized transaction finishes. This behavior is demonstrated on real PostgreSQL 18.6. It is not a complete account-deletion/reset/linking lock protocol or proof of every provider operation.

## Verification

- API TypeScript strict and ESLint.
- Existing and new unit/SQL tests, with unchanged ≥90% statements/branches/functions/lines thresholds. Coverage includes all src files and packages/domain, including unimported files.
- Real PostgreSQL product tests import services/api/src directly, not copies of use cases. Official signup/signin/getSession/revoke feed the product handler/use cases. Tests cover pair isolation, sender mapping, replay/history/close, exact session-row revoke race, expiry/deletion/missing mapping/source mismatch, and message+sequence+outbox rollback.
- Test fixture leaves auth_sessions empty in Better Auth mode. Real credentials and users are never used.
- Synthetic runtime/safety regressions retain PG* sanitization, database marker guards, task/barrier failure observation, operation/cleanup timeouts and outer runner deadline.

Run `npm ci --ignore-scripts` in services/api, then `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:safety`, `npm run verify:postgres`. Existing transport tests import unchanged mobile TypeScript and require apps/mobile dependencies for Expo tsconfig resolution; install their existing lockfile without changing source if absent. PostgreSQL runner supports Linux x64 and GNU timeout. It uses pinned @embedded-postgres/linux-x64 18.6.0-beta.19 from npm, a third-party packaged PostgreSQL 18.6 distribution, not an official PostgreSQL binary release. Runtime symlinks are validated before hydration; lifecycle scripts otherwise stay disabled. No binary is included in this source change.

Test PG runs only on ephemeral 127.0.0.1 TCP, with synthetic SCRAM credentials. All inherited PG* variables are removed; the JS config rejects surviving keys. No existing services/secrets or persistent grants. Runtime role is superuser only inside the disposable test cluster. Native-library CVEs are not covered by npm audit. Production roles/RLS, TLS, migration/backfill, provider lifecycle/transaction timeout policy, rate limits, native SecureStore and two-device tests remain open.

No frontend change, production deployment, main-branch change or ready-login claim. Parent maintains top-level Map/Memory/ROADMAP because this task is scoped to services/api.


## Recorded result for this revision

97 unit/SQL tests, 8 harness-safety tests and 5 live PostgreSQL product groups passed. Strict typecheck and ESLint passed. Coverage: statements 99.66%, branches 99.38%, functions 100%, lines 99.54%; original thresholds remain unchanged. Evidence is under evidence/auth-authority.

Dependency audit reports 10 moderate findings in the existing ESLint/typescript-eslint/minimatch toolchain, 0 high/critical. No automatic dependency rewrite was applied. This is not a clean audit/security-clearance claim. New pinned dependencies are Better Auth 1.7.19, pg 8.23.1, @types/pg 8.23.1 (MIT), and the test-only third-party packaged PostgreSQL runtime described above. Existing lockfile package versions were not upgraded as a side effect. Runtime-package signature verification was established in the preceding accepted PostgreSQL experiment; full-graph signatures are not claimed verified.
