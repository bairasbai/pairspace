# Shared important dates: synthetic mobile slice

`createSessionController().dates` is available only with the existing loopback
synthetic opt-in and a verified active pair. The default offline/Kimi showcase
remains unchanged. The connected area exposes the same dates controller to RU/EN.

A title, real `YYYY-MM-DD` calendar date (years 0001–9999), and explicit IANA zone
are entered in RAM. There is no inferred zone or inferred “today”. Only pressing
Share date submits the date and makes it visible to both active partners.
Choose once or annual explicitly. Once remains the initial choice for compatibility.
Annual February 29 requires a separate explicit choice: leap years only, February 28
in non-leap years, or March 1 in non-leap years. There is no default leap policy.
Other schedules use null policy; changing recurrence/date clears the prior policy.
There are no reminders, countdown, deletion, invitations, or calendar writes.

## Timezone and response contract

The calendar label is sent and displayed unchanged; it is never parsed as midnight
UTC or converted to an instant. Creation time is a server timestamp, not the event
date. A zone is reference metadata, not an instruction to shift the calendar day.
The mobile runtime validates that the supplied IANA identifier is recognized, but
preserves the exact original spelling in the immutable command and response.
Aliases are distinct payload identities: `US/Pacific` is not interchangeable with
`America/Los_Angeles` for command replay. No client or server canonical rewrite is
performed. A fresh ACK zone must match the pending string exactly. Historical replays return the current resource after later edits. ICU canonical
spelling differences cannot rewrite a pending command. An unrecognized identifier
fails closed as unsupported; native ICU/Hermes acceptance remains unverified.
A validation failure is not a reason to guess or replace the user's selected zone.

GET `/v1/couples/:coupleId/dates?membership_epoch=N` returns at most the latest
50 creations, descending by server createdAt then ID. This is not an upcoming
calendar or complete archive. POST to the collection uses JSON
`command_id,membership_epoch,title,local_date,timezone,recurrence,leap_day_policy`, with a matching
Idempotency-Key. Neither titles nor date drafts are placed in URLs or storage.

## Recovery and isolation

Unknown ACK retains one immutable title/date/zone/recurrence/leap-policy/ID command. The user can edit a
new draft while retrying that same original command. Successful acknowledgement
clears the draft only if its revision has not changed. Clear draft does not cancel
an already submitted command. Unresolved commands and drafts exist only in memory;
a restart loses them. No background sender or persisted outbox exists.

Each operation revalidates server context and cookie, then checks credentials again
at response/body boundaries. Session generation, identity, user, pair and epoch
changes invalidate late replies. Auth/access/stale-membership denial clears data.
A conflicting command requires explicit list refresh before another creation.
Server responses must match the authorized scope, known schema, calendar validity,
zone identity, version, fresh pending content and command ID. Lists must be bounded, sorted and
unique. Old-pair dates cannot be exposed through a late response or retried command.

## Annual metadata and manual refresh

Each response date includes recurrence, leapDayPolicy, asOfLocalDate and nextOccurrence.
The server obtains its current calendar date in the exact stored IANA zone only after
authorization locks. The client validates the entire known schema and recomputes the
next date using only that returned as-of label and pure Gregorian domain arithmetic.
It never substitutes device time, infers timezone, or schedules background work.
Malformed or inconsistent metadata is rejected before exposing any response date.

Annual occurrences include the as-of day and never precede the original date anchor.
Future anchors remain future; December rolls to the following year. Years are 0001–9999.
A null next date means no remaining occurrence in range when as-of is known. Null
as-of requires null next date and displays calculation unavailable, not an invented date.
The original label and exact zone remain visible along with recurrence, Feb29 rule,
server as-of label and next calendar occurrence. Refresh is explicitly manual, not a
notification promise; the list stays a bounded history of the latest 50 creations.

Tests cover Gregorian/leap/year boundaries, Tokyo and Los Angeles DST-date labels,
exact alias identity, immutable recovery, both languages, partner reads, response
validation, credential drift and late reply guards. The client makes no relative
day/countdown claim, so device clock skew cannot change an event label. JS exports
are bundling evidence only, not a native build or device/two-device acceptance.

## Editing existing shared dates

Edit date copies an existing item into the RAM draft without writing. The explicit
Save changes for both partners action submits PATCH `/v1/couples/:coupleId/dates/:id`
with all schedule fields and `expected_version`, preserving the observed version.
Either current active partner can edit. Resource version starts at 1 and increments
once per accepted edit. Creation identity/order does not change.

An unresolved command freezes target ID, expected version and full payload. Editing
or clearing the draft cannot change that command; retry sends it unchanged. A version
or idempotency conflict keeps the draft and requires refresh and explicit selection
again, never silent rebase. Selection intentionally replaces the current draft.
Historical successful create/edit retries return the canonical current resource, not
the old command payload. The client validates target/scope/schema/version, and an ACK
cannot replace a higher version already observed. Non-replay ACKs must match the full
submitted content and exact next version. Session/pair/epoch invalidation still clears
all edits and ignores late callbacks. Server plaintext remains visible; this is not E2EE.
