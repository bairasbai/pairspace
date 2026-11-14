# Manual planned arrival: bounded synthetic candidate

Base accepted separation-period slice a0cb439. Grounding: Tan Ata at
4822e213e991f6e8c0177751e0fd6626b1f237bc, app/him/page.tsx → MoveArrival in
components/LetterEditor.tsx → moveArrival in app/him/actions.ts. Source “flight”
means editing the day of a planned meeting, not booking or airline data. We do not
copy its gender restriction, only-later rule, penalty prompt or notifications.

## Contract
- One independent manually entered plan per active couple membership epoch. Both
  active participants can explicitly create/read/edit. No real flight verification,
  mutual confirmation, ticket number, booking, location access or airline lookup.
- GET /v1/couples/:id/arrival-plan?membership_epoch=1 returns
  `{plan:null,asOf}` when absent, otherwise `{plan,asOf}`. Absence means no plan set,
  never “no flight” or “already together”.
- PUT uses exact fields command_id,membership_epoch,expected_version,label,
  local_date,local_time,timezone,offset. expected_version0 creates; if already
  present it conflicts instead of overwriting. Existing version required to edit.
- Label field is a required string in the wire schema, optional in the form: empty
  or whitespace becomes empty string; nonempty normalized NFC, trimmed/collapsed
  whitespace, 1–200 Unicode characters and <=800 UTF-8 bytes. Missing/nonstring rejected. No copied personal data.
- Date2000–2100, real calendar date, HH:mm, IANA zone and explicit ±HH:mm offset.
  Offset range -14:00…+14:00, -00:00 rejected. Existing resolveMorningChoice
  validates exact local instant: gaps rejected and folds chosen by explicit offset.
  Canonical IANA zone and UTC arrivesAt snapshot stored; no device locale inference.
- Past dates allowed as past entered plans, not evidence of actual arrival. Changing
  earlier/later or across timezones never changes separation records, letter dates,
  IDs, numbering, release snapshots, prepared content, saved drafts or discussions.
- Stable ID/creator/creation metadata. CAS and immutable actor command receipts;
  exact retry returns current canonical plan after newer edits. Semantic no-op
  retains version but still requires fresh authorization and expected version.
- asOf describes this single resource, never freshness of periods/letters. Explicit
  form save/cancel, newer RAM input retained through late ACK, auth/pair fences.
- No deletion/cancellation/reinstatement or revision-history UI in this slice.
  Form Cancel only discards unsent editing input; cannot undo a submitted command.

## Acceptance gates
Focused domain/API/mobile >=90% each metric, SQL guards, real concurrent create/edit
and auth-expiry/revocation lock scenarios, morning+period before/after invariants,
author and independent clean exact-SHA FULL11, source archive restore comparison.
No native/device/production/E2EE acceptance claim. Candidate is not accepted yet.
