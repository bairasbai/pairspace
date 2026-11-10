# Authenticated context discovery

Status: implemented; author checks passed; independent review pending. Synthetic loopback only, no publication or deployment.

The mobile configuration now contains only mode and exact loopback baseURL. It cannot select a domain user, pair or membership epoch. The existing origin-bound official Expo/SecureStore client and explicit opt-in runtime remain unchanged; the default App still opens only the preview without networking. Kimi styling, navigation and central heart are preserved.

## HTTP contract

GET /v1/session/context accepts the existing official session cookie and exact trusted Origin. No query selectors or body are accepted. Successful JSON is {ok:true,value:...} with one of:

- {state:"unmapped",sessionId}: valid provider session with no domain mapping.
- {state:"no_active_pair",sessionId,userId}: own mapped, nondeleted domain user has no current active pair.
- {state:"ready",sessionId,userId,coupleId,membershipEpoch}: own active context.
- {state:"waiting_partner",sessionId,userId,coupleId,membershipEpoch}: own valid waiting space; no chat access. See WAITING_SPACE.md.

sessionId is the nonsecret verified provider session ID, not a token. The client compares it with the verified sign-in session before accepting domain context. No profile details, partner IDs, account email, cookie or token is returned. Invalid/revoked sessions return 401; wrong origin is rejected by the existing perimeter. Unexpected failures are opaque.

The endpoint uses the same official Better Auth instance and PostgreSQL database as chat. Provider verification is shared with the existing authority. Inside a single SQL transaction it rechecks provider user/session/expiry and mapping, then reads the current active couple/membership. Lock order remains compatible with chat. Mapping changes observed during discovery fail closed. Empty mapping/membership results are safe snapshots, not grants, and concurrent future changes may make any returned context obsolete.

This context endpoint itself does not provision or mutate accounts. A later explicit synthetic profile action is documented in PROFILE_PROVISIONING.md; pair creation, invitations and production signup remain unavailable.

## Client lifecycle

Initial verified sign-in remains busy until discovery returns a usable context. Every refresh and send discovers context again using the official cookie; both response byte size and time are bounded. The parser accepts only known state variants, validates UUIDs/epoch and exact session ID, and discards extra fields.

If domain user, couple or membership epoch changes, the controller increments its local generation, aborts old requests and clears draft/history/pending commands before establishing the new context. An attempted send that discovers a change does not send its captured old draft. The user must compose a new message. Context failures block chat access and scrub private state; retrying official logout remains available. An unmapped state can now retain its verified identity solely for the explicit profile action described in PROFILE_PROVISIONING.md.

Older discovery results cannot replace newer data. Any authoritative denial in the same current generation still blocks access. Logout/session changes supersede all old callbacks. Context discovery is outside the serialized auth mutation queue so a slow response does not hold up logout. Server chat authorization remains mandatory even after successful discovery.

## Evidence and remaining limits

Tests cover wrong selectors, unmapped/no-active-pair, revoked sessions between verification and transaction, active context changes, malformed responses, wrong session binding, stale callbacks, command/draft isolation and real loopback HTTP → official auth → PostgreSQL. The mobile PostgreSQL scenario no longer injects any identity map into client configuration; only the server's test fixture provisions synthetic identities and pairs.

Unit/component tests use mocked native I/O. Real PostgreSQL tests execute mobile controller/transport with an official Node client fixture; this is not native Expo/SecureStore execution. iOS/Android Metro/Hermes exports prove JavaScript compatibility only. Native builds, hardware SecureStore, two-device tests, production deployment and account provisioning remain unverified/out of scope.

Run mobile typecheck/lint/test/export and API typecheck/lint/test/test:safety/verify:postgres as documented in AUTH_INTEGRATION.md. Current evidence is under evidence/session-context; previous evidence/mobile-auth is historical. No coverage thresholds or inclusion of unimported production files were relaxed.

## Recorded author checks

388 mobile tests passed across 14 suites. Global coverage: 95.84% statements, 95.12% branches, 97.05% functions, 96.64% lines. Context parser/config have 100% coverage, and controller exceeds 95% across all metrics. API: 119 unit/SQL tests, 8 safety tests, 17 real PostgreSQL groups, coverage 99.79/99.57/100/99.71%. Strict TypeScript and lint passed in both packages. Both ordinary and real-auth-import iOS/Android Metro/Hermes exports passed.

Auth/client/controller configuration is snapshotted before use. A regression mutates the caller's original port and host after construction and confirms no discovery/chat request or cookie moves to that new origin. No dependencies changed; the prior audit findings remain unresolved, not silently waived.
