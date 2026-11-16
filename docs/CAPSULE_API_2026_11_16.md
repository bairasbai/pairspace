# Personal capsule API acceptance, 16 November 2026

Status: independently accepted bounded storage/API slice. Extends the domain policy in
`CAPSULE_POLICY_2026_11_16.md`; no UI or production changes.

## Bounded contract
- One capsule per author, current couple and membership epoch, including a removed
  tombstone. Removal does not free this slot. Creating again in that same scope is
  rejected. This is an explicit initial capacity boundary, not text recovery.
- Partner cannot list or target even metadata. SQL includes the author predicate.
- List, mutation ACK and replay return metadata only, never body. The separate
  `GET /v1/couples/:id/capsules/:capsuleId/text` selects body only for the author
  at or after release. Before due and after removal it returns metadata without text.
- `GET/POST /v1/couples/:id/capsules` list/create; `PUT/DELETE` the capsule ID
  reseal/remove. Writes require confirmation, command UUID and CAS for existing ID.
- Reseal replaces text and schedule, never reveals the previous text. It is allowed
  only before the OLD release deadline, with a new future local calendar day.
- Removal is terminal and erases body in the same transaction. Pair closure retains
  records but current pair/epoch authorization denies access. Post-separation product
  behavior is unresolved; no automatic body deletion is added on partner departure.

## Boundary and verification
`enableSyntheticCapsules` is independent, false by default, loopback-only. A trusted
clock dependency is server construction only. Requests cannot provide a clock.
Current session, pair and epoch are checked inside the transaction, after lock waits
and before private projection; late expiry/clock failure throws to roll back both
mutation and receipt. Replay validates immutable identity and monotone applied-state
proof, and returns CURRENT metadata without reapplying a historical command.
Migration044 enforces shape, monotone transitions and metadata-only immutable receipts.
SQL constraints are not authorization or encryption. Server authorization and trusted
clock are required; direct privileged SQL remains outside this application boundary.

At the early WIP, focused PostgreSQL15/15 passed with observed pair/row/FK blockers, duplicate/CAS,
expiry/revocation, due-crossing rollback and replacement pair isolation. HTTP/unit
coverage, full11 verification and independent acceptance were pending then.
No device privacy, encryption-at-rest, native runtime, two-device or production claims.

Early independent review reproduced an impossible replay proof: a two-version jump
ending in removal could incorrectly accept sealing at/after the old deadline. Such
an endpoint has exactly one reseal before removal, so its sealing time must precede
the old release. This is now checked explicitly; mobile regressions19/19 pass
(100/100 including existing capsule policy). No observed HTTP content leak resulted.
Other static review and independent HTTP/application3/3 passed before final exact-source
full verification and review. Initial HTTP test parse failure
(duplicate local variable) was fixed before the structural WIP commit.

Pre-FULL checkpoint: PGlite/API policy93/93, HTTP/application3/3, mobile policy100/100
and real PostgreSQL16/16 (15 service/lock scenarios plus actual HTTP/official-auth
scenario) passed. Focused capsules.ts coverage: statements98.91%, branches98.98%,
functions95.65%, lines100%. API typecheck/lint passed. These focused results are
not a substitute for full-suite or independent final acceptance. The source was frozen
for exact FULL11; the final results follow.


## Final exact-source acceptance
Both author and independent reviewer FULL runs passed all 11 required gates on
`f81097cc587578f3211f77f8307be551f87bce40`, tree
`1bfc9f6935ad7928429f3ecae066ea5559d59787`. Both report `sourceValid=true`,
with the source clean and unchanged. This later checkpoint changes documentation only.
- Author report: `/tmp/pairspace-verification-AVcwrS/report.json`.
- Independent report: `/tmp/pairspace-verification-9Rk4J2/report.json`.
- Both: API642/642 (91 files), mobile2808/2808 (169 suites), real PostgreSQL450/450,
  no skipped PostgreSQL tests. Legacy Next build/typecheck was intentionally NOT_RUN.
- API coverage: statements98.60%, branches97.46%, functions99.88%, lines99.45%.
- Mobile coverage: statements95.62%, branches95.32%, functions96.12%, lines97.32%.
- Reviewer verified the corrected delta-two removal proof and found no new blockers.

Acceptance is limited to the synthetic loopback storage/API contract above. No capsule
UI, native runtime, two-device behavior, production readiness or E2EE is established.
GitHub publication is blocked awaiting explicit owner approval; no main or production
changes were made. Library packaging is coordinated separately. Temporary report paths
identify local evidence; they are not user-facing download links or durable publication.
