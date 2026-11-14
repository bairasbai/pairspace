# Prepared morning letter editing — candidate, not independently accepted

Base: independently accepted synthetic checkpoint c276fcc. This slice lets only the
original sender explicitly load and edit a filled morning letter before its release
instant. It does not cancel an assignment, change its time, fill late, edit a released
letter, reveal recipient opening, add notifications, or enable the chat journal.

## Contract and privacy
- A separate author-only `GET .../mornings/slots/:id/prepared` returns the current
  body and positive content version, plus read identity, server time and existing
  sender slot metadata. Existing recipient routes and sealed metadata stay unchanged.
- `PUT` on that path binds an immutable command ID, scope, slot, expected version
  and normalized body. Explicit Save submits; Cancel does not write. Only a real
  text change advances the version. A normalized no-op still checks the deadline
  and CAS and records its immutable receipt.
- Exact retry returns current canonical content, never restores the historical
  payload. This also remains true after release. The original fill receipt remains
  immutable and its existing metadata-only replay does not compare mutable body.
- Receipts contain fingerprints, not historical plaintext. Fingerprints are not
  encryption. Recipient responses never gain content versions, prepared text,
  editing state or timestamps before their existing disclosure condition.

## Time, locking and limits
Authorization is repeated after pair/target locks. Both trusted application time and
SQL `clock_timestamp()` must precede the original immutable release instant for new
edits, including no-ops. A waiting transaction must not cross the deadline and still
write. An expired session or inactive pair cannot edit or obtain retry content.

The editor must not use recipient opening as an eligibility signal or expose a read
receipt. An injected application-clock rollback after a genuine database deadline
cannot re-enable editing, regardless of whether the recipient opened the letter.
Actual rollback of both the underlying database wall clock and application clock is
not proven or solved here. No background release worker, monotonic global clock or
new GET-side write is claimed.

The separate editor keeps its RAM-only draft apart from the original fill composer.
Conflicts and unknown outcomes preserve unsaved input; an unknown outcome can retry
only its exact command. Old responses cannot overwrite newer drafts or another
selection/session. Reloading current content is explicit, not a silent overwrite.

## Verification status
Implementation and focused checks are in progress. Frozen author FULL11 and a
separate independent reviewer are required before acceptance. Evidence is kept
outside the source checkout so interrupted or failed runs remain visible. Native
builds, device keyboard/accessibility/visual behavior, production deployment and
end-to-end encryption remain unproven. No GitHub publication is part of this slice.

### Author focused evidence (before frozen gate)
Mobile: 127 suites / 2326 tests PASS; whole-code coverage statements/branches/
functions/lines 95.8/95.08/96/97.65%. Three new production modules each 100%.
Typecheck/lint PASS, with two unchanged existing lint warnings. Real PostgreSQL +
HTTP + session-controller connected test passed no-op, CAS editing, committed lost
ACK, exact retry, held ACK/newer draft, composer separation, sealed recipient and
signout clearing. New backend PostgreSQL CAS/receipt-rollback test passed.

Initial mobile focused failures were test expectation/mock errors (normalization and
consuming request mock), corrected without weakening assertions. Dependency symlink
runtime preparation failed first; actual local dependency copies resolved it. Initial
boundary tests used a composed cookie against the fixture's separate authority and
failed authentication setup; the existing fixture's documented sign-in is used instead.
All initial logs remain in external evidence, not relabeled as successful runs.
The initial held-lock test also exceeded the fixture's existing 5s lock / 8s query /
10s idle-transaction safety limits. It was corrected to hold across only the final
~1.8s of the already scheduled real deadline, with settled-promise and lock cleanup.
No safety timeout or coverage threshold was increased; the failed log is retained.
Backend focused 12/12 passed; changed-module coverage 97.93/93.03/100/97.77%,
new usecase 95.45/96/100/95.12%; typecheck/lint passed. Genuine boundary run 29/29
passed (122.636s): waiting GET/edit/no-op are denied after deadline; rollback before
and after recipient opening does not permit edits; canonical retry and prior discussion
regressions remain valid. A final test-only four-second scheduling reserve was added
for the last bounded wait; its exact revision is subject to the frozen full gate.

### Measured outer verification reserve, not feature acceptance
Frozen f3f7092 author FULL11 passed (PostgreSQL569555ms), but independent FULL11
hit the outer GNU timeout at600598ms, exit124; other10 gates passed. It is retained
as FAIL, not relabeled. Independent diagnostic on unchanged source with raw output
and a bounded720s diagnostic envelope completed349/349 PostgreSQL tests, no skips,
wall646670ms. The previous600s envelope is insufficient for that measured execution.

Only outer bounds are adjusted: `ceil(646.670 * 1.15 / 30) * 30 = 750s` shell,
runner780s. Kill grace10s and runner grace15s remain unchanged, as do SQL lock5s,
statement7s, query8s, idle10s, per-test30s, concurrency1, complete test set and all
coverage thresholds. Generated full/runner plans normalize identically apart from
that timeout; inner launcher and package test command stay byte-identical. New
frozen author and independent FULL11 are required; the diagnostic is not acceptance.
