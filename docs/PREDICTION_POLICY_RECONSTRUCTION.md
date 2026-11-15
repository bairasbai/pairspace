# Prediction policy: partial reconstruction, 15 November 2026

Status: new domain-only candidate, NOT accepted and NOT a working product section.
Base: GitHub backup snapshot `6e12b894` of accepted shared-doings `bc636d7`.
The inaccessible earlier Prediction commit `985e2bb181ecadf3e7d162133ed3f97a8ab65988`
is NOT restored, copied or superseded by this work. Compare it when recovered;
do not overwrite its work or report this candidate as that version.

## Source facts versus new adaptations

Read Tan Ata `4822e213e991f6e8c0177751e0fd6626b1f237bc`:
- `app/talk/sealed/page.tsx`, blob `5f04a4ec88fcf30c9a2b1d874aab51eb7e6c4149`.
- `lib/talk.ts`, blob `6f82acfdd2b842dce448ff227c2d7452bee6b4f6` (sealed section).
Source: author can reread own body before the date; recipient body is absent before
that date. Opening is a receipt, not a gate or a burn-after-reading action. Creation
requires a date strictly after today, independent of meeting day or year duration.
The page's empty-state phrase suggesting nobody can read contradicts actual author
access and is not copied. No source personal data, prose or provider code is copied.

New bounded adaptations here: explicit local time, IANA zone and offset, immutable
UTC snapshot, 2000-codepoint plain text, current couple/epoch scope, terminal authored
removal, CAS-style expectedVersion and explicit confirmation. These are not asserted
Tan Ata rules. Local day is evaluated in the chosen zone using a supplied trusted
server instant. DST gaps fail; fold selection is explicit. No device clock default.

## Implemented boundary

`packages/domain/predictions/policy.ts` implements:
- strict schedule parsing with tomorrow-or-later local date and future UTC instant;
- canonical metadata validation, including recomputing the stored schedule;
- author and due-recipient read eligibility, removed/foreign/old-epoch denial;
- recipient-only explicit receipt, authored removal and forward metadata checks;
- Unicode/NFC/line-ending normalization with bounds and control rejection.

The module has no database, authentication, HTTP handler, UI or content projection.
Scope validation is NOT proof of current membership. Its caller must authenticate,
lock the current pair/epoch, obtain a trusted transaction clock, recheck session
before selecting or returning body, and enforce the same rules atomically in SQL.
A receipt does not bypass the deadline if clock rolls back. Logical removal must
physically clear the body in the same transaction. Lists and ACKs must contain
metadata only; clients must discard RAM content on close/logout/context replacement.

## Next integration, not delivered

1. Recover/compare the inaccessible prior candidate before merging duplicate work.
2. Migration and default-off loopback API: scoped list, create, explicit read, receipt
   and remove; body omission at SQL selection, bounded history and idempotent retries.
3. RU/EN mobile composer/reader, explicit future date/time/zone/offset, error states,
   stale-response/generation fences and unambiguous removal confirmation.
4. Real PostgreSQL lock/expiry/revocation/CAS tests and real HTTP/mobile tests.
5. Exact-SHA author and independent FULL11, required coverage, restored archive check.
6. Native iOS/Android and two-device validation remain separate, not export claims.

## Verification at initial candidate

Focused tests: 59/59 pass, four coverage metrics 100% for new policy only.
This is NOT whole-project coverage or full acceptance. No changed UI exists.
No native build, real-device test, production deployment or E2EE claim.
Independent review and aggregate verification results are reported separately.
