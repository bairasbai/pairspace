# Shared text memories: verification candidate

## Scope and provenance
Baseline local d8ff565da46704d38e6330f368895de5ef618cd7,
tree 898963ac86a0838a9a4b01e94625dcd52afec836, isolated implementation.
Source migration map distinguishes shared chronology `/talk/moments` from the
blind-answer diary `/us`. This slice implements explicit shared text memories,
not full diary parity. See [contract](SHARED_MEMORIES.md).

## Acceptance scenarios
- Current active partners create and read a title/body/date-only entry, with
  authorship and separate server creation timestamp, using real HTTP/SQL paths.
- Private draft remains RAM until explicit partner-visibility confirmation.
- Immutable actor/command receipt replays the same normalized payload once;
  changed payload conflicts and uncertain ACK retries the original command.
- A newer draft survives an older command ACK, including clear-and-retype ABA.
- Pair/user/session/epoch changes scrub data and invalidate pending callbacks.
- Two pairs, former membership, stale epochs, expired/revoked sessions, malformed
  strict bodies, Unicode bounds, and deterministic latest-50 list are covered.
- No conversion of private letters, blind answers, chat or activity to memories.
- Immutable records expose no edit/delete endpoint; limitations are visible.

## Verification protocol
Full checkpoint uses the existing fail-closed scripts/verification runner on a
clean frozen commit. All eleven required steps must PASS; the raw machine-readable
report is retained outside Git and records exact SHA/tree/source hash, isolated
runtime, per-step exits, coverage metrics and explicit NOT_RUN limitations.
Dependencies are existing pinned physical copies; no external install/deploy.
Scratch TMPDIR and isolated HOME avoid shared tmpfs/cache and Metro is bounded.

Status: implementation candidate, not independently accepted. Exact frozen commit
and full report are delivered to the coordinator before independent review and
any authorized publication. Documentation does not claim tests passed in advance.
Root legacy Next typecheck/build, native iOS/Android device execution, two-device
E2E, E2EE and production security/readiness are NOT_RUN or not established.
Expo JavaScript export is not a native build. No production/personal data is used.

## Implementation checks (before freeze)
- Focused mobile: 90/90 tests passed; mobile typecheck and full lint passed.
- API/domain full coverage: 254 tests in 37 files passed; statements 99.40%,
  branches 98.81%, functions 100%, lines 99.92%. Later composition test additions
  require the frozen rerun rather than inheriting this earlier result.
- Real PostgreSQL and final all-eleven checkpoint are recorded in the external
  exact-SHA report, not inferred from focused unit/component passes.

## First PostgreSQL diagnostic and correction
The pre-gate candidate 0afbbb7 failed 3 of 202 real PostgreSQL tests (199 passed).
All three failures were new composed HTTP/mobile memories scenarios: the shared
composed-fixture helper omitted forwarding the independent memories opt-in, so
requests reached the correctly default-disabled 404 route. SQL/domain and race
checks passed. The fixture now forwards the flag explicitly; no production guard
is weakened. The failed raw log is retained outside Git. A replacement freeze
must pass all eleven stages, including the entire real PostgreSQL suite.
