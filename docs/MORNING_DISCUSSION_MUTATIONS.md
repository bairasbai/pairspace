# Morning discussion own edits/deletion: candidate

Standalone from accepted5343ce5, preserving accepted sources and artifacts. This is a
new independent implementation, not recovered lost code. Original Tan Ata letter page
at4822e213 shows each reply's author, own edit/delete and an edited marker. Original
personal texts are not imported. The morning letter itself remains immutable.

## Explicit operations
Only the reply author may save an edit or confirm deletion, under current pair/epoch
and existing morning-role access (sender released filled letter; recipient own latch).
Pair/slot/target locks precede repeated session/time/ownership checks. Receipt lookup
never bypasses current access. No notifications, read receipts, outbox or publication.
CAS is required before no-op comparison. Normalized same-body save records an immutable
receipt but does not update the row/version/editedAt. A real edit advances version;
restoring original wording is another real edit and retains the edited marker.
Deletion advances version, removes body with terminal NULL/deletedAt, preserves identity,
sequence and history position. Physical deletion and resurrection are prohibited.

Create's existing immutable fingerprint remains the original-command authority; do not
compare an old create retry to mutable current body. Edit/delete receipts are separate
from create, bind operation/actor/scope/slot/target/expectedVersion/payload digest, and
retain no historical plaintext. Digests are not encryption or proof of erasure. Exact
retries return current canonical metadata/body or terminal tombstone, never old text.
A new command against an already deleted own reply returns verified canonical tombstone
with message_deleted, without another mutation/receipt. Unknown outcomes require exact
retry; canceling confirmation before POST is not rollback of an already sent command.

## Versioned compatibility
New clients use discussion-v2 reads/creates and PATCH/DELETE on a reply target. V2
includes version/editedAt/deletedAt and tombstone rows, preserving bounded30 navigation.
Legacy routes retain exact live DTO shape and filter deleted rows before LIMIT/flags.
Scoped deleted anchors remain usable for traversal; legacy create replay after deletion
fails closed. Legacy clients can reject changed canonical create-retry text after an
edit, rather than silently trusting a changed identity. This is a documented limited
compatibility boundary, not a claim that old clients support editing/deletion.

## Client knowledge and private drafts
No historical body cache. Current window30 and private draft limits remain explicit.
Up to500 modified-live identity/version/cryptographic body digests and500 terminal IDs
are retained without eviction within an authenticated generation. At501 fail closed
with clear reload/sign-in guidance; do not promise persistence of RAM-only drafts.
A global revision shared across unopened letters is deliberately not introduced.
Async digest acceptance must check scope/generation and concurrent terminal knowledge
before committing. Lower versions and equal-version contradictions cannot replace
newer canonical state. A terminal tombstone always defeats delayed live success.
Unchanged deleted edit prefill is scrubbed immediately. Genuinely newer private text
may remain only explicitly unsaved with save blocked, never as restored canonical text.
A/B selection and separate draft revisions protect newer work from late ACKs. Current
session authorization denial remains blocking even from an obsolete operation; previous
session results cannot affect a new account. Journal remains default-off and unused.

## Acceptance pending
Required: no-op1→1→2→2→3, exact original-create replay after edits/deletion, legacy/v2
page boundaries and deleted anchors, own/other pair/epoch ACL, actual lock waits, receipt
rollback, CAS races, same-key payload conflicts,500/501 bounds, held SHA/account swap,
new draft preservation and immediate terminal scrubbing. Author FULL11 and independent
exact-candidate review are required. No native/E2EE/production readiness claim.

Scoped v2 direct GET by reply ID supports explicit conflict reload outside the current
window, with exact readId and unchanged parent/role ACL. No arbitrary cross-slot access.
Mutation timestamps are logical monotonic markers: max(trusted now, original createdAt,
prior editedAt). They are not a promise of the exact physical event instant during a
clock correction. Version/sequence remain ordering authority; recipient durable-latch
access can still permit mutation after rollback without retiming the original record.

## Resumed author checks before freeze
Work resumed from the preserved candidate after worker interruption; accepted5343ce5
and the intermediate byte-verified971-file archive remain intact. Real PostgreSQL
focused29/29 passed, including populated025-to026 migration/rollback, no-op markers,
canonical create/edit replay after deletion, legacy deleted-anchor traversal, competing
CAS, receipt rollback, delayed ACK/drafts and session expiry at the final target lock.
The stopped synthetic cluster was archived and actually restored for comparison.
Reload now replaces untouched editor prefill with fresh canonical text but retains
intentional private edits. Canonical acceptance scrubs both visible and history copies.
These focused results are not independent acceptance; final exact-SHA gates follow.
Resumed final mobile run passed2311/2311, coverage95.72/94.96/95.92/97.62, with
API/mobile typecheck and lint passing (two pre-existing mobile lint warnings).
An earlier resumed mobile run had one old central-heart5s timeout; its failed log is
retained. The unchanged heart15/15 and subsequent full mobile passed with original
timeouts. The cause is not established; overlapping archive work was stopped before
the repeats. No internal timeout or coverage threshold was relaxed.

The first frozen0a8f3a7 full run was10/11: PostgreSQL exited1 (not timeout).
Its stopped cluster log records FATAL No space left on device; a direct diagnostic
also failed at initdb because /tmp was full. Both stopped author-owned synthetic
clusters were archived, restored, hash/diff verified before reclaiming their /tmp
copies. Original source/report/runtime archives remain. The launcher now respects
the runner's quoted isolated TMPDIR (fallback /tmp), rather than hard-coding /tmp.
Regression checks cover whitespace/literal metacharacters, fallback and missing-parent
failure. Test enumeration, inner30s limits, outer600/630s, grace and coverage remain
unchanged. A new exact-candidate full run and independent review are still required.
