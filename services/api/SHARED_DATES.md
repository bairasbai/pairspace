# Shared all-day dates: synthetic HTTP/SQL contract

Independent `enableSyntheticSharedDates:true` opt-in, restricted to loopback.
No listener, production data, external calendar or notification service is added.
Either active partner explicitly creates an entry visible to both. A shared date
is not an invitation or an agreed appointment. Unsent drafts remain client RAM.

## Commands and reads

- GET `/v1/couples/:coupleId/dates?membership_epoch=N` returns
  `{ok:true,value:{dates:[SharedDate],limit:50}}`.
- POST collection with `{command_id,membership_epoch,title,local_date,timezone}`.
  JSON content type and `Idempotency-Key` equal to command_id are required.
- Mutation: `{ok:true,value:{date,commandId,replay}}`; new creation 201, replay 200.
- Date fields: `id,coupleId,creatorId,membershipEpoch,title,localDate,timezone,createdAt`.
- Invalid input 400; absent authority 401; unavailable scope 403;
  stale membership or changed command body 409; transient failures generic 503.
- Responses are no-store. No title appears in a URL, analytics, push or app log.

## Calendar semantics

`localDate` is an actual proleptic Gregorian YYYY-MM-DD in 0001–9999. Leap years
include 2000 and exclude 1900. No past/future restriction is imposed. It is stored
and returned as text, not midnight UTC or an instant, so Tokyo/Los Angeles viewers
see the same calendar label. Creation timestamp is separate server time.

The explicit IANA reference zone is recognized by Intl and retained exactly as
submitted. SQL also verifies its exact spelling against `pg_timezone_names` before
creation/replay; a recognized ICU case variant absent from that catalog is 400.
Aliases are not rewritten: US/Pacific and America/Los_Angeles, or Etc/UTC and UTC,
are distinct immutable payload values even where their timezone rules coincide.
Changing alias spelling on a submitted command yields idempotency conflict.
Numeric offset strings are rejected. Runtime/DB timezone data must be compatible;
upgrades must review recognition of stored names without rewriting receipt identity.
The zone provides reference context, not a transformation of the calendar label.

These entries are one-off dates. Entering a birthday does not create annual
recurrence. There is no countdown, device-clock-based “today”, local time,
reminder, invitation, editing, deletion, recurrence or calendar integration.

## Authorization, persistence and bounds

The existing closure lock order applies to reads and writes: discover historical
members, lock all domain users in UUID order, verify session, lock pair, reread
membership, verify fresh provider/session authority after waiting. Exactly two
active members of an active pair are required. Pair/epoch parameters are not ACL.
Closed pairs and former members cannot list or replay; moving to another pair
never grants access to an earlier pair's dates or receipts.

The immutable receipt key is actor plus command ID. Its body binds pair, epoch,
normalized title, exact local date and exact validated zone. Changing a bound field
conflicts. Distinct commands may intentionally create identical entries.
A composite SQL foreign key binds the receipt to its exact immutable date body,
creator and scope. SQL validates dates, zones, title bounds and millisecond server
timestamps; UPDATE/DELETE triggers prohibit changes to entries and receipts.
Records are retained at pair closure under the existing retention policy.

List shows the latest 50 by created_at DESC, UUID DESC, including past and future
calendar dates. This is a bounded creation history, not an upcoming-only calendar
or a complete archive. There is no pagination in this slice.
Titles reuse NFC plain-text normalization: trim/collapse whitespace, 1–200 Unicode
scalars, at most 800 UTF-8 bytes; control/format/surrogate characters rejected.
Storage is plaintext; no E2EE or production retention guarantee is introduced.
