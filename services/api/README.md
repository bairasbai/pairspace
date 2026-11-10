# SQL-backed chat use cases (test-only, no HTTP server)

This package contains real PostgreSQL-compatible SQL and application use cases. It is not a
running API or authenticated service. No production connection, secrets, real users or deployment.

Current composed-runtime milestones: [API_COMPOSITION.md](API_COMPOSITION.md), [SESSION_CONTEXT.md](SESSION_CONTEXT.md), [PROFILE_PROVISION.md](PROFILE_PROVISION.md), [WAITING_SPACE.md](WAITING_SPACE.md), and [PAIR_INVITATIONS.md](PAIR_INVITATIONS.md). Explicit synthetic profile, waiting-space creation and invitation issuance/revocation are independently disabled by default and restricted to loopback configuration. The baseline checks and missing-adapter statements below describe the original SQL-core milestone, not the latest composition.

## Implemented
- `sendMessage`: normalize text, check trusted principal's current active membership, allocate server
  sequence, persist one message and one outbox reference in the same transaction.
- Scoped idempotency `(couple_id,sender_id,client_message_id)` survives database reopen.
  Same ID plus different normalized text is a conflict. Replays do not allocate a new sequence/event.
- `readHistory`: authorized SQL reads with bounded sequence pagination, ascending within each page.
- `closeCouple`: lock couple, revoke both memberships, advance epoch, create a content-free event.
  It stops interactions but **does not delete the archive** or decide final retention/export policy.
- Schema: composite couple FKs, two slots, one active pair per user, deferred constraint triggers
  requiring exactly two active members for an active pair, normalized text/sequence checks.
- No body column/payload in outbox. Its future worker must reload and reauthorize current state.

## Trust and integration boundary
`Principal` is supplied only by a future authenticated server adapter. A client-provided user ID is
not authentication. The in-process HTTP prototype requires an injected verifier; it never accepts a body identity as authentication.
The jose verifier and SQL session recheck are a prototype, not a login/provider/session-management system.
See AUTH.md and TRANSPORT.md for the tested boundaries.
Request `senderId`/`userId` fields cannot override the principal. Every use case queries membership.
This is not a complete production security boundary: database roles/RLS, production auth lifecycle,
rate limits, audit policy and transport are still missing.

A future PostgreSQL driver must implement `Database.transaction`, pin one connection from BEGIN
through COMMIT/ROLLBACK, and parameterize queries. An error must rollback all writes; never swallow it.
PGlite implements this interface only in tests and is a devDependency, not the production DB choice.
Canonical errors returned by use cases contain no message content; unexpected driver errors must be
redacted by the future transport and never surfaced verbatim or logged with parameter values.

The internal send command uses clientId as its deduplication identity. The prototype HTTP adapter requires Idempotency-Key to equal that clientId.
The future v1 adapter must preserve that mapping or introduce a separately tested key mapping.
History uses an internal beforeSeq number; a future HTTP adapter supplies the documented scoped
opaque cursor. Numeric sequences are bounded by SQL to JavaScript's safe integer range.
No editing/deletion-of-messages/receipts/history-sync protocol is implemented in this package yet.

## Transactions and concurrency
After user/session locks and revalidation (AUTH.md), send and close lock the same couple row `FOR UPDATE`; membership is checked in a separate SQL statement after that lock, so READ COMMITTED
obtains a fresh membership snapshot after any lock wait (never a joined pre-lock snapshot).
History holds `FOR SHARE` on the couple until its read finishes. All future membership/status writers
must use the same lock order: user → session → couple → members → messages/outbox. External direct writes are not allowed.
Use PostgreSQL READ COMMITTED or implement tested retry for serialization/deadlock failures.
A history result is an authorized snapshot at read time, not remotely retractable content.

