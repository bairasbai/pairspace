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

## Second checkpoint: explicit opening and refusal

The initial candidate above followed only Tan Ata's time eligibility. Earlier Amio
thread summaries recovered on 15 November additionally require voluntary opening
and refusal, reader-generation fencing, replay proof and bare-CR rejection. Exact
`ff1122a` contract documents remain inaccessible, so this is a bounded reconstruction,
not a claim of byte-for-byte or complete semantic recovery.

This checkpoint changes recipient read permission to require explicit `openedAt`,
not merely time eligibility. Opening is due-only and CAS-protected. Refusal is
recipient-only, explicit, irreversible, and allowed before release as a conservative
adaptation; it prevents opening while preserving the author's own access. Opening
and refusal are mutually exclusive. Author removal remains terminal and can follow
either choice. A clock rollback before an already recorded opening denies recipient
reading. Bare CR is rejected; CRLF is normalized. No body is held by this module.

API persistence, fresh-write lock/clock checks, exactly-once operation replay,
bounded history, session/display generation and RU/EN UI remain NOT_IMPLEMENTED.
This checkpoint must not inherit aggregate acceptance from `bd3df908`: it requires
its own author and independent FULL on the new exact source. Focused tests are
intermediate only. No original `985e2bb` files were recovered or overwritten.

## API/storage candidate (separate work after domain checkpoint)

New migration043 and synthetic default-off loopback route integrate the current
reconstructed policy, not the unavailable original985e2bb. History is bounded at100
including tombstones; sequence is SQL-only and never added to strict domain metadata.
List/create/open/decline/remove ACKs are metadata-only. Text uses a separate explicit
GET after current-session, current-couple epoch, consent and trusted-clock checks.
Author can read own active text before release; refusal preserves author access.

Mutation receipts store immutable applied metadata so replay can prove reachability
and return current metadata without reenacting a stale operation. Fresh writes must
roll back if authentication or calendar admissibility changes after blocking writes.
A feature clock is injected only by trusted server/test code, never request input;
it remains separate from actual session time. Default HTTP feature clock is db.now.

This API candidate has no mobile controller/composer/reader or device verification.
New focused and real PostgreSQL/HTTP checks plus BOTH new exact FULL are required;
domain2d31808 results are historical and cannot accept this changed source.

## Mobile candidate after accepted API/storage82e0399

A separate mobile slice adds an RU/EN Predictions tab, explicit schedule composer,
immutable command retries and an in-memory reader. No device timezone/day is guessed:
date/time/IANA zone/offset are supplied explicitly and server checkedAt is the only
eligibility hint. The API remains authoritative after clock changes and lock waits.
Metadata-only opening ACK never supplies text; a separate authenticated read may
follow only while the original display intent/context remains current. Closing,
navigation, logout or account/pair epoch replacement discard reader content.

Real HTTP/mobile tests inject a trusted feature clock through the server factory's
optional dependency argument, not through HTTP/config/environment and not through
the authentication clock. The default implementation remains db.now. The default-off
loopback feature flag, limits and request guards are unchanged.

Component tests and JS export do not prove native iOS/Android or physical-device
behaviour. Mobile source requires focused, real integration, author and independent
exact FULL checks before bounded acceptance; API82e0399 evidence is historical.

Mobile focused evidence before exact FULL:33 controller/state/UI/composition tests,
real PostgreSQL18.6 +full HTTP/mobile scenario, API composition guard test, both
typechecks and lint pass (3 pre-existing mobile warnings). Two initial real-mobile
fixture failures are retained: missing full second schedule/history refresh, then
stale author metadata after recipient decline. Tests now explicitly refresh and
assert state before private reads; no production privacy guard was weakened.
Native builds, device testing and production deployment remain unverified.
