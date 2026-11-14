# Morning discussions: independent candidate

New implementation from accepted `ab3de3e`, not restoration of previously lost code.
A discussion belongs to one immutable morning slot; the original letter body is never
copied into chat or into replies. Both participants can explicitly send immutable text
replies, with original author identity and preserved line breaks. Own edit/delete are
not implemented in this slice and must not be advertised as complete Tan Ata parity.

## Access and disclosure
Sender access requires a filled, released letter, independently of recipient opening.
Recipient access requires their durable opening latch. Missed, sealed and unopened
recipient requests expose no reply IDs, body, count, cursors or readiness. Every read,
write and exact retry rechecks current pair/epoch/session and role access after locks.
Sender can leave a first follow-up before the recipient reads, without learning whether
they opened. Explicit replies disclose participation, not a separate read receipt.
After clock rollback recipient access follows the durable latch; sender access follows
the existing release-time own-read rule. No automatic POST, outbox or notifications.

## Commands and navigation
Explicit commands bind actor, pair, epoch, slot, command UUID and normalized body.
Retries never retarget another slot and never append another row. Replies use native,
unique immutable sequence order, not rounded timestamps or a claimed contiguous count.
Thirty-row replacement windows support first/last/before/after with scoped anchors.
No silent total/history cap; concurrent insertions are not a database snapshot promise.

RAM drafts are scoped by slot, bounded for new drafts without evicting existing ones.
Pending retry data is separate from current selection and newer drafts. Late ACKs
cannot move a reader from B back to A or clear B's text. Session changes clear private
state; a current-session authorization denial remains blocking even for an obsolete
operation. Chat journal stays default-off and does not persist these reply drafts.

## Original source and differences
Code-only reference: Tan Ata commit `4822e213e991f6e8c0177751e0fd6626b1f237bc`,
`app/letters/[parting]/[id]/page.tsx`: replies are under the actual letter, chronological,
with each reply's own author, multiline text, own edit/delete, and explicit partial-list
notice. No personal letters, sample text, photographs or databases were imported.
This slice has no period/day numbering, photos, translation, editing or deletion of
replies, notification delivery, native-device proof or E2EE claim.

## Verification status
Implementation and synthetic tests are in progress. Author FULL11 and independent
exact-candidate acceptance are required; read-only design review is not acceptance.

## Focused evidence before final freeze
API4/4 PASS with100/97.5/100/100 own-module coverage and type/lint PASS. Initial
literal-generic typecheck failure retained, corrected without runtime change.
Actual PostgreSQL17/17 passed in120.797s, including existing genuine release boundary,
68 HTTP replies and inter-page insertion, two equal timestamps with native sequence,
receipt rollback, scope denial after actual slot-lock wait, and late ACK/account cases.
No production guards disabled. Mobile initial fixture-only consumed-Request assertion
failed and was corrected without weakening expectations. Pre-handoff-fix whole-mobile
2205/2205 passed; exact-generation saved-draft handoff regression and final rerun are
required before freezing. Full11 and independent acceptance remain separate gates.

Final handoff regression resolves the same-ID cancellation case: the caller receives
only the validated slot from its surviving request/selection generation, never a newer
ambient opened record. Final whole-mobile2206/2206 (119 suites) passed with global
95.64/94.88/95.84/97.47 coverage. Exact frozen FULL11 remains the final author gate.
