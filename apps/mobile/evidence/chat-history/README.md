# Chat history verification — 2026-11-10

Local implementation, independent acceptance pending. Synthetic fixtures only.
The source commit/tree are recorded by the handoff outside this file to avoid a
self-referencing commit hash. No GitHub push, deployment or native acceptance here.

## Passed

- Mobile Jest: 29 suites, 950 tests. Full configured collection includes unimported
  production files and shared domain; thresholds unchanged at 90% all four metrics.
  Statements 97.55%, branches 97.43%, functions 98.28%, lines 98.11%.
- Mobile TypeScript and ESLint.
- iOS and Android Expo/Hermes JS exports, 632 and 631 bundled modules respectively.
  Existing exact-lock mobile dependencies were copied locally because the borrowed
  symlink was outside Metro resolution. No dependencies/manifests were changed.
- Root domain tests: 9/9.
- API unit/coverage: 24 files, 176 tests; statements 99.78%, branches 99.70%,
  functions 100%, lines 99.85%. API TypeScript and ESLint.
- Disposable real PostgreSQL: 89/89 passed, including literal 9/10 and 99/100
  boundaries plus sequence gaps, 125/80 rows in separate pairs and 70 new rows
  before refresh. Numeric-order mutation: old SQL fails (exit 1), fixed SQL passes
  (exit 0). See postgres.log, numeric-order-mutation.log, numeric-order-fixed.log
  and postgres-findings.md; the old failure log is not the final run.

## Regression finding

The old SQL projected seq::text AS seq then ORDER BY seq DESC, sorting the text
alias lexicographically. Qualifying chat_messages.seq repairs numeric ordering.
postgres-before-order-fix.log preserves the genuine failure that exposed the bug;
it is not the final run. Numeric regression covers decimal digit boundaries and
noncontiguous sequences. Failed intermediate expectations were corrected to the
API's established 409 stale-membership response, not a fabricated 403 contract.

## Failed / unavailable / not run

Root Next.js typecheck could not run: prepared root node_modules resolves to an
empty directory and tsc is absent. Root web sources were not changed; no typecheck
pass is claimed for that surface. Mobile and API have separate successful gates.

No physical iOS/Android runs, native builds, device scroll/keyboard/offline testing,
SecureStore execution, production, real personal data, realtime, message deletion,
read/delivery receipts or E2EE. Renderer tests and JS export do not replace them.

Captured logs have trailing whitespace normalized for a clean diff.
