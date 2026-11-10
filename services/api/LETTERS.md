# Immediate and scheduled synthetic letters

This is a bounded synthetic loopback slice, not a production mail service.
`enableSyntheticLetters: true` independently opts the composed API in. It defaults
false, is rejected outside loopback, and is never enabled by environment discovery.
No real personal data, push, notifications or background delivery are authorized.

## Contract

All routes require the current authenticated session, trusted Origin/Expo-Origin,
and active two-person membership. Request bodies have the normal composed size/time
limits. Responses use `Cache-Control: no-store` and `nosniff`; failures never contain
private text, identifiers inferred from another resource, cookies or internal errors.

- POST `/v1/couples/:coupleId/letters` accepts exactly
  `{client_letter_id, membership_epoch, body}`, optionally with both
  `release_at` and `release_timezone`. Omitting both preserves send-now behavior. The UUID `Idempotency-Key` must match
  `client_letter_id`. Returns 201 `{ok:true,value:{letter,replay:false}}` or 200 with
  `replay:true`. Letter contains metadata plus normalized body.
- GET `/v1/couples/:coupleId/letters?membership_epoch=N` returns
  `{ok:true,value:{letters:[metadata]}}`. It returns only letters sent by the current
  partner to this recipient in the exact active epoch. The window is the latest
  **30** by `created_at DESC, id DESC`. It is not an exhaustive archive or pagination.
  Metadata has no body, preview or title.
- GET `/v1/couples/:coupleId/letters/:letterId?membership_epoch=N` explicitly opens
  one letter and returns `{ok:true,value:{letter}}`, including body. Only the exact
  recipient can open it, and only at or after the release instant. Missing IDs,
  sealed letters and inaccessible IDs return the same 403
  `{ok:false,error:"unavailable"}`. Opening does not record or publish a read receipt.

Metadata: `id,coupleId,senderId,recipientId,clientId,membershipEpoch,createdAt,
releaseAt,releaseTimezone,availability`. Immediate letters have null release fields.
`availability` is `sealed` or `available`, evaluated by the server on each request.
Availability does not record whether anyone opened the letter.
Sender and recipient are derived from the session and locked membership, never from
client claims. UUID spelling is canonicalized. Extra fields/query parameters,
duplicate parameters, bodies on GET and malformed identifiers are rejected.

## Atomicity and privacy

Migration `006_letters.sql` is additive. Each letter has composite sender/recipient
membership foreign keys, immutable server API content, and unique
`(sender_id,client_letter_id)`. Text uses the existing chat text policy: NFC,
canonical LF, no NUL or malformed Unicode, nonempty content, max 8000 code points.
HTML-like and SQL-like text remains literal parameterized data, never executable.

Send locks the couple for update, active members for share in stable order, and
rechecks session after lock waits. Reads use pair/member share locks and the same
post-wait recheck. Thus close/revoke cannot race through authorization. Scope epoch,
recipient, normalized text, release instant and timezone must match on replay; edits never overwrite a record.
A reused command ID in a new pair or epoch conflicts after current authorization.
Unknown acknowledgement retries must reuse the exact ID, immutable normalized body
and original explicit-offset schedule input. A known matching replay remains valid
after its schedule window has passed, but authorization is always rechecked.

Drafts live only in the author's RAM, never on the server or partner list. Available
means stored and accessible through this API, not delivered, read, or notified.
There is no durable plaintext mobile cache and no content in logs, URLs or outbox.
This server-readable synthetic storage is **not E2EE**. Production identity, privacy,
retention, encryption and operational acceptance remain separate gates.

## Scheduled release policy (synthetic scope)

Migration `007_scheduled_letters.sql` adds nullable `release_at` (timestamptz) and
`release_timezone` columns without changing old immediate rows. The stored instant
and zone are immutable through the API; availability is derived, never a background
job transition. This is server-enforced delayed access, not encryption from the server.

For a new scheduled command the release instant must be between 60 seconds and
366 × 24 hours after fresh trusted server time, inclusive. This bounded product
policy is provisional for synthetic testing, not a promised production retention
period. Validation occurs after pair/member locks and session recheck. Retries of
already committed identical commands are not rejected just because time passed.

Input uses an explicit-offset ISO timestamp plus an IANA timezone, for example
`2027-07-10T18:00:00+02:00` with `Europe/Berlin`. `Z` is accepted only where the zone
has zero offset at that instant. The shared validator checks real calendar fields
and matches the supplied wall time to platform Intl timezone data. Nonexistent DST
wall times and incorrect offsets are rejected. During a repeated DST hour the
explicit offset selects which occurrence; no silent gap/fold conversion occurs.
The instant is canonical UTC in metadata; the original IANA zone is retained.
Future timezone-rule changes do not shift the stored instant. No new dependency
or custom timezone offset table is used. Native Intl behavior remains a device QA gate.

List SQL selects metadata only. Open SQL applies `release_at <= trusted_now` (or
null immediate) before returning body, with fresh time after locks and session
revalidation. Equality opens; one millisecond before remains unavailable. Client
clock, countdown, query parameters and disabled controls cannot authorize access.
There is no automatic opening, notification, delivery job or read receipt. The
recipient explicitly refreshes metadata and then explicitly opens an available
letter. Sender send/replay ACK may echo their own submitted body.

## Explicitly future

Server draft sync, replies, sender archive, read receipts, editing, deletion,
notifications, pagination and attachment handling are not included.
See `docs/DATA_MODEL.md` for the broader planned model and `SECURITY.md` for gates.
