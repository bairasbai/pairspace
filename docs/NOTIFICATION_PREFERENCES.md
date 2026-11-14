# Saved future-notification rules and own-rule simulation

Bounded synthetic candidate after accepted manual arrival2c706114. Grounding:
PRODUCT P0 settings/privacy, DATA_MODEL planned outbox/jobs, SCENARIOS S04 disabled
push, S08 quiet/DST and S12 membership revocation. The outbox/jobs remain unbuilt.

## What exists in this slice
- Actor-private singleton per couple membership epoch. API derives actor only from
  authenticated principal. No recipient/user ID input or partner-settings endpoint.
- GET /v1/couples/:id/notification-preferences?membership_epoch=1 returns
  `{preferences,asOf}`. Absent record yields virtual version0, care/chat/letter false,
  quiet:null, preview:'generic'. No writes on GET and no automatic opt-in.
- PUT fields exactly command_id,membership_epoch,expected_version,care,chat,letter,
  quiet. First explicit save materializes version1 even for default values; subsequent
  semantically identical save retains version but records its command. CAS conflicts
  never silently overwrite. Exact immutable command retry returns current canonical
  own settings. New unsaved RAM input survives late ACK; account/pair fences apply.
- quiet is null or exact `{start,end,timezone}`. HH:mm24h, start!=end, start inclusive
  and end exclusive; wrap across midnight supported. Equal endpoints rejected: switch
  categories off for all-day suppression. IANA spelling is retained, not canonicalized
  before fingerprint. Valid aliases supported by Intl and PostgreSQL such as US/Eastern
  remain aliases; choosing another spelling is a real field change. Invalid or unknown
  SQL-zone names fail explicitly, never default to device zone or UTC.
- Quiet evaluation maps a trusted server instant to local wall minute. Both occurrences
  of a DST fold follow the same quiet rule. Missing wall times do not occur in
  instant→local mapping; no invented schedule, shift, timer or next-delivery estimate.
- Generic preview is fixed and not configurable. No message text, sender label,
  letter subject, draft body or event metadata is accepted/copied into these records.

## Own-rule preview is NOT delivery
GET /notification-preferences/preview?membership_epoch=1&category=care|chat|letter
returns `{allowedByPreferences,reason,category,asOf,preferenceVersion,simulationOnly:true}`.
Reasons disabled/quiet_hours/allowed mean only the saved own rule at server now.
No actual event, body, recipient, release instant or device-clock parameter accepted.
Preview rechecks active session, current pair, epoch and ownership in its transaction;
leave/revoke denies it. It does not prove any event should be delivered. It does not
create a notification, persist a job or promise later action. UI says push is not
connected and offers “Check rule now”, never “test notification”.

A future dispatcher must separately verify current event authorization/release,
recipient membership, preferences, quiet time, rate limits and dedupe immediately
before delivery, including queued events. This slice supplies none of that dispatcher.

## Deliberate limits
No push tokens, OS permission, notification subscription, provider/network call,
worker, queue, scheduled delivery, new analytics, content preview or change to existing
chat/care/letter sending. Saved rules cannot currently suppress those in-app resources.
No deletion/history UI or migrated preferences across epochs; turning categories off
is explicit save. No native/device/production/E2EE claims. Exact author/independent
FULL11, hostile lock/leave cases, privacy/unchanged-resource tests and archive restore
are required before accepting this candidate.