PGlite 0.5.16 reports PostgreSQL 18.6 (WASM), embedded and single-connection. Tests verify actual SQL, constraints, atomic rollback
and disk reopening, but **cannot prove multi-session races, lock wait behavior or production throughput**.
Before a real server release run multi-connection PostgreSQL tests: simultaneous sends with one key,
send-versus-close, history-versus-close, concurrent invitation/member changes and worker claims.
Do not claim the race strategy has been proven by these tests.

## Migration
`migrations/001_chat.sql` is a one-time migration. Tests apply its whole body inside a transaction.
A production migration runner/version table, database role policy, rollback/recovery strategy,
existing-data backfill and staging migration review are not supplied here. Do not run this on Tan Ata.
The small users table is a placeholder identity reference, not an account system.

## Shared domain code
`packages/domain/chat/text.ts` is the one normalization implementation for mobile and API.
NFC, canonical newlines, nonblank, ≤8,000 Unicode codepoints, valid surrogate pairs.
NUL is rejected because PostgreSQL text cannot represent it. It was added to both test suites.
No copy of the normalizer exists in mobile; the compatibility module only re-exports it.

## Commands
From this directory, on Node 22.18+:
- `npm ci`
- `npm run lint`
- `npm run typecheck`
- `npm test`

This iteration used Node 24.22.1. Tests use synthetic data only; the persistence test creates and
removes its own temporary directory. No network listener or authentication endpoint is started.

## Verification, 2026-11-10
- 65 SQL/use-case/HTTP/signed-auth/client integration tests passed, including reopen from disk and injected outbox failures.
- All executable API source and shared domain source are included in coverage, including unimported files.
  99.35% lines, 100% functions, 99.52% statements and 99.08% branches for this small slice; contracts.ts is type-only.
- SQL constraint checks are tested directly; SQL is not counted as TypeScript coverage.
- Mobile regression: 184 tests, 100% lines/functions/statements, 99.43% branches; lint/typecheck and Hermes export passed.
- Root existing code: typecheck and 9 tests passed. No whole-repository coverage claim.
- No actual PostgreSQL daemon, concurrent sessions, native simulator/device, E2EE or independent acceptance of this auth revision yet.

## Dependencies and advisories
PGlite 0.5.16 (Apache-2.0), Vitest/coverage 5.1.0 (MIT), TypeScript 5.9.3 (Apache-2.0),
Node types (MIT), ESLint 10.14.0 / typescript-eslint 8.72.2 (MIT) are development-only.
The verifier adds runtime jose 6.2.17 (MIT); use cases otherwise remain dependency-free. npm lockfile license fields were inspected: no missing values;
MIT, Apache-2.0, BSD-2/3-Clause, ISC, MPL-2.0 and BlueOak-1.0.0 occur in the dev toolchain.
Do not redistribute toolchain binaries without checking their notices/license obligations.

Audit counts are dynamic registry snapshots, not a fixed guarantee. On 2026-11-10 the independent
reviewer reported 11 moderate findings; a fresh local npm audit at 05:54 UTC returned 10 moderate,
zero high/critical/low. Findings concern ESLint/typescript-eslint/minimatch tooling chains.
The initial package before lint tooling had zero findings. Re-run audit in CI and before release.
Advisory: https://github.com/advisories/GHSA-g3hv-75wg-m249
No forced downgrade/override applied. Treat tooling inputs as trusted repository files and track
upstream updates before CI on hostile submissions. This is not a clean security release report.

Auth dependency audit snapshot, 2026-11-10: `npm audit --omit=dev` reports zero findings;
full tooling audit reports 10 moderate, zero high/critical. jose 6.2.17 MIT is pinned.
This does not replace independent security review or future registry rechecks.

Independent reviewer audit snapshot on 2026-11-10 reported 11 moderate tooling findings versus
the author's 10; runtime remained zero. Counts are dynamic registry snapshots, not fixed guarantees.

Synthetic invitation preview/acceptance is independently default-disabled and loopback-only; see [PAIR_ACCEPTANCE.md](PAIR_ACCEPTANCE.md). It reuses existing migrations, with no mobile integration, delivery or production enablement.
