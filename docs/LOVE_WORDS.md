# Shared love dictionary: bounded synthetic candidate

Status: implementation, not accepted. Base accepted morning checkpoint `1a415a0`.
This is a user-facing shared glossary, not another notification simulation.

## Source grounding
Read-only Tan Ata snapshot `4822e213e991f6e8c0177751e0fd6626b1f237bc`:
- `app/talk/words/page.tsx`: glossary presentation, visible authorship, own editing.
- `components/WordForm.tsx`: word required; meaning and occasion optional.
- `lib/talk.ts`: addWord, allWords, editWord author predicate; newest entries first.
No original private entries, names, fixed couple configuration or implementation copied.
Independent implementation adapts the scenario to authenticated isolated couples.
Confirmed own deletion is an explicit privacy improvement, not claimed source behavior.

## Contract
Both active members of the exact couple epoch can read and create. Only the original
creator can edit or delete their entry. Gender is irrelevant. Sharing occurs only
through explicit publication for both; unsaved composer/editor text stays in RAM.
Word: 1–120 Unicode code points, NFC, trimmed and whitespace collapsed. Meaning and
occasion: optional, empty by default, 0–1000 code points each; NFC, CRLF normalized,
trimmed, internal line breaks preserved. Invalid controls are rejected. Duplicate
words are allowed because different authors can mean different things.

Stable identity, author, creation time and sequence never change. Version starts at1.
Edit/delete require CAS. Normalized no-op edits retain version and unedited status.
Command identities are immutable; retries return current canonical state, not the
original text. Receipts contain metadata/fingerprint, never text; fingerprints are
not logged. Deletion clears current text and returns only safe identity/version
metadata. Terminal tombstones cannot be restored. This is logical removal, not
physical deletion from database files or backups, and cannot erase already read text.

The synthetic technical ceiling is100 entries over the epoch lifetime, INCLUDING
deleted entries. The UI must explain remaining capacity and that deleting does not
free it. Edits/deletions still work at the ceiling. This is not a tariff, retention
policy or production-ready scale guarantee. The complete read snapshot is bounded100,
including metadata-only tombstones; no hidden first-page-only history.

Only an explicit full read establishes snapshot checkedAt. A mutation acknowledgement
merges just its canonical entry and cannot claim other entries are newly checked.
Known version/tombstone information fences late stale snapshots. Session generation
changes clear private scope; newer RAM text survives late operation acknowledgements.
Retry retains original command content, separate from newer unsaved input.
If a full read or ACK reveals deletion/newer version under an open editor, its Save
becomes unavailable with explicit stale/deleted guidance. Untouched old editor text
may clear; genuinely newer RAM input remains clearly unsaved, not canonical content.

## Deliberately absent
No provider, push, OS permission, native delivery, realtime, persistent offline queue,
search, AI, automatic reminders, receipts or history export. No E2EE or production
launch claim. Native iOS/Android, two-device and real offline restart remain unverified.
P0 real notification delivery still needs provider/device consent/registration,
future dispatch freshness/retention and deployment decisions; another simulation
would not resolve those prerequisites.

## Verification gates
Domain and transport malformed-input/output tests; A/B isolation, former membership,
revoked session, duplicates/conflicting retries, no-op, edit/edit and edit/delete CAS,
held-lock authentication expiry, rollback, capacity and metadata-only deletion.
Mobile RU/EN/controller/UI tests include unknown acknowledgements, newer drafts and
stale-response anti-resurrection. Real PostgreSQL races use bounded observed lock
waiters, not extra minute-boundary sleeps. Early independent review precedes freeze;
then exact clean SHA author FULL11 and independent FULL11, archived source restored
byte-for-byte. Evidence stays outside source. This document is not acceptance evidence.

## Internal transport / rollout
This feature is separately disabled by default behind `enableSyntheticLoveWords` in
the existing loopback-only synthetic API application. Apply migration036 after current
migrations; there is no import/backfill of original words. GET/POST collection and
PUT/DELETE entry routes are under `/v1/couples/{coupleId}/love-words`. Mutation JSON
uses membership_epoch, command_id and (for existing entries) expected_version; the
Idempotency-Key header must match command_id. Responses never expose fingerprints.
Application shape and access checks do not claim an independently deployed production
service. Pending retries hold unsaved command input in client RAM, distinct from
canonical deleted rows; no durable private text cache is added.
