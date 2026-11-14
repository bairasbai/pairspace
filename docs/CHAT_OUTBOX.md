# Chat notification privacy simulation

Internal synthetic observation only, not notification delivery, realtime or read receipts.
Existing plain/reply sends already create one chat.message_created event atomically; migration034
adds immutable identity context to that SAME event using an AFTER INSERT trigger. No duplicate
event, body/name/hash/quote copy or recipient-preference access occurs during send. Sender response
and client replay contract are unchanged. Capture failure rolls back the original transaction.

## Rollout and scope
Migration034 precedes enabling the simulator; full simulator schema also requires chat deletion,
personal visibility and notification preferences migrations. Pause writes for controlled rollout.
No production rollout/roles/grants implemented. Old events have no context and return not_found;
no backfill and no originating epoch guessed from present membership. Context stores event,
message, pair, sender, recipient, original membership epoch. Capture requires current active pair
with exact two active members and concrete source sender. Metadata is immutable.

simulateChatOutbox(db,eventId) is trusted internal composition only, never HTTP/mobile input.
It locks pair→outbox→source message→ordered active members, reads current visibility/preferences,
and samples trusted time AFTER final lock/read. Pair locks serialize all supported privacy writes.
SQL deliberately selects source metadata only, never body/hash/reply target/name/contact/token.
No credential impersonation: send rechecks session authority, future dispatch needs device gates.

## Semantics
Fresh processing verifies active pair/exact originating epoch and both original participants.
Deleted-for-everyone source suppresses processing; recipient's personally hidden source suppresses
processing; sender's private hiding does not change recipient eligibility. A reply is its own
source: no parent lookup or copied preview, even if parent later hidden/deleted. Edits create no new
event; processing observes current message version. Restore-before-first-processing is respected,
but does not generate an event or reprocess historical observations. Then latest prefs.chat and
quiet hours decide. Missing preferences mean disabled. Future-dated source fails closed.
No invented24h chat TTL: unlike care, chat has no matching display-expiry contract. Future actual
dispatch freshness/retention remains unresolved; an old simulation can NEVER authorize delivery.

One immutable observation per context event: simulation_eligible/allowed or
simulation_blocked/unavailable|deleted|hidden|disabled|quiet_hours. asOf, messageVersion and
preferenceVersion document the observation; unavailable has neither version, deleted/hidden no
preferenceVersion. Generic format only, no rendered payload. Concurrent calls dedupe, failed SQL
rolls back, explicit same-ID retry works. Replay returns original asOf/result with replay=true,
simulationOnly=true,historicalObservation=true, including after leave/deletion/preferences change.
This is private evidence, not a fresh access decision, and no endpoint exposes it to either partner.
Shared outbox.processed_at is UNCHANGED: this simulator cannot complete other consumers' work.

## Not implemented
Push, device tokens/permissions, OS prompts, provider, subscription, automatic worker, queue,
lease/backoff/dead-letter, quiet-end scheduling, delivery/read receipts, native/device/production
verification, E2EE. Future dispatcher must recheck source visibility/deletion, current account,
pair/epoch/participants, freshest preferences/quiet, freshness policy, device authority, dedupe
and rate limits at send time. Session logout does not erase already committed event metadata.

Producer authority after capture: the new recipient/member FK or lock can wait after a prior
session check. Both plain and reply producers recheck authority after outbox/context insertion.
Failure throws a dedicated rollback sentinel; only that exact sentinel is mapped to unavailable
outside the transaction. Message, sequence, outbox and context all roll back; unrelated errors
are not swallowed. Real recipient-lock tests expire authoritative sessions during that wait.
