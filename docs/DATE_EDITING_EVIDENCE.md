# Shared-date editing candidate

## Scope
Synthetic connected mobile only, default App remains demo. Existing active partners
can explicitly edit a shared date's title, calendar label, exact IANA zone, recurrence
and leap-day policy. No reminders/push, deployment, personal data, E2EE, native build
or post-breakup archive decision is introduced. Data remains server-readable plaintext.

## Acceptance contract
- PATCH a scoped resource with immutable actor/command receipt and expected version.
- Authorize fresh session, active pair and membership epoch before all access/replay.
- Concurrent same-version edits accept only one; the other requires explicit refresh.
- Historical successful create/edit retry returns the current canonical resource,
  never reinstalls old content. Receipts preserve submitted payload and expected version.
- UI selection only copies a draft. Saving explicitly changes the date for both.
- Unknown outcome retries identical target/version/payload; new draft survives ACK.
- Conflict preserves draft; refresh and explicit selection required before rebasing.
- Cancel clears draft/selection, not already-submitted command. Session/pair/epoch
  invalidation scrubs state and prevents late callbacks from restoring data.
- Annual February 29 still requires an explicit non-leap policy; no guessed defaults.

## Verification protocol
Focused mobile date suite: 153/153 passed during implementation. Mobile typecheck
and lint passed after test fixtures were updated. Full frozen-commit verification
must use scripts/verification with physical pinned dependencies, scratch TMPDIR,
sequential steps and bounded Metro workers. Runner output stays outside tracked tree.
The full report identifies exact SHA/tree/source hashes, per-step outcomes and all
four coverage metrics, including unimported own production source.

Status: candidate, not independently accepted. Coordinator receives frozen SHA and
full runner report before publication. Root legacy Next typecheck/build, native
Hermes/device execution and two-device E2E are NOT_RUN. JS export is not native build.

## First full gate and regression correction
Frozen candidate 4c86e63 failed real PostgreSQL integration while the other ten
required stages passed. Diagnostic rerun: 190/191 PostgreSQL tests passed; the
mobile edit remained version1 because the composed application perimeter rejected
PATCH with405 before the date handler. Handler-only tests did not exercise that
perimeter. The fix admits PATCH only for enabled date-item paths, retaining origin,
JSON and body-limit checks, with composed-routing regression coverage. This failed
candidate is not accepted. The replacement frozen commit must rerun all eleven
required stages; no failure is masked by a later successful shell command.
