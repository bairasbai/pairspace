# Synthetic care signal

Status: implemented synthetic-loopback slice, pending independent acceptance. No production listener,
push provider, device delivery/read receipts, presence, location, background polling or E2EE claim.
Default app remains offline demo. Explicit API flag `enableSyntheticCareSignals: true` is separate
from invitation/profile flags, rejected outside loopback and disabled by default.

## Contract

- POST `/v1/couples/{uuid}/care-signals`: JSON exactly
  `{client_signal_id: uuid, membership_epoch: positiveInteger}` and identical `Idempotency-Key`.
- GET the same path with exactly one canonical positive `membership_epoch` query parameter,
  no body. Returns latest incoming signal from the current active partner within 24 hours, or null.
- POST returns `{ok:true,value:{signal,replay}}`, HTTP 201 first save, 200 exact retry.
  GET returns `{ok:true,value:{signal}}`, HTTP 200. Signal fields: id, coupleId, senderId,
  recipientId, clientId, membershipEpoch, kind (`thinking_of_you` only), createdAt (UTC ISO).
- Unknown fields (including sender/recipient/text) are rejected, not trusted or silently copied.
  401 unauthenticated, 403 unavailable, 409 stale_membership/idempotency_conflict,
  400 invalid_request, 415 unsupported_media_type, 429 cooldown with conservative Retry-After:60.
  Failures are redacted; responses no-store. Composition applies request body/time limits and origins.

## Authorization and concurrency

Every operation rechecks the verified provider session inside the SQL transaction, locks the pair
(UPDATE for send, SHARE for read), and locks both current active member rows FOR SHARE.
The latter serializes even membership edits that do not update the pair row. Both active members,
caller membership and exact epoch are required. Session validity is rechecked after contended locks,
including elapsed expiry while waiting. Better Auth uses authoritative PostgreSQL clock_timestamp.
The clock for the product cooldown and read window is obtained after pair/member locks.

Recipient comes only from the other current active membership. GET never returns sender's own
signal and never records a read effect. Each command is globally unique per sender, bound to the
original pair/epoch/recipient. Fresh authorization precedes lookup of a retry. New pair or changed
epoch cannot redirect an old command. Concurrent duplicate requests store exactly one row;
concurrent different commands serialize and respect one new signal per sender/pair per 60 seconds.
This is a product cooldown, not deployment-grade abuse protection, a WAF or account rate limiter.

## Retention and privacy limitations

Migration 005 is additive/forward-only. Records have only fixed signal metadata, no free text,
location, presence or read state. Records remain as deduplication journal; a 24-hour visibility
window is not physical deletion or an approved retention policy. Cooldown history also remains.
Retries may return the sender's old accepted record even after the recipient visibility window.
Production retention/deletion, legal policy, schema access grants and operational abuse controls
remain unresolved. There is no background cleanup, external notification, outbox event or worker.
A future deletion workflow must preserve deduplication safely or reject old commands without
recreating signals. Reads expose only the latest incoming record, not a history/pagination feed.

## Tests

`npm test`, `npm run typecheck`, `npm run lint` in services/api cover contract, isolation,
invalid/spoofed input, no self effect, replay, cooldown, expiry, revocation and rolling visibility.
`npm run verify:postgres` provisions/guards/destroys a disposable local PostgreSQL cluster.
Care integration checks real concurrent duplicate/new commands, two pairs, member row locking,
close/replay rejection and expiration while pair lock waits. Mobile integration adds official
provider cookies and connected controller send/read/retry paths. Unit/PGlite checks do not replace
native two-device acceptance, which is not claimed here.
