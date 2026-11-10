# Disposable PostgreSQL history regression

The first real run added 125 synthetic rows for pair A and 80 for pair B, using
noncontiguous numeric sequences (initially multiples of three). Result: 87 existing tests
passed and two new pagination tests failed. No private or production data used.

Root cause: the API selected `seq::text AS seq` and ordered by unqualified `seq`.
PostgreSQL resolves that ORDER BY name to the text output alias, so sequences were
sorted lexicographically rather than numerically. Strict mobile transport rejected
the malformed page. Earlier small-row fixtures did not expose this boundary.

The repair must explicitly order by the numeric source `chat_messages.seq`.
The original failure log is retained as `postgres-before-order-fix.log`.

The final fixture preserves gaps while explicitly including 9/10 and 99/100.
A separate PGlite regression covers all sequences 1..125. Temporarily restoring the
old ORDER BY made that targeted regression fail (exit 1); restoring the numeric
source ordering made it pass (exit 0). See `numeric-order-mutation.log` and
`numeric-order-fixed.log`. The fixed production line was restored before final checks.

API full coverage: 24 files, 176 tests passed; statements 99.78%, branches 99.70%,
functions 100%, lines 99.85%. Typecheck and lint passed. These are cloud checks,
not physical-device or native-build evidence.

Final real PostgreSQL run: 89/89 tests passed, no skips or cancellations, including
the modified numeric-boundary fixture, 125-message mobile history, exclusive cursor
pages, 70-new-message refresh reset, fresh context/cookie binding per page, draft
preservation, pair isolation, missing credentials, stale epoch and former-member
denial. Final API typecheck/lint passed. No remote publication or native-device test.
