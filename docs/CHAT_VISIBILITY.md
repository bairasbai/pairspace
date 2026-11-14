# Personal chat visibility: approved scope

Base c6f8db30d55c274fac1c337204246ce33a2e14b8 was independently accepted.
New standalone pairspace-chat-visibility; no publication/production/personal data.
Three physical dependency directories copied read-only from accepted author and verified
by complete fresh file hashes/symlink targets (87117 entries), lockfiles identical.

Hide/restore is actor-private filtering, not deletion or revocation of previously
received copies. Message content/version/reply identity remain unchanged. The partner
gets no personal hidden flag, changed revision, notification or outbox fact.

- Per-message visibility CAS and immutable command receipt, plus one monotonic global
  revision per actor+pair+epoch. No per-message visibility ledger accumulates in RAM.
- Opt-in X-Chat-Visibility:1 requires X-Chat-Visibility-Revision. Missing is invalid,
  never assumed0. Revision and canonical body/error projection are captured in the
  SAME authorized transaction with pair lock held, not queried after handler commit.
- Old strict routes retain visible DTO shapes, filter hidden records and fail closed
  on hidden body replays. New exact committed hidden replay is an explicit hiddenMessage
  metadata-only union, no body; hidden alone is not deleted or an unknown write.
  An explicit non-null deletedAt in that canonical metadata also establishes the
  existing terminal deletion barrier; restoration must never resurrect it.
- Personal hidden history is metadata-only, bounded50-row navigable windows with
  scoped anchors. Anchored pages bind global revision and restart after visibility change.
- Metadata GET precedes hide confirmation for current CAS version; initial visible0,
  restored rows retain their own higher version. Cancel before PUT performs no write.
- Higher global revision clears derived window/detail/reply preview/editor baseline and
  accepted outgoing body display. Old-revision body responses are not published;
  explicit refresh establishes a current projection, no automatic GET/POST.
- Exact unresolved command buffers and genuinely new private drafts survive, but old
  pending body is not briefly shown during retry before current visibility reconciliation.
- Session/credential denial keeps precedence over stale visibility. Scope/logout reset,
  cookie and asynchronous digest checks remain. Terminal deletion always dominates restore.

Required proof: private projection/flags across two participants/pairs; native body-read
lock held against concurrent hide proves atomic revision; held HTTP old response is
rejected after newer revision; reverse order; exact receipt/no-op/changed intent/CAS;
restore current edited body or tombstone; hidden source detail/replays do not bypass;
61+ hidden records complete navigation; old-account ACK/newdraft/401 fencing.

No realtime, native-build, durable queue, read-receipt, notification erasure or E2EE claim.
Existing500 tombstone and500 edited-version safety bounds remain separate limitations.
Sequential focused/API/mobile/actualPG then frozen FULL11 and independent acceptance.

## Author checks before frozen-source verification

Focused API 63/63, mobile 1940/1940 and actual PostgreSQL/HTTP 51/51 pass.
The native suite includes a 251-message history with hidden boundary rows and an
entire 50-message middle page; complete visible traversal, unchanged partner
projection and restoration pass. Hidden then author-deleted sources restore only
terminal metadata. A separate own lost-ACK test deletes while visible, then hides
the retained tombstone before replay; fresh deletion while personally hidden is
intentionally refused. Query locks prove revision/body are one atomic projection.
Initial fixture failures and corrected-run evidence are retained outside this source.
Full 11-gate verification and independent exact-SHA acceptance are still pending.
