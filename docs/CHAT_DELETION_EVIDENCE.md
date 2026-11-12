# Delete one's own chat message for both participants

Status: new implementation candidate from independently accepted54bb956. Not accepted
until exact-source author and independent full gates. Previous sources and archives retained.

## Contract

Explicit DELETE /v1/couples/{pair}/chat/messages/{id}, with membership_epoch, command_id,
expected_version, scope='everyone' and an exact Idempotency-Key. Only the current author
in the active pair may delete. Pair lock precedes row lock; authority is checked again
after waits. This is terminal soft deletion: the same row, identity, sequence and reply
links remain; body becomes NULL, version advances, and deleted_at is permanent.

Receipts contain operation/actor/pair/epoch/target/expected version/command identity, never
message body. An authenticated exact retry returns current canonical tombstone before
fresh CAS checks; changed target/version under the same delete command key conflicts.
Delete command IDs have their own operation namespace, separate from legacy send client
IDs; equal UUID spelling across namespaces must never alias a receipt or bypass authority.
Fresh commands against already deleted or stale-version messages do not mutate again.
Old plain/reply send replays remain fail closed for deleted messages, never resurrection.

The persisted deletion timestamp is trusted PostgreSQL time after locks, rounded upward
to millisecond precision and not earlier than immutable creation time, which may have
legacy microseconds. No client clock or test-only production clock override is accepted.

## User interaction and privacy

Begin deletion only from a validated own live message in the current window or canonical
source detail. Confirmation binds target ID, version and session generation. Cancel before
submission performs no DELETE; another selected target invalidates the previous dialog.
Once submitted, an uncertain outcome is not presented as undone: explicit retry retains
the original command. A stale confirmation or late ACK cannot delete a newly selected
message, overwrite a newer draft, or publish into another account/pair session.

Canonical tombstones enter the existing non-evicting terminal ledger, rather than merely
removing one row from view. Queue, source detail, selected quote and unchanged submitted
composer are scrubbed; unrelated newer drafts are retained. Replies remain references
and show that the original was deleted, not a copied body. Existing500-tombstone session
safety limit remains explicit. No realtime deletion delivery: the other participant sees
the tombstone after a fresh authorized read. No body is added to errors or receipts.

## Required verification and open scope

Actual PostgreSQL/HTTP: author vs partner/foreign/former, 251-message source detail,
CAS conflicts/concurrency, expiry after proven locks, atomic receipt failure rollback,
lost ACK exact retry, cancellation and stale confirmation, late ACK/new draft/new account,
old send/reply replays and no text resurrection. Unit/UI RU/EN, coverage>=90 in all four
metrics, handwritten files<=600 lines, full11 author and independent exact-SHA acceptance.

No message editing, physical row deletion, account erasure, retention purge, history-sync,
realtime, notification delivery, native device/E2E or production readiness claims. No
publication, real personal data or personal-computer access.

An authorized stale confirmation against an already-deleted own message returns409
`message_deleted` with `value:{commandId,message:canonicalTombstone}`. This error causes
no additional mutation or receipt. Unlike other errors, it carries strictly checked
terminal metadata so the client immediately scrubs known-deleted text through the same
ledger; an unrelated/malformed payload cannot clear another message. Confirmation names
the own message by sequence, original timestamp and ID, without copying its body.

The composed endpoint remains explicitly opt-in for the synthetic loopback checkpoint;
production defaults remain disabled. A local JS export is not a native/device rollout.
Confirmation and retry state are RAM-only. Process restart does not restore an uncertain
command; a fresh authenticated read is required. Durable encrypted persistence remains
outside this checkpoint and no offline restart recovery is claimed.

## Author focused checkpoint, not final acceptance

API29/29 PASS; coverage statements97.33%, branches97.59%, functions100%, lines98.50%;
typecheck/lint PASS. An intermediate TypeScript assertion error on unknown JSON was
corrected with an explicit typed record; the failed run remains recorded.
Mobile1839/1839 PASS across78 suites; coverage96.08/93.22/100/98.95, typecheck/lint PASS.
Initial10 failures were old exact AuthView expectations missing the newly exposed,
independently verified currentUserId for own-action visibility. Assertions now check the
exact verified IDs (including account-switch cases), not weakened partial matches.

Actual PostgreSQL/HTTP23/23 PASS in29.765s: new deletion core4 and connected7 scenarios,
existing reply core3 and connected7, and recovery2. Real product DELETE is used by the
new connected cases; privileged SQL tombstone fixtures remain only in the earlier internal
read-safety tests. Covered row-lock expiry, atomic receipts/CAS, reply/delete both orders,
transactional populated020→021 upgrade, own canonical detail outside251 messages,
confirmation cancel/staleness, late ACK/new account, and canonical409 from another owner
session. Existing reply retry still binds original A; reusing its key for B or plain send
conflicts without reparenting. Full11 and independent exact-SHA gates remain mandatory.
Final UI-only wording correction after that checkpoint: a verified canonical409 explicitly
says the message is already deleted for both, rather than the generic unconfirmed error.
Targeted RU/EN panel3/3 PASS and typecheck/lint PASS; core logic unchanged. Exact full run
must include this final source, not reuse the preceding focused counts as acceptance.
