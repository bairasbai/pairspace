# Shared all-day dates: synthetic HTTP/SQL contract

Independent `enableSyntheticSharedDates:true` opt-in, restricted to loopback.
No listener, production data, external calendar or notification service is added.
Either active partner explicitly creates an entry visible to both. A shared date
is not an invitation or an agreed appointment. Unsent drafts remain client RAM.

## Commands and reads

- GET `/v1/couples/:coupleId/dates?membership_epoch=N` returns
  `{ok:true,value:{dates:[SharedDate],limit:50}}`.
- POST collection with `{command_id,membership_epoch,title,local_date,timezone}`.
  Optional `recurrence` (`once`/`annual`) and `leap_day_policy` (null or an explicit
  Feb29 policy) extend this legacy body. Omitted fields mean once/null.
  JSON content type and `Idempotency-Key` equal to command_id are required.
- PATCH `/v1/couples/:coupleId/dates/:dateId` replaces the editable schedule.
  Body requires all create fields, explicit recurrence/leap_day_policy and
  `expected_version` (integer 1–2147483646). Either current partner may edit.
  Same JSON/idempotency headers apply; successful edits and replays return 200.
- Mutation: `{ok:true,value:{date,commandId,replay}}`; new creation 201, replay 200.
- Date fields: `id,coupleId,creatorId,membershipEpoch,title,localDate,timezone,createdAt`,
  `recurrence,leapDayPolicy,asOfLocalDate,nextOccurrence,version` (initial version 1).
- Invalid input 400; absent authority 401; unavailable scope 403;
  stale membership, version conflict or changed command body 409; transient failures generic 503.
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

Recurrence is explicitly `once` or `annual`. Existing rows and legacy requests remain
once/null. Annual February 29 requires one of `leap_years_only`, `feb28`, or `mar1`.
Other dates and once schedules require null/absent policy. In leap years all three
policies occur February 29; in other years the explicit policy determines the day.
The original local date anchors the first eligible year; no occurrence predates it.

Responses derive `asOfLocalDate` from fresh server time in each exact saved zone,
only after authorization locks and fresh session checks. `nextOccurrence` is the
first occurrence on or after that local day (same-day inclusive); annual dates roll
to the next eligible year and once dates become null after their date. Arithmetic
is pure Gregorian calendar math, never UTC midnight conversion or device time.
Years 0001–9999 are supported; an out-of-range zoned today produces null as-of and
next fields, while no remaining occurrence before year 10000 produces null next.
An invalid server clock fails closed. Replay recalculates metadata without changing
the receipt or creation timestamp, returning the current canonical schedule/version. Refresh is manual, not a reminder.
No countdown, local time, notification, invitation, deletion or calendar write.

## Authorization, persistence and bounds

The existing closure lock order applies to reads and writes: discover historical
members, lock all domain users in UUID order, verify session, lock pair, reread
membership, verify fresh provider/session authority after waiting. Exactly two
active members of an active pair are required. Pair/epoch parameters are not ACL.
Closed pairs and former members cannot list or replay; moving to another pair
never grants access to an earlier pair's dates or receipts.

The immutable receipt key is actor plus command ID. Its body binds operation,
resource (for edit), expected version, pair, epoch, normalized title, exact local
date, exact validated zone, recurrence and leap-day policy. Changed commands
conflict; distinct create commands may intentionally create identical entries.
Authorization precedes receipt lookup. Exact historical retries return the current
resource rather than the old snapshot, including create retries after later edits.
New edits check expected version under the existing pair/user lock transaction;
one same-version concurrent edit wins and the other returns version_conflict.

Migration 014 preserves old create receipts, adds version 1 to existing resources,
and replaces mutable-content FKs with stable pair/date/epoch identity references.
An INSERT trigger checks each receipt against the then-current full schedule and
operation/version; receipts remain immutable afterward. Resource guards retain
id, pair, creator, epoch and creation time, and require exactly one version step.
Calendar/title/schedule constraints and zone validation also apply on UPDATE.
DELETE remains prohibited. SQL permissions are not a substitute for application ACL.
Records are retained at pair closure under the existing retention policy.

List shows the latest 50 by created_at DESC, UUID DESC, including past and future
calendar dates. This is a bounded creation history, not an upcoming-only calendar
or a complete archive. There is no pagination in this slice.
Titles reuse NFC plain-text normalization: trim/collapse whitespace, 1–200 Unicode
scalars, at most 800 UTF-8 bytes; control/format/surrogate characters rejected.
Storage is plaintext; no E2EE or production retention guarantee is introduced.
