# Scheduled synthetic letters: verification record

Status: implementation checkpoint, independent exact-SHA acceptance required.
Baseline local `e6a91a899423ac956a89d240c9087edc0a9bd714`, tree
`3f76b24c208d239cda394062fc967f76e7e7b858`, identical to published
`e9f761d299d1aa7b94e675b2ecb15c4716915bb5` supplied for this task.

## Bounded scope

This extends the immediate-letter synthetic loopback path with explicit send-later.
The immutable command binds body, canonical release instant and IANA timezone.
The request retains explicit wall-clock offset, resolving DST repeated hours by
user input and rejecting nonexistent wall time/mismatched offsets. The server
checks new schedules at 60 seconds–366 elapsed days inclusive after lock waits.
This is a provisional synthetic product policy, not a user-approved production
retention policy. Exact authorized replays remain valid after the window passes.

The additive 007 migration leaves existing rows immediate. Metadata contains no
body and exposes server-derived sealed/available state. SQL body reads include
the release predicate and use fresh trusted server time after authorization locks
and the final session recheck. Exact equality is available. Device clock, disabled
buttons and browser request parameters are not authorization. Neither list nor
opening records read receipts. No automatic job, push, opening or countdown exists.
Send/replay acknowledgements may echo the sender's own submitted text.

Mobile RU/EN keeps draft, schedule and unresolved command only in current-session
RAM. Unknown ACK retries the original ID/body/schedule even after edits. A valid,
exact invalid_request rejection can be corrected; malformed/uncertain responses
retain the old command. Recipient explicitly refreshes metadata, then explicitly
opens an available letter. Logout/scope/epoch resets clear private state; older
responses cannot restore it. Immediate send remains supported.

## Verification approach

Full command outputs are in `docs/evidence/scheduled-letters/`. The final source
is frozen only after local checks; the external archive manifest records its exact
commit and tree plus SHA-256 for the source archive and baseline patch. No commit
hash is self-embedded in its own tree.

Real PostgreSQL integration uses the existing guarded disposable loopback cluster,
not an in-memory replacement. Exact release/minimum/maximum boundaries and elapsed
lock waits use an explicitly injected trusted service clock. A separate actual
mobile controller → composed HTTP API → PostgreSQL test waits for the unchanged
stored scheduled instant to pass, refreshes, and explicitly opens. It does not
edit release_at as an acceptance shortcut. Its 75-second timeout and the full
suite's fixed 180-second outer cap accommodate the real 61-second wait; unrelated
operation/lock/cleanup deadlines and the ten-second kill grace remain unchanged.

Checks include two pairs, unauthorized recipient, epoch change, recipient replacement,
new-pair replay, expired/revoked sessions and member locks; no premature returned body,
no body/title previews or outbox delivery; immutable schedule conflicts and retries;
explicit DST gap/fold/offset checks and forward migration against existing rows.

## Results

- API: 190 tests / 28 suites passed. Statements 99.83%, branches 99.47%,
  functions 100%, lines 99.88%. TypeScript and lint passed.
- Mobile: 1083 tests / 35 suites passed. Statements 96.90%, branches 96.39%,
  functions 98.32%, lines 98.16%. TypeScript and lint passed.
- iOS and Android JavaScript exports passed with Expo telemetry disabled.
- Disposable real PostgreSQL: 109/109 passed, including the unchanged-instant
  mobile release wait. A second final-source pass verifies source hashes before
  and after the suite. PostgreSQL safety harness 9/9 and root tests 9/9 passed.
- Runtime dependencies and lockfiles unchanged; default offline entry unchanged.
  Handwritten files remain ≤600 lines; generated prior audit JSON is excluded.

## Corrections during implementation

The first API run passed 189 tests and failed a new HTTP fixture because it omitted
its synthetic Bearer header. The fixture was corrected, not the authentication gate.
Self-review tightened client response date/zone validation and made only an exact,
verified invalid_request response release a rejected command for correction.
Client availability enum validation now requires a literal string and rejects
array/object coercion. Scheduled lock-expiry and scope tests also check a
release-eligible body, so an
unavailable result cannot pass merely because the letter is still sealed.

## Remaining gates

Independent exact-SHA review remains separate; the author does not accept its own
work. Native iOS/Android, device Intl/timezone data, accessibility, lifecycle and
real two-device acceptance were not run. JavaScript export is not a native build.
Root Next.js typecheck/build remains the prior missing-dependency blocker; Next
source and dependency versions are unchanged. No production, preview, Space,
publication, external personal data or deployment was used in this implementation.

This server-readable plaintext storage is not E2EE or protection against the server.
Real personal correspondence remains gated on privacy/security/operations, retention,
encryption and native acceptance. Replies, editing/deletion, durable draft recovery,
read receipts, notifications, attachments and a complete letters archive remain
future slices. This does not complete every Tan Ata letters capability.
