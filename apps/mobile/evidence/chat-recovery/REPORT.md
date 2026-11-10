# Chat recovery verification — 2026-11-10

Status: author checks passed; independent acceptance pending.
Source baseline: local 3ae242b, tree identical to published
06250f13ddc1aba449938c3ff57f58e67a8e1717 (tree 1b98909964b674e89bf2f566894cfe8f47139d79).
No GitHub writes, deployment or production changes performed.

## Passed

- Mobile: 885 tests, 26 suites. Coverage statements 97.36%, branches 97.31%,
  functions 98.05%, lines 97.82%. Includes all configured own runtime sources,
  including files unimported by tests; thresholds unchanged at 90% each.
- API: 175 tests, 24 suites. Coverage 99.78/99.70/100/99.85% respectively.
- Disposable real PostgreSQL 18.6: 87 tests, no skips. Uses official provider auth,
  real loopback HTTP and isolated synthetic records. Lost response after COMMIT
  followed by explicit replay leaves exactly one message and one outbox record.
- PostgreSQL fixture safety guards: 8 tests. Root domain tests: 9 tests.
- Mobile/API TypeScript and ESLint.
- Default preview and temporary auth-import Expo exports: both iOS and Android.
  The build-only entry imports/exports createSyntheticRuntime and registers a null
  component; it does not construct a client or embed a server configuration.
  package.json restored and temporary entry removed after export.
- Whitespace diff check; changed handwritten files below 600 lines.

Mobile recovery regressions include transient discovery/history/send failures,
unknown ACK and canonical replay, NFC/newline normalization, edited draft and
A→B→A revision retention, repeated taps, concurrent refresh/send, stale denials,
scope changes, logout, late results, screen unmount, actual StrictMode effect replay
and controller replacement, including immediately disposed queued SDK auth actions. No automatic retries or background storage introduced.

## Review correction

Independent review rejected the initial local commit: an auth callback queued by
signIn could call SDK signOut after immediate disposal. Both serialized signIn and
signOut now check generation before starting external cleanup. Three regression
cases cover queued login/logout disposal and a replacement controller sharing the
SDK. Already-started SDK requests cannot be cancelled; late local results are ignored.

All new machine logs have trailing whitespace removed; the final base-to-HEAD diff
is checked, not only the unstaged working diff. API rerun uses an isolated Vitest
filesystem cache: `npm --prefix services/api test -- --fsModuleCachePath
/tmp/pairspace-chat-recovery-final-vitest-cache`. Shared dependency cache artifacts
from other worktrees are not source-code evidence.

## Environment corrections

Expo initially could not create its default home cache. Retried with an isolated
writable /tmp home, telemetry disabled and offline bundling; both exports passed.
API dependency symlink initially failed the PostgreSQL harness's safety guard.
Used a package-local dependency copy and reran without modifying those guards.
No dependencies, generated bundles or temporary runtime data are part of the source.
Logs are machine-generated artifacts and exempt from the handwritten line limit.

## Not run / not claimed

No physical device/simulator interaction or native build; renderer tests and JS
exports are not native acceptance. Real SecureStore, keyboard/network switching,
two physical devices, production auth/deployment, durable draft persistence after
restart, realtime, receipts and E2EE remain outside this bounded synthetic slice.
No independent acceptance is claimed by this author report.
