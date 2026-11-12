# Own-message editing: author plan

Base: accepted f6197f81d134191983a6a66a4e321a950651efc4.
New standalone checkout: pairspace-chat-editing. No publication or real data.

- PATCH an own live canonical message, captured ID/version and explicit Save.
- Separate protected edit draft; Cancel before POST, unknown result exact retry only.
- CAS conflict never overwrites another device's change. Explicit reload preserves an unsaved draft.
- Original send/reply identity uses immutable original-body digest plus immutable scope,
  author, client ID and reply target. Backfill live pre-edit records atomically;
  old tombstones have no fabricated original digest and remain fail-closed.
- Edit receipts bind normalized body digest, not historical plaintext. Digests are not
  encryption and are never public DTO, notification or logging fields.
- Exact original create replay returns current canonical content. Version 1 still
  requires original body equality; higher versions require exact immutable identity.
  Older clients may fail closed on an edited replay: this is documented contract evolution,
  not a claim of full old-client compatibility.
- Live revisions advance by exactly one only for an actual normalized-text change.
  Unchanged saves retain the version while receiving an immutable retry receipt.
  Terminal deletion dominates later reads and ACKs, never restoring private text.
- Pair/message locks and post-wait current-session checks apply to every write/replay.
- Existing 500 observed-tombstone safety bound remains. No realtime, native build,
  durable offline edit draft, historical revision browser or E2EE claim.

Acceptance: focused API/mobile/actual PostgreSQL including reply/delete regressions,
then exact candidate required FULL11, independent review/extras/FULL11. All four
coverage metrics >=90; handwritten files <=600 lines. Preserve every failure log.

## Contract and memory limits

PATCH `/v1/couples/:pair/chat/messages/:id` accepts exactly membership_epoch,
command_id, expected_version and body; the Idempotency-Key must match command_id.
Author comes only from the authenticated session. A separate edit namespace permits
reusing a UUID across send/delete/edit without aliasing their receipts. A reused edit
key with different scope, target, expected version or normalized text conflicts.
A definitive already-deleted response contains only its canonical tombstone and the
bound command ID; it does not create another receipt or revision.

The original-body hash is server-only SHA-256. Immutable pair/author/client ID and
reply target complete the original command identity. Previously deleted rows cannot
be backfilled from absent plaintext, so original retries continue to fail closed.
An atomic migration obtains an exclusive relation lock and restores the full guard
before commit; no runtime trigger bypass is part of the feature.

The edit form holds one target and one protected RAM draft. Switching target cannot
silently overwrite a changed draft. Unknown write results retain one exact command,
not a promise to cancel a possibly committed write. An observed tombstone scrubs an
unchanged prefilled/submitted draft immediately; separately revised private text may
remain unsaved with saving blocked for that deleted target.

An independent non-evicting ledger retains at most 500 edited-live target identities,
versions and cryptographic body digests. It retains no body outside the visible state.
The existing separate 500 observed-tombstone bound remains. At the safety limit the
chat fails closed and explains the need to sign in again, rather than evict a barrier.
Ordinary version-1 navigation does not consume edited-ledger capacity. Expo runtime
uses the already-installed official expo-crypto SHA-256; cloud tests use WebCrypto.
Both are asynchronous, so authentication/navigation generations and ledger revisions
must remain current before a staged batch commits. No weak or custom hash is used.

## Verification status

Implementation and focused checks underway. This document is not a PASS report.
Exact final author and independent results belong to their SHA-specific external
reports. Tests use synthetic accounts and disposable PostgreSQL only. JavaScript
export is not a native build; no production deployment or real two-device test is
claimed. Partner visibility changes after a fresh read, not via realtime delivery.

## Recorded author iterations (not final acceptance)

- API initial focused: 52/53 passed. An unavailable-target probe reused a committed
  edit key, so the correct result was idempotency_conflict. The probe received a new
  key; explicit changed-command conflict tests remain. No production weakening.
- API corrected focused: 53/53 passed, changed-file coverage including composer
  S98.70/B99.14/F100/L99.24, typecheck/lint passed.
- Mobile initial: 1859/1873 passed. Fixed unnecessary visible-window publications,
  corrected old fixtures that assigned one immutable message identity to differing
  version-1 bodies, and made async race waits/navigation deterministic. Kept strict
  rejection of contradictory canonical messages.
