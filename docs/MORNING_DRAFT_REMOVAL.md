# Terminal private morning draft removal — candidate

Base53a1734 accepted in synthetic cloud scope. P0 private author drafts need explicit
control over saved text. This small slice removes current saved draft text, not ready
letters, slots, backups, receipts or historic database storage. It is not production.

## State and API
A new `.../slots/:slot/draft-v2` GET/PUT/DELETE uses explicit state:
missing(null/version0), live(string/positive version), deleted(null/positive version).
Other fields/identity match the existing private draft contract. DELETE requires
expected_version, confirm:true and immutable command_id/Idempotency-Key plus epoch.

Only original author with active session/current pair can act. Existing draft and
slot locks serialize save/fill/delete. CAS deletion changes live to terminal deleted,
clears current row body and advances version once. Identity and tombstone remain.
Deleted drafts cannot be restored, recreated, updated or physically removed through
this feature. Deleting a missing draft is draft_missing409, not silent creation.

Save receipts retain their immutable fingerprints; delete receipts are separate,
without historical plaintext. Exact recorded save/delete retries return current
canonical state, including a tombstone, never restore the prior body. Operation
namespaces are distinct even if command UUID matches. New writes to tombstone return
409 draft_deleted with canonical metadata and command identity/replay:false. Legacy
/draft reads/writes fail closed409 draft_deleted with no body or canonical value.

Recipient projections/readiness never include draft state or deletion. Existing
prepared letter, fill identity, release timing and opening remain unchanged.

## Explicit UI and retained knowledge
Before confirmation RU/EN text says: only saved personal draft is removed; ready
letter stays; restoring/creating a new draft for this morning is unavailable in this
version; erasure from backups is not promised. Confirmation binds target/version and
session. A newer draft or changed context invalidates stale intent. Unknown outcome
retains one immutable command for explicit retry, never a fresh delete/save.

Terminal metadata survives close/reopen within the authenticated scope, so old
responses cannot resurrect saved body. Knowledge is bounded without eviction and
fails closed on exhaustion. Session change clears private projections and scope.
Newer unsaved RAM input may be kept only as clearly unpublished input, never rendered
as saved content. Local RAM and archived database storage are not erased by a claim
of logical deletion; app/backup retention policy remains open in DECISIONS.md.

## Verification
Author full11 and independent exact-SHA review are required. No device, production,
E2EE, GitHub publication or physical purge claim. Prior accepted sources retained.

### Focused author evidence before freeze
API21/21 passed including migration028 live row/receipt→029 preservation, canonical
retry, rollback, terminal guards and legacy denial. V2 module coverage98.11/96.92/
100/100; legacy draft100all; changed HTTP100/94.77/100/100. Mobile44 tests in5 suites
passed: controller100/98.5/100/100, model/panel100all, changed request95.74/96.2/100/
95.65. Typecheck/lint passed (two unchanged mobile warnings). Real PostgreSQL4/4
passed, including previous draft connected regression and new delete/lostACK paths.

Adversarial mobile work covers cancelled then reopened same-slot GET delivering an
old tombstone: known terminal immediately removes a newly shown live canonical body,
while genuinely unsaved RAM is distinct. No ledger eviction or retry mutation.
Initial focused test/coverage diagnostics remain outside source; they do not replace
full frozen author and independent gates or native device proof.
