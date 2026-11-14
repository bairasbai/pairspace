# Private verification log retention
Approved diagnostic-only candidate from accepted6b5c72b13f7b9a6ec1c288a5b4ef7f9fcdaf7c28.
Implementation and independent acceptance pending; no product behavior changes.

Repeated author/independent mobile exit1 had validcoverage and no outertimeout,
but the runner intentionally discarded stdout/stderr. Later exact diagnostics and
whole retries PASS do not establish the original failure cause. Next failed FULL
must retain original evidence, not require a different run to guess the cause.

Minimal change to verification process/runner only, no production module edits:
- A fresh private logs directory inside each verification output, mode0700.
- Separate full raw stdout/stderr files for each executed step, exclusive create,
  mode0600; filenames generated internally from numeric step index, not arbitrary
  external paths or test content. Empty streams create empty files. Skipped steps
  explicitly have no child log, not a fabricated empty successful execution.
- Stream directly to file while computing exact total byte count/SHA256.
  Approved safeguard:16MiB per stream. Retain the prefix up to that bound; on
  overflow keep draining and hashing every byte, mark incomplete/limitReached and
  evidenceFAIL even if child exits0. Exact boundary is complete, overflow is not.
  No unbounded memory accumulation or inline raw content in report. Report contains
  relative paths, total/retained bytes, full-stream hashes and capture flags.
- Errors opening/writing/closing logs are sanitized errors and cannot yield PASS.
  Continue draining/hash streams under unchanged existing process deadlines and
  cleanup. Preserve actual process exit/signal/status separately from evidenceFAIL.
  Report incomplete capture; never silently classify discarded output as complete.
- Preserve logs for exit1, timeouts, interruptions and cleanup failures. No automatic
  retry, no reclassification of earlier failures, no tests hidden from evidence.
- Existing command/args/env allowlist, source guards, deadlines, grace/kill behavior,
  step ordering, coverage floors, test selection and assertions unchanged.
- Logs are local private diagnostic artifacts, may contain synthetic test bodies;
  not public summaries or automatic uploads. Never ingest real secrets/production
  data into tests; existing credential-free environment stays identical. No claim
  of redacted raw content. Report itself still must not serialize payloads/secrets.
- Coordinator checks adequate disk before starting: the >=1GiB free-space gate
  remains external and is not implemented by this runner patch. Never delete evidence to
  make a failed run appear clean. Storage-error regression proves no falsePASS.

Tests: exact stdout/stderr byte equality and digest across chunks, empty output,
exit1, timeout/interruption evidence, private permissions/exclusive files/path safety,
open/write/close error behavior, no report rawcontent, exact args/env/profile unchanged.
Independent early actual review before freeze; runner unit/coverage and fullauthor11,
then independent11 on exact SHA, source archive byte restored. No heavy parallelruns.
This is a standalone diagnosability checkpoint before next user-facing P1, not a
claim that the unexplained original mobile failure has been fixed.

## Timing and interruption limits
Synchronous bounded writes add I/O latency without changing child commands or
existing budgets. Capture completion is recorded only after stream close plus
fsync/one close attempt. A failed close has uncertain OS state and is NOT retried
against a potentially reused descriptor. Evidence remains incomplete/failed.
Hard kill or cloud interruption may leave unindexed partial files and a RUNNING
report; this is not crash-proof capture or final acceptance evidence.

## Focused implementation checkpoint
42 tests across9 suites PASS; runner coverage97.75/94.68/95.55/100.
Actual child processes verify binary files, default16MiB boundary and overflow,
exit0 plus IO/cap failure, interruption/spawn errors, private paths and preserved
full hashes. Close-once regression keeps an unrelated reused descriptor open.
This is a focused candidate result, not final independent acceptance.