- Independent read-only inspection caught old edit error publications after async
  digest/reset. Both success and failure paths now recheck request/session ownership;
  the proof includes delayed hashing, reset, navigation and tombstone interleaving.
- Mobile intermediate: 1881/1881 passed, S96.77/B96.12/F97.76/L98.61 and type/lint
  passed. An additional post-digest cookie check is being verified before freeze.
- All initial logs are retained outside this source checkout. No failed run is
  called accepted. Actual PostgreSQL and final frozen FULL11 are still pending.

## Final focused checks before candidate freeze

- Mobile after post-digest cookie validation: 1883/1883 tests, 85 suites passed;
  S96.75/B96.12/F97.76/L98.61. Typecheck/lint exit0. An additional test-only
  assertion checks that blocked→signIn does not bypass explicit signOut; its seven
  race tests and typecheck/lint passed. Existing two import-order lint warnings in
  the unchanged deletion panel test remain warnings, not suppressed failures.
- Cookie iteration initially passed 1882/1883: recovery test omitted required explicit
  signOut from blocked state. Corrected test retains rejection and successful recovery
  assertions. Production guard did not change to accommodate the invalid sequence.
- Focused actual PostgreSQL: 36/36 passed in 43436ms. Includes four new API scenarios,
  nine new connected controller→HTTP scenarios and all 23 prior reply/deletion/recovery
  cases. No skipped tests. Initial 34/36 had two test dereferences of absent editState;
  corrected assertions require exact undefined after reset/non-owner selection, with
  account-isolation, draft, no-request and body-denial assertions preserved.
- Original lost plain/reply create ACK→other-owner-device edit→exact original controller
  retry returns current canonical text/version, one row, no retarget. Reusing original
  create key with current edited text is a conflict, not a new edit.
- Actual locks prove edit/edit CAS, both edit/delete orders and post-row-wait session
  expiry. Populated 021→022 rollback/upgrade preserves identity and backfills only known
  live original bodies. Hash tampering, new version forgery and terminal reversal fail.

Exact frozen FULL11 and independent acceptance are still required. These focused
results alone do not establish acceptance or native/production readiness.

## External PostgreSQL orchestration reserve

Approved before freeze: shell300→360 seconds, full-runner outer330→390 seconds.
Last accepted author full PostgreSQL measured285609ms. Previous focused23 measured
29765ms; current focused36 measured43436ms, an increment13671ms. The projected
sum299280ms would leave less than one second of the former shell budget. This is
an estimate from measurements, not a completed new full result. Only external
reserve changes; individual test timeout30000ms, concurrency1, exact suite commands,
coverage thresholds and kill/cleanup graces10/15 seconds are unchanged. Matching
safety/profile regressions are updated. Independent normalized-plan comparison and
exact new-SHA full completion remain required; a timeout is never a pass.

Budget regression runner: 30/30 passed. Initial standalone PostgreSQL safety invocation
used repository cwd instead of the profile's services/api cwd; three harness path
checks failed because scripts/audit.sh and sanitize-pg-env.sh were resolved incorrectly.
The log is retained; no product or safety assertion was changed for this invocation.
Correct profile cwd rerun: all nine PostgreSQL safety tests passed. Independent read-only
budget review compared complete generated plans using the same root; deepEqual after
normalizing only real-postgres390000→330000 passed. Inner launcher byte-identical.

## Post-997c12b product clarification

997c12b passed author FULL11 but was not independently accepted. The owner clarified
that unchanged text must not acquire an Edited label. The candidate is revised so
normalized same-body saves retain the current version and write only an immutable
no-op receipt. Real edits increment version; restoring original text after an edit
keeps the Edited label. Both participants observe canonical revised text and labels
after a fresh read, including source detail and selected reply preview. Already
delivered notifications are not rewritten; no such capability is claimed. Previous
997c12b reports/archives are preserved and do not substitute for the new SHA's gates.

### Revised no-op focused evidence

API54/54, mobile1890/1890 (86 suites), typecheck/lint passed. Mobile coverage
S96.75/B96.15/F97.76/L98.61; API changed-file S98.71/B99.14/F100/L99.25.
Actual PostgreSQL37/37 passed in45961ms, including connected normalized NFC/CRLF
unchanged saves, both participants' refreshed canonical text/version, original detail
and selected reply previews. Version sequence1→1→2→2→3 demonstrates unmarked no-op,
real edit, no-op after real edit, and restoration remaining marked. Outbox count is
unchanged. The new candidate still requires its own frozen author/independent FULL11.
