# Personal time capsule: domain candidate, 16 November 2026

Status: ACCEPTED DOMAIN SLICE. Pure policy only, not an operational capsule feature.
Based on restored Library v8 / GitHub fdaa9c59da6836351222f2de553ca22056742649.
This work does not restore the historical missing prediction commit985e2bb.

## Source and explicit adaptations

Read-only source: Tan Ata at4822e213e991f6e8c0177751e0fd6626b1f237bc,
[screen](https://github.com/bairasbai/tan-ata/blob/4822e213e991f6e8c0177751e0fd6626b1f237bc/app/us/page.tsx)
and [storage](https://github.com/bairasbai/tan-ata/blob/4822e213e991f6e8c0177751e0fd6626b1f237bc/lib/keepsakes.ts).
The source is a private letter to oneself, not to one's partner. It hides text
until the selected date even from the author. One capsule per author can be
replaced before its old due date, never rewritten after becoming due.

Adaptations for Pairspace: explicit user/couple/epoch scope; canonical UTC release
from a selected zone, date, time and offset; CAS version for resealing/removal.
The calendar-year suggestion clamps February29 to February28 rather than producing
an impossible next-year date. It is only a suggestion, not automatic scheduling.
Only a future local day is accepted; DST gaps fail, folds need a matching offset.
Text is NFC, multiline, at most2000 Unicode codepoints; invalid controls/unpaired
surrogates fail. These are bounded synthetic-contract choices, not source limits.

## Implemented pure policy

- `nextCapsuleYear`, `parseCapsuleSchedule`, `normalizeCapsuleBody`.
- Strict body-free metadata validation scoped to the author. Partner, other pair,
  different membership epoch, extra body fields and malformed metadata fail.
- `mayReadCapsule` denies even the author until the exact authoritative instant.
  A ready state does not automatically fetch text or disclose it to the partner.
- Explicit confirmed CAS reseal before the OLD due instant, never at/after it.
  New text must be supplied; the old body is never retrieved to prefill an editor.
- Explicit confirmed terminal removal, permitted before/after release. One last
  version is reserved for removal; no integer wrap or resurrection operation.
- Status projection returns only sealed/ready/removed, no content.

## Integration obligations still open

This is not authentication, SQL persistence, an API or a mobile screen. Future API
must authenticate and recheck current membership in the same transaction, load
only metadata first and fetch the body only after the gate. Never trust a device
clock or client-supplied scope. Enforce one capsule per author/current scope in SQL,
validate body in the same transaction, serialize CAS/release races and make writes
idempotent without returning text in ACK/history/retry payloads. Removal must erase
the body transactionally; this policy alone does not delete any stored bytes.
Recheck the clock for resealing at commit; do not permit resealing by stale snapshots.
Personal-only access after leaving a pair needs a separate defined policy, not an
accidental grant from these functions. Current epoch fails closed.

RU/EN UI, read lifecycle, offline/retry, auth/SQL race tests and device checks are
not implemented. No SDK, credentials, network allowlist, dependency, normal entry,
main, production or payment changes. Existing E2EE decisions remain open.

## Verification record

Focused API policy:81/81 PASS;100% statements/branches/functions/lines.
Focused mobile Jest policy:81/81 PASS;100% all four metrics (same cases, both engines).
Initial API invocation used the wrong working directory and discovered no tests;
corrected invocation from services/api passed. Full exact-source verification and
independent review are tracked separately; focused tests do not establish acceptance.

Independent review reproduced two invalid metadata cases: resealed+removed with
insufficient version, and active metadata at the removal-only version ceiling.
Both now fail closed with regressions in both suites. Pre-fix FULL runs remain
non-acceptance evidence; final source requires fresh FULL verification.

## Exact-source acceptance

Author and independent FULL each passed11/11 on local
b951a5e5aff84dfc9d291e1141242db9aa08cf19, sourceValid:true. Each executed627 API/domain,
2789 mobile and434 real PostgreSQL tests, safety, lint/typecheck and iOS/Android
JS export. All four aggregate coverage metrics are at least90%; the new policy
focused tests cover100% of all four metrics in both API and mobile engines.

Published application candidate:
https://github.com/bairasbai/pairspace/commit/d5fdc14fe0e88dc73a7055f05c17a643f42c25c6
Its tree f6fe76ae23c876770bdc315c7bbda84c97bdc3ae equals the tested local tree across
1236 tracked files, independently verified. Different commit IDs reflect the
recovered local history, not different source bytes. No GitHub check runs exist
for that candidate; these are cloud execution results, not GitHub CI success.

The first pre-fix FULLs were interrupted exit130; their reports are incomplete,
not PASS. An independent retry with symlinked dependencies completed9/11 but failed
PostgreSQL's package-local path check and Metro resolution. Copying the same locked
dependencies into that isolated checkout fixed the setup; no guard or source was
relaxed. A fresh full run then passed. Earlier failure evidence is retained.
This documentation update records those runs without claiming another full run on
its documentation-only commit. No API, UI, native or production acceptance follows.
