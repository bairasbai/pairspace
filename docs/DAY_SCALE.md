# Voluntary shared day scale: bounded candidate

Approved bounded contract; implementation and independent exact-SHA acceptance pending.
Base accepted 5d93a7029cff05b1338fff8c244a459fe04a668f.

## Source grounding and usefulness
BACKLOG P1 names Scale explicitly among eleven conversation modes, and voluntary
mood/support with correction/removal. Current API/mobile has no scale module.
Read-only Tan Ata @4822e213e991f6e8c0177751e0fd6626b1f237bc:
- app/talk/scale/page.tsx: own/partner day ratings; missing is not zero; history.
- components/ScaleDial.tsx:0–100, explicit submit/correction; rating the day, not partner.
- lib/talk.ts scaleDays/setScale: one row per author/day, mutable own rating.
- app/talk/actions.ts rateDay: source uses a fixed configured city for today's date.
No original private values/names/configuration will be copied.
This is distinct from questions, blind rounds, dictionary and shared memories.

## Bounded user contract
1. Explicit shared daily rating, not a diagnosis, partner score, comparison/ranking or
   inferred mood. No reminders, penalties, streaks or obligation to submit.
2. Integer0–100 only, with accessible numeric input and explicit share/save action.
   Blank is unselected, not0; no implied/default50 can be published.
   Unsaved choice stays RAM; not a saved private journal. Copy says partner can read
   the published rating without publishing their own. No blind/unlock semantics.
3. Exact active couple epoch and actor-owned identity. Both active members may read
   shared ratings; only author publishes, corrects or removes their own value.
4. One stable slot per (couple,epoch,author,localDate). First publish also records
   explicit IANA zone, immutable thereafter. No gender/fixed original city.
   Entered zone spelling is preserved; runtime Intl validation and the database
   timezone-name catalog must both accept it. An unsupported case/alias returns
   invalid_request before writing, never an implicit canonicalization.
   Dates use valid Gregorian YYYY-MM-DD in2000–2100.
   New entry date must be today's date in supplied zone according to trusted server
   now after locks. Request includes displayed expected date; midnight mismatch
   rejects instead of silently saving another day. No past backfill in first slice.
   Old existing entries remain correctable/removable without a deadline. Re-sharing
   a removed existing entry is a new explicit publication, not restoring old value.
5. Missing date means no shared rating, never0. Removed row has SQL NULL value and omitted transport value, safe
   identity/date/zone/version metadata only. UI says no shared rating, not mood or
   refusal inference. Explicit removal warns already-read copies cannot be erased.
6. First publish v1. Changed rating or active->removed increments version. Same
   active value is no-op, unchanged version. Removed->active requires a fresh
   explicit publish command with supplied new value and current expectedVersion;
   never retrieve the previous value through this operation. Repeated new remove on removed is no-op if current
   CAS matches. No endpoint can modify partner's row or change slot date/zone.
7. Immutable command IDs/fingerprints and transaction receipts; replay returns current
   canonical slot, never original removed value and never republishes automatically.
   CAS conflict returns safe current canonical row scoped to actor authorization.
   Producer final auth after waits/receipt insert and exact sentinel rollback.
8. Bounded100 lifetime dated slots per author (including removed); complete snapshot
   <=200 rows. UI labels synthetic technical limit and remaining own capacity, not
   tariff/production quota. Partner cannot consume own allocation. At capacity own
   edits/removals/re-shares continue. No physical deletion/restore/revision archive.
9. History date descending; separate actor rows include explicit date and IANA zone.
   Same printed date is not proof both lived the same instant. No normalized
   cross-timezone emotional comparison or leaderboards. No chart required initially.
10. Only full GET establishes whole-list freshness; own ACK merges one canonical slot
    only. Known higher version fences stale response; removal cannot be undone by an
    old GET/ACK, but an explicit higher-version new publication may appear. Newer RAM
    input survives uncertain ACK/retry. Changed/removed canonical state marks editor
    stale, disables save until explicit reload/cancel. Session/epoch fences clear data.
11. No push/provider/OS/native/background/location/health integration or plaintext
    analytics. Default-off synthetic connected feature only, RU/EN. Existing features
    unchanged. No production/E2EE/durable-offline/native proof from these checks.

## Deliberate adaptations and limits
Source is today-only entry using fixed original city; our explicit IANA and
midnight rejection replaces that, not arbitrary backdated self-report. Own historical
correction is allowed by data model and labelled correction, not change to event date.
Own removal/re-sharing is an explicit privacy extension, not source behavior.
Current-value removal is not backup or cryptographic erasure. Idempotency fingerprints
are retained; a plain digest of a low-entropy0–100 value with known metadata is
guessable. No claim that database operators/backups cannot recover a previous
value. The authorized application API provides only current state, not a prior-value
archive. Fingerprints are never returned to clients or logged. A removed slot's existence/date remains
safe shared metadata since it was previously explicitly shared.
100-per-author complete-history cap is a synthetic engineering boundary only.

## Verification plan
Separate branch/worktree from accepted SHA; use current ask deps after allowed.
Pure integer/date/IANA validation and zone-boundary tests with injected clock;
controller/version/retry/RAM/session/removed-to-new-publication tests; HTTP exact
payload/idempotency/gate tests; real PG isolation/CAS/dedupe/removal/current replay,
actual membership FK wait+auth expiry rollback, per-author cap, distinct timezones.
No extra wall-clock minute fixtures: bounded heldlock tests and synthetic clocks.
Actual early independent review before clean freeze; archive byte restoration;
author FULL11 then independent FULL11 same SHA. Existing budgets API450s and
PG wrapper1110s/runner1140s unchanged; no test exclusions/threshold reductions.

## Candidate verification checkpoint
Focused backend36tests PASS,97.81/97.54/100/98.17 coverage; type/lint PASS.
One bounded real-PostgreSQL test PASS9.8s: isolation, CAS/current retries, fresh
republication, actual FK waits across midnight/auth expiry with rollback, actor
capacity and leave. No new minute-scale wait added. Mobile bounded67tests PASS,
98.50/98.79/100/100 coverage; type/lint PASS before final source formatting.
These are focused checkpoints, not independent final acceptance or native proof.
Frozen author and independent FULL11 remain required.
