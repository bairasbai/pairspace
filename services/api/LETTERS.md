# Immediate synthetic letters

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
  `{client_letter_id, membership_epoch, body}`. The UUID `Idempotency-Key` must match
  `client_letter_id`. Returns 201 `{ok:true,value:{letter,replay:false}}` or 200 with
  `replay:true`. Letter contains metadata plus normalized body.
- GET `/v1/couples/:coupleId/letters?membership_epoch=N` returns
  `{ok:true,value:{letters:[metadata]}}`. It returns only letters sent by the current
  partner to this recipient in the exact active epoch. The window is the latest
  **30** by `created_at DESC, id DESC`. It is not an exhaustive archive or pagination.
  Metadata has no body, preview or title.
- GET `/v1/couples/:coupleId/letters/:letterId?membership_epoch=N` explicitly opens
  one letter and returns `{ok:true,value:{letter}}`, including body. Only the exact
  recipient can open it. Missing IDs and inaccessible IDs return the same 403
  `{ok:false,error:"unavailable"}`. Opening does not record or publish a read receipt.

Metadata: `id,coupleId,senderId,recipientId,clientId,membershipEpoch,createdAt`.
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
recipient and normalized text must match on replay; edits never overwrite a record.
A reused command ID in a new pair or epoch conflicts after current authorization.
Unknown acknowledgement retries must reuse the exact ID and immutable normalized body.

Drafts live only in the author's RAM, never on the server or partner list. Available
means stored and accessible through this API, not delivered, read, or notified.
There is no durable plaintext mobile cache and no content in logs, URLs or outbox.
This server-readable synthetic storage is **not E2EE**. Production identity, privacy,
retention, encryption and operational acceptance remain separate gates.

## Explicitly future

Scheduled/sealed release, server draft sync, replies, sender archive, read receipts,
editing, deletion, notifications, pagination and attachment handling are not included.
There is no release-time promise and no UI-only hiding of scheduled content.
See `docs/DATA_MODEL.md` for the broader planned model and `SECURITY.md` for gates.
