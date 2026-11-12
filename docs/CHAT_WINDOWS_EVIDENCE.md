# New connected chat windows checkpoint

Base: independently recovered public GitHub commit5a99816262b8f379f2bdad3df7effd4143c002f7, treee6c0a3476be8ef4ec207d3ed98e6f0db8befb0e2. This is new implementation on that base, not recovery of missing later commits or their test results.

## Scope

The base already has authentication, verified server context, connected sending, lost-ACK retry and older history. Its mobile history stops at200 records. This slice replaces that UI limit with explicit50-message windows: older, newer, oldest and latest. It does not accumulate all prior pages. The existing /chat/messages send/history protocol remains unchanged; a separate opt-in /chat/history-window route carries nonce-echoed results and actual scoped message-ID/sequence anchors.

Sequence gaps are valid. Each window uses native numeric sequence ordering, not timestamp or row counts. The pair's lock and current session authorization precede anchor lookup, messages and edge flags; ID+sequence must identify a row in the authorized pair. Another pair's cursor cannot silently adopt a same-numbered local sequence.

Drafts and pending immutable send commands are independent of the visible window. Successful send acknowledgement does not force navigation to recent messages; explicit Latest retrieves them. Same-generation authorization denial invalidates local access even from an obsolete read, whereas responses from a prior account/generation cannot erase a newly signed-in session. Fresh read IDs and strict DTO validation protect response routing.

The existing500-record outgoing queue limit remains separate. This is not complete bounded-memory or durable encrypted storage. No delivery/read receipts, editing/deletion, replies, realtime, push, E2EE, native-device or production claim.

## Verification status

Implementation in progress. Focused tests, actual PostgreSQL/HTTP and the current eleven-required-step full profile must be run on the final source. Independent exact-SHA acceptance remains mandatory. No results from missing later versions apply.

Dependencies installed from official npm registry using existing exact lockfiles and --ignore-scripts; all three lockfile hashes unchanged. Initial root install failed because the default npm cache was unavailable, then passed using a separate writable temporary cache. No dependency versions were added or upgraded. Existing dependency deprecation warnings are retained in installation logs, not silently treated as a clean security audit.

## Author focused checkpoint

- Mobile:795/795 tests across38 suites PASS; targeted statements98.25%, branches96.61%, functions100%, lines99.43%; typecheck/lint PASS.
- API:24/24 tests PASS; statements/functions/lines100%, branches97.82%; typecheck/lint PASS.
- Real PostgreSQL18.6/HTTP:10/10 PASS in12.748s. Includes251-message numeric-gap and timestamp-tie navigation, same-seq foreign-ID anchor rejection, insertion between pages, proven lock wait followed by expiry denial, controlled mobile oldest/newer/latest navigation, delayed sendACK preserving older window/newer draft, lostACK exact replay and old /messages compatibility.
- Earlier mobile fixture/type/coverage failures and API missing-test-Bearer failure are retained separately; no failed run counted as acceptance. Old transport/queue tests and production validators remain strict. Updated integration assertions require explicit Latest after ACK instead of assuming automatic navigation.

A clean final commit, verified source/full-checkout archive, full eleven-required-step runner and independent exact-SHA acceptance are still pending at this focused checkpoint. No historical later-version PASS is reused.

## Measured orchestration correction

Author83c7407 full profile completed10/11 required gates; PostgreSQL failed with exit124 at240261ms (inner240s shell), not a passing full result. API coverage passed in174224ms against180000ms. An unchanged full PostgreSQL inner command under diagnostic-only360s completed224/224 tests, duration254408.172ms. Logs and the failed exact report are retained.

Only external reserves change: PostgreSQL shell240→300s and runner270→330s; API coverage runner180→240s. Individual tests, selection, concurrency, command arguments, coverage thresholds and10/15s kill/runner graces stay unchanged. Matching bounds/profile regressions are updated. The corrected commit requires a new complete exact-source run and independent acceptance; prior focused/failed reports are not relabelled.
