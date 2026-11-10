# Repeatable blind rounds: verification evidence

Base published SHA 9e1bfb013bdd956c57dfb0715ac1d935e1a2a0fe, tree
18ac4fb978b1edd3031cc7a777d529a82536595a. Isolated cloud clone from equivalent
local ab7acb9836a63646845a4649fb869d63c36e4eb6. No production, personal data,
desktop, preview deployment, GitHub write or Space publication by implementer.
Status: author verification, not independently accepted. Frozen SHA/tree and archive
checksums are recorded in the external handoff manifest to avoid self-reference.

## Scope and immutable compatibility
Explicit confirmed next round, three neutral versioned RU/EN questions, no daily
rotation. `small-joy` v1 wording/meaning retained. Legacy first-round GET/POST never
advance. New next command binds predecessor, question/version and command ID;
concurrent changes conflict, while exact old replay resolves the original target.
Latest-ten metadata window plus explicit selected-round read, no list bodies or
partner status. Current pair/epoch/session/snapshot authorization applies to every
operation and replay. Closed pairs remain inaccessible; no archive policy change.
SQL migration extends constraints without rewriting old immutable records; a
serialized predecessor chain prevents branching and two unfinished rounds.
Mobile selection generations and round-scoped immutable pending commands prevent
misrouting; drafts and consent do not carry to a different question.

## Verification record
Logs in `docs/evidence/blind-rounds/` are normalized before freeze. Existing coverage
globs include all own production sources; no new dependency or exclusion.
- API `npm test -- --no-fsModuleCache`: 32 suites / 224 tests passed. Coverage
  statements/branches/functions/lines: 99.30 / 98.80 / 100 / 99.91%.
- API TypeScript and lint passed.
- Mobile `npm test -- --no-cache`: 46 suites / 1,270 tests passed. Coverage
  statements/branches/functions/lines: 96.84 / 96.08 / 97.76 / 98.40%.
- Mobile TypeScript and lint passed; both platform JavaScript exports verified.
- Root domain tests 9/9; PostgreSQL harness safety tests 9/9 passed.
- Focused real PostgreSQL: 22/22, final frozen runtime/test sources.
- Full real PostgreSQL: 166/166 passed, 194.38s, unchanged 240-second outer bound.
  The run started before local mobile dependency copying ended; all mobile test
  processes loaded the frozen final source afterward. Final focused rerun also
  passed after source freeze. No module failures in this full PostgreSQL run.
- Root Next build attempted: exit 127, existing `next: not found` dependency gap.

The official PostgreSQL runner rejected a dependency symlink before tests; Metro
also required dependencies within the cloned worktree. Exact existing pinned
dependencies were copied locally, with no package/config change. Concurrent copies
invalidated temporary Vitest/Jest module paths; clean final no-cache reruns passed.
Focused integration setup assertions were corrected (201 creation, lock/session
ordering, explicit current-list refresh); final focused rerun passed all 22.

## Acceptance coverage
- Existing immutable round/answer/receipt preservation across forward migration.
- Exact root/answer/next replay after later rounds, immutable question/version and
  predecessor matching, strict consent/HTTP fields and atomic receipt rollback.
- Concurrent different and same commands; raw SQL forbids branch, skip, foreign
  predecessor and advancing before both answers.
- 12+ rounds with latest-ten metadata only, selected body reads, no early partner
  body SQL, foreign pair/epoch/session/revocation/closure denial.
- Real mobile controllers → official provider cookie → HTTP → PostgreSQL, two
  rounds, lost next ACK/exact retry, explicit history selection and mutual reveal.
- Mobile late response/selection race, immutable per-round command preservation,
  RAM draft/consent reset, known question/version/body validation, RU/EN controls.

Source hashes cover runtime, tests and migrations in final-source.sha256. Full
base-to-final diff check, file line-count policy, archive extraction and clean-base
patch application/tree equality are recorded in the external handoff manifest.

## Not claimed
Native builds, physical iOS/Android, two-device visual acceptance, production,
E2EE, load tests, full archive, persistent drafts, retention, deletion, cancellation,
psychological advice and all other conversation modes remain outside this slice.
JavaScript export is not a native build. Independent review requires the exact
frozen SHA/tree; author verification is not acceptance.
