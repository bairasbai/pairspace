# Synthetic HTTP → Better Auth → SQL experiment

2026-11-10. Status: author checks passed; **pending independent acceptance**. Separate from the previously reviewed `better-auth-spike` checkpoint. No product source changes, publication or deployment. All network traffic is loopback `127.0.0.1` on an ephemeral port. No live accounts, user data, persistent secrets or external services.

## What this adds

- Official `better-auth/client` → real Node HTTP requests → official `toNodeHandler` adapter → Better Auth SQL tables.
- Official `@better-auth/expo` server plugin remains enabled, both auth packages pinned at 1.7.19. This stage is a **Node client transport test**, not a native Expo client test.
- Disposable in-memory SQLite; schema generated through official migrations API.
- Minimal protected POST `/pairs/:pairId/messages` resolves Better Auth user/session, maps the auth user to an independent domain UUID, and checks current couple membership before writing synthetic text.
- Single authoritative session table is Better Auth `session`. There is no duplicate session table, JWT fallback, custom token issuer, refresh-token implementation or client-supplied identity.

## Checks

`npm test`: six groups, all passed: four HTTP/auth/domain groups plus two audit-script regression groups.

1. Actual signup, signin, wrong password, session lookup, session revoke and logout through official client HTTP transport. Anonymous request returns 401. Pair A/B cross-access returns 403. Body userId spoofing returns 400. Valid writes persist the mapped domain UUID, not the auth ID or supplied body identity.
2. Deterministic barrier between getSession and domain transaction: a completed revoke through a separate HTTP session makes the pending write fail 401; no message is inserted.
3. Membership removal, expired session, future-created session and malformed expiry after initial resolution are caught by the final transaction check; no message is inserted.
4. Untrusted origin fails 403. Injected SQL insert failure returns opaque 500, rolls back, stores no message and permits a later valid write after the test fault is removed.
5–6. Audit helper accepts valid exit 0/1 reports and fails closed on network/error report, invalid JSON, malformed metadata/counts and operational exit codes.

`npm run check`: Node syntax checks passed. This new server harness is JavaScript; no claim of strict TypeScript verification for it. The earlier separate Expo client typecheck/export evidence remains valid for that earlier artifact only.

`npm audit`: 5 moderate findings in inherited Expo/tooling dependency graph; 0 high, 0 critical. Real audit output passes the hardened audit validator. This is not a clean audit or security clearance. Dependencies intentionally retain the reviewed exact Expo/Auth baseline instead of introducing unreviewed dependency churn.

## Transaction and race policy

Initial `auth.api.getSession` authenticates signed cookies. Before any domain write, a synchronous SQLite `BEGIN IMMEDIATE` transaction rechecks the **same authoritative session row**, exact user ownership, existing auth user, expiry, creation time, identity mapping and active membership. The transaction contains no await. Server time is sampled once at transaction entry.

The pinned Better Auth SQLite adapter stores createdAt/expiresAt as **ISO text**. This was confirmed experimentally. The first implementation incorrectly compared those values to epoch milliseconds and failed positive tests; it was corrected to parse/validate the actual date representation. Tests cover expiry, future creation and malformed date rejection. Date-format assumptions must be reviewed if the adapter changes.

Policy: revocation completed before transaction entry blocks the write. A transaction already authorized and completed may commit before a later revocation; later requests fail. Expiry is evaluated at the transaction snapshot, not a promise of cancelling an in-flight operation at the exact expiry instant. Membership is rechecked in that same transaction and its current epoch is recorded with the synthetic message.

**This does not prove PostgreSQL concurrency, row-lock ordering, multiple-process isolation or real races between database connections.** The barrier proves ordering in a single-process SQLite harness. A production adapter needs shared transaction semantics with the revoker, defined user → session → couple lock order, timeout policy and independent multi-connection PostgreSQL tests before replacing the existing jose/auth_sessions prototype.

## Deliberate test boundaries

- Client cookie jar is a test-only Node transport fixture. It is not SecureStore, a browser cookie security model, or an Expo native runtime.
- Test client enforces destination origin equals the exact loopback fixture; server binds only 127.0.0.1.
- Domain identity/membership provisioning is a fixture-only SQL helper, not a public account creation or pairing endpoint.
- Pauses and fault injection are constructor/test helpers, not remotely accessible controls.
- Synthetic message endpoint is not the Pairspace production send implementation: no idempotency, attachments, history, outbox, full validation or existing domain integration is claimed.
- No browser/native/physical-device/two-device test, OAuth, email verification, recovery, MFA, SecureStore persistence, TLS, production origin/cookie policy, deployment monitoring, migration/backfill, or load/penetration test.
- No production coverage threshold claim. This is an isolated integration experiment, not the complete application's production code.

## Reproduce and artifacts

Node 24.22.1, npm 11.9.0. Run `bash verify.sh` with official npm access. It installs the pinned lockfile with lifecycle scripts disabled, runs checks/tests, then validates audit output. Tests open only ephemeral loopback ports and close servers/databases.

Sources: src/server.mjs, tests/http.test.mjs, scripts/audit.sh, scripts/validate-audit.mjs, tests/audit.test.mjs. Logs: evidence/test.log, check.log, audit.json, audit-validation.log. Exact artifact identity: evidence/SHA256SUMS. No source file exceeds 600 lines. Accepted previous-stage archives are unchanged.
