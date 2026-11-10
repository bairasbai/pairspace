# Shared important dates: synthetic mobile slice

`createSessionController().dates` is available only with the existing loopback
synthetic opt-in and a verified active pair. The default offline/Kimi showcase
remains unchanged. The connected area exposes the same dates controller to RU/EN.

A title, real `YYYY-MM-DD` calendar date (years 0001–9999), and explicit IANA zone
are entered in RAM. There is no inferred zone or inferred “today”. Only pressing
Share date submits the date and makes it visible to both active partners.
Dates are one-off labels: birthdays do not repeat annually. There are no reminders,
countdown, editing, deletion, scheduling, invitations, or external calendar writes.

## Timezone and response contract

The calendar label is sent and displayed unchanged; it is never parsed as midnight
UTC or converted to an instant. Creation time is a server timestamp, not the event
date. A zone is reference metadata, not an instruction to shift the calendar day.
The mobile runtime validates that the supplied IANA identifier is recognized, but
preserves the exact original spelling in the immutable command and response.
Aliases are distinct payload identities: `US/Pacific` is not interchangeable with
`America/Los_Angeles` for command replay. No client or server canonical rewrite is
performed. The ACK zone must match the pending string exactly. ICU canonical
spelling differences cannot rewrite a pending command. An unrecognized identifier
fails closed as unsupported; native ICU/Hermes acceptance remains unverified.
A validation failure is not a reason to guess or replace the user's selected zone.

GET `/v1/couples/:coupleId/dates?membership_epoch=N` returns at most the latest
50 creations, descending by server createdAt then ID. This is not an upcoming
calendar or complete archive. POST to the collection uses JSON
`command_id,membership_epoch,title,local_date,timezone`, with a matching
Idempotency-Key. Neither titles nor date drafts are placed in URLs or storage.

## Recovery and isolation

Unknown ACK retains one immutable title/date/zone/ID command. The user can edit a
new draft while retrying that same original command. Successful acknowledgement
clears the draft only if its revision has not changed. Clear draft does not cancel
an already submitted command. Unresolved commands and drafts exist only in memory;
a restart loses them. No background sender or persisted outbox exists.

Each operation revalidates server context and cookie, then checks credentials again
at response/body boundaries. Session generation, identity, user, pair and epoch
changes invalidate late replies. Auth/access/stale-membership denial clears data.
A conflicting command requires explicit list refresh before another creation.
Server responses must match the authorized scope, known schema, calendar validity,
zone identity, pending content and command ID. Lists must be bounded, sorted and
unique. Old-pair dates cannot be exposed through a late response or retried command.

Tests cover Gregorian/leap/year boundaries, Tokyo and Los Angeles DST-date labels,
exact alias identity, immutable recovery, both languages, partner reads, response
validation, credential drift and late reply guards. The client makes no relative
day/countdown claim, so device clock skew cannot change an event label. JS exports
are bundling evidence only, not a native build or device/two-device acceptance.
