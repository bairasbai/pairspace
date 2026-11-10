# Immediate synthetic letters: verification record

Status: implementation checkpoint, independent exact-SHA acceptance required.
Baseline local `3a310c639022624100082f0eb14984da63e03673`, tree
`99984a90f43d76d929a052bd6126fc437c797ca3`, identical to published
`a08c26d3d07969dbedb2998bed3849b9b0d1dfd4` tree supplied for this task.

## Bounded scope

Private RAM-only compose → explicit send-now → partner's latest-30 metadata window
→ explicit body opening. Immediate available letters only, not the entire Tan Ata
letters feature. No drafts stored server-side, scheduling, sealed/release logic,
read receipts, replies, edit/delete, push, AI, sender archive or pagination.
Default App and Showcase remain offline; connected actions require explicit
synthetic controller injection and independently enabled loopback letters API.
No production, remote publication, preview, Space or real personal data was used.

The API locks the pair and current members, checks exact two-person membership and
epoch, rechecks the authoritative session after lock waits, and derives recipient
from that membership. Every body access is recipient-only and scope-bound. Missing
and inaccessible letter IDs have the same unavailable response. List SQL excludes
body, preview and title. The latest-30 limit is disclosed, not presented as archive end.

Immutable send commands preserve normalized body/client ID across unknown ACK;
changed content/scope/epoch conflicts without overwrite. New draft edits survive
old acknowledgement. Client generation/context/cookie checks reject late results;
logout and scope reset clear private RAM. Closing a pending open suppresses its late
body without abandoning an unresolved send. No content in URLs, logs or outbox.

## Local checks

Results and full command logs are in `docs/evidence/letters/`.
- API: 185 tests / 26 suites passed; statements 99.82%, branches 99.44%,
  functions 100%, lines 99.87%. API TypeScript and lint passed.
- Mobile: 1059 tests / 35 suites passed; statements 97.45%, branches 96.78%,
  functions 98.61%, lines 98.44%. Mobile TypeScript and lint passed.
- Disposable real PostgreSQL: 103 tests passed against final source. Includes
  two-pair isolation, revoked/expired sessions, lock races and rechecks, exact epoch,
  cross-letter IDs, normalized/hostile text, strict invalid requests, concurrent
  duplicate/conflicting commands, rollback and replay after pair change.
- Actual mobile controller → API → PostgreSQL: RAM draft is absent before send,
  lost committed ACK retries the original ID/body, newer draft survives, metadata
  does not include body, explicit recipient open/close, epoch reset and sign-out.
- Root tests 9/9 and PostgreSQL safety harness 9/9 passed.
- iOS and Android JavaScript exports passed with Expo telemetry disabled.
- Diff whitespace check, handwritten file limit ≤600 lines, unchanged dependencies
  and offline App entry verified. No native/device tests were run.

A first additional read-lock test exposed an invalid synthetic fixture transition
(one revoked member while pair remained active). Fixture now closes the pair in the
same transaction, respecting the existing deferred two-member constraint. The full
103-test suite passed after correction. Final self-review also added unknown ACK →
404 → edit → retry cases: a pending command remains visibly a retry, never mislabeled
as sending the newer draft. Full checks were rerun after final source changes.

Existing pinned dependencies were copied locally from the prior verified checkout;
no dependency versions changed. Checks cover synthetic code and JavaScript, not
production configuration or device behavior.

## Remaining gates

Independent review of the frozen SHA is required; the author does not accept its
own work. Native iOS/Android rendering, accessibility, background/foreground and
real two-device QA are not performed. JavaScript export is not a native build.
Durable restart recovery, production privacy/security/operations, E2EE, retention
and abuse control remain future gates. Server plaintext synthetic storage is not
ready for real private correspondence. Root Next.js typecheck/build is not rerun:
its pre-existing dependency graph is unavailable; Next source is unchanged.

## Evidence formatting correction

The first frozen commit's pre-stage whitespace check did not include untracked
logs, so its blanket diff-clean statement was too broad. Independent review
accepted the runtime scope but found trailing spaces and extra blank EOF lines in
committed generated logs. A follow-up commit normalizes only those log whitespace
characters and records this correction. The complete baseline-to-final diff
(`git diff --check 3a310c639022624100082f0eb14984da63e03673 HEAD`) is checked again.
No runtime, migration or test source changed; the successful full independent
checks of `bf58ae698fa5b92541f215716b79cffd35eccc4f` still apply to identical code.
