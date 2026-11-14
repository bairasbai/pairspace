# Bounded outgoing lifecycle: approved scope

Base accepted visibility1d993a411b406c77250d0a74640da8dfa15a2c4b; standalone
pairspace-chat-outgoing, no publication/production/personal data. Prior copies retained.

Confirmed defects: queue currently counts accepted records toward500 indefinitely;
after500 successful sends the next enqueue fails. A permanently rejected pending
command also remains preferred over a newly typed draft and has no explicit release.

Retain at most50 accepted queue receipts; total bound500 remains. Only canonical
accepted/hidden/deleted confirmations may be compacted. Never automatically evict
queued/sending/failed commands. Existing edited-version and tombstone safety ledgers
are separate and unchanged. Server immutable idempotency remains authoritative after
local compaction; no new server migration or receipt deletion.

Explicit local discard confirmation pins operation/command/scope. It sends no DELETE,
POST or cancellation request; an unknown or in-flight message may already have been
sent and can legitimately appear in a later fresh history. Clear only unchanged
submitted composer/target as disclosed in confirmation, preserve newer private draft.
Cancel confirmation does nothing. Retry retains exact original body/target/clientID.

A per-send operation generation prevents old results from mutating queue, ledger,
UI, newer draft/pending or busy state. Check before and after every await, including
asynchronous digest and credentials. A CURRENT SESSION security denial still blocks
access even from a discarded operation; only previous-session denials are ignored.

Required evidence:501+ actual successful sends, bounded local queue, all remote rows;
500 unresolved records remain intact on overflow; permanent reject→discard→newsend;
lost/held ACK, local discard then fresh committed history, cancel/stale confirmation;
late current-session401/403/stale_membership vs old-account denial; newdraft/target
and terminal hide/delete safety. Existing tests/coverage90/file600 and FULL11 retained.

This fixes deterministic session usability failures before durable queue work, which
requires a separate encrypted storage/key/session/native-restart policy. No offline
persistence, realtime, delivery/read receipts or native build claim is added here.

## Focused author checks

Mobile1967/1967 and actual PostgreSQL/HTTP61/61 pass. The latter includes501 real
successful sends from one controller, split into three sequential tests without
raising any per-test timeout or pre-seeding messages. Later history contains all
501 canonical messages. Current-session delayed security denials still block after
local discard; previous-account denial does not block the new account. No server
production or SQL migration changes were needed. Complete frozen FULL11 and
independent exact-SHA acceptance remain pending.

A final read-only review corrected terminal-pending UI flags independently of draft
revision and made RU/EN confirmation copy explicitly disclose clearing unchanged
submitted text while preserving newer drafts. The corrected snapshot passes36
focused tests plus typecheck/lint; its complete gate is the forthcoming FULL11.
