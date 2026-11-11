# Shared songs: baseline verification candidate

Historical title/explanation-only scope. Optional links are now covered by
[the song-link candidate](SONG_LINKS_EVIDENCE.md); this report describes its baseline.

## Scope and provenance
Baseline local 9b8bd83c038b6a17d10c0b01de99556097ea067e, tree
f5991d880c983b63aafe8c6f3e6f889643870bdf (published equivalent a5f292d1).
Separate checkout and branch; existing main/Kimi and offline demo preserved.
Title + explanation only, independent songs collection; not full Tan Ata parity.
See [contract](SHARED_SONGS.md). No external dependencies added.

## Acceptance scenarios
- Real synthetic mobile controller → authenticated loopback HTTP → PostgreSQL:
  explicit partner consent, RAM-only draft, title/explanation publication,
  actual committed lost ACK, immutable retry, preserved newer draft, partner read,
  foreign-pair denial and pair-closure cleanup. Exactly one persisted song.
- Independent DB tests: latest50 deterministic tie order, normalized Unicode,
  empty/oversize/invalid inputs, strict fields including unsupported music_url,
  pair/epoch scope, former members, session expiry/revocation and closure races.
- Unit/component RU/EN: immutable pending summary, error/retry/conflict, draft
  change invalidates consent, clear-and-retype survives old ACK, session/user/
  pair/epoch invalidation, malformed/foreign/oversized list and ACK rejection.
- Text-only UI exposes no playback/open-link actions and discloses no edit/delete.
  No automatic operations, tracking, imports or private-data derivation.

## Verification protocol and status
Status: implementation candidate, NOT independently accepted.
The existing fail-closed runner must pass all eleven required stages on the exact
clean frozen SHA. It includes all own production files even if unimported;
all four global API/domain and mobile/domain coverage metrics must remain >=90.
Runner also checks source bytes/modes, dirty state, subprocess exits and timeouts.
Full JSON report, command logs and checksums live outside tracked source and are
sent to the coordinator for independent exact-SHA acceptance before publication.
No test pass is inferred in advance from the presence of test code.

Existing pinned API/mobile dependencies are physically copied, not symlinked
or newly downloaded. Scratch on-disk TMPDIR and temporary HOME isolate caches.
All stages run sequentially and Expo JS export stays bounded to two workers.
Native iOS/Android, two-device E2E and legacy Next build/typecheck: NOT_RUN.
E2EE and production security/readiness: not established. JS export is not native.
No production, real user data, personal computer, preview deployment or paid service.
