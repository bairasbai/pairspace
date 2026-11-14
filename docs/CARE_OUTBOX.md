# Care-only durable capture and simulation

This is an internal synthetic slice, not a working notification delivery queue.
Source: DATA_MODEL minimal outbox/jobs and PRODUCT_BACKLOG privacy/quiet-hours requirements.

## Rollout
Migration 033 must precede the new producer code, after migrations 005 and 032.
New care signals and a minimal `care.signal_created` outbox record commit atomically.
A replay does not add an outbox record. Existing historical signals are not backfilled.
Mixed deployment with an older producer is not supported: pause writes during migration/code
rollout. This repository does not implement deployment, production roles or privileges.
Existing chat and couple-close outbox records keep their prior behavior.

## Processing contract
`simulateCareOutbox(database, eventId)` is imported only by trusted server/test composition;
there is no HTTP route, scheduler, mobile UI or provider. It accepts one event ID, never a
recipient, credential, preference, event body or client clock. Database time is authoritative.
It locks pair then outbox, verifies concrete source identity and current pair/epoch/members,
then reads the recipient's latest private preferences for that epoch. Missing prefs are disabled.
Producer responses remain unchanged and do not expose recipient settings or simulation results.
Saving a care signal is independent of notification opt-in.

Pending outbox -> immutable `simulation_eligible/allowed` or
`simulation_blocked/{unavailable,expired,disabled,quiet_hours}` observation + processed_at.
These writes are atomic. Failure rolls back both, so the same ID may be retried explicitly.
Concurrent calls produce one observation. There is no external work in the transaction and
thus no lease, attempt counter, backoff, autonomous retry, dead-letter or delivery SLA.
Unsupported/missing event returns not_found; malformed ID returns invalid_request.

Response includes simulationOnly=true, historicalObservation=true, original asOf and
preferenceVersion. Same-event replay returns original observation with replay=true even after
preference changes or leaving. It is historical internal evidence, NEVER current permission.
The result is not available to the sender or any public client.
Quiet-blocked is terminal simulation: it does not schedule a notification after quiet hours.
Opt-in does not resurrect past completed simulations. Future-dated events fail closed;
care age >=24 hours expires, consistent with the care read visibility horizon.

## Privacy and limitations
No message/name/contact/token/body payload is copied. Unavailable scope does not read preferences.
Current pair closure, exact epoch and both participants are checked before fresh evaluation.
A session logout/revocation does not erase previously committed events; producer authorization
checks remain in force. This worker stores or impersonates no session principal. Future actual
dispatch needs device registration/permission and revoked-device checks, which do not exist here.
Pair locks serialize leave and preference changes with evaluation; a later change can invalidate
eligibility immediately, which is why even a successful observation cannot authorize delivery.
Future dispatch must separately recheck current account/pair/epoch/recipient/device authority,
source freshness, latest prefs/quiet, dedupe and rate limits at actual sending time. No native,
two-device, production, E2EE, push, eventual delivery or quiet-end postponement claims.

Clock regression W1: sample trusted time only after the final membership row lock completes.
Use that exact instant for freshness/quiet evaluation, observation and processed_at. Real-PG
held-member-lock tests cross both the 24-hour expiry and quiet-start boundaries.
