# Explicit own waiting space

Status: implemented; author gates passed; independent review pending. Synthetic loopback only. No publication, external sharing or production onboarding.

A mapped profile with no open space can explicitly create one waiting for a partner. Profile creation and sign-in never do this automatically. The mobile action is available only from no_active_pair or an uncertain waiting-creation retry state. The default App remains network-disabled; Kimi styling, navigation and central heart are preserved.

## Existing schema semantics

No migration is needed. couples already supports waiting_partner, active and closed. A new waiting couple gets one active/live membership for its creator in slot1. The existing one_active_couple_per_user partial unique index applies to this live membership regardless of couple status, reserving the user's single open slot. “Active membership” does not mean “active pair”: chat still requires couple.status=active and its existing two-member constraint.

This stage creates no second member, invite token, notification, join or activation. A valid own waiting space contains exactly one active member, the creator in slot1. Corrupt/ambiguous waiting states fail closed instead of being repaired automatically. An existing active pair, or a closed pair with an unexpected live membership, blocks creation; nothing is closed, reassigned or bypassed.

## API and transactional behavior

POST /v1/spaces/waiting accepts application/json with {} only, no query selectors or client user/pair IDs. enableSyntheticWaitingSpaceCreation defaults to false, and enabling it requires a loopback baseURL. It is independent of the profile-provisioning flag.

The server derives the live mapped profile from the verified current cookie session. Domain-user FOR UPDATE serializes requests from separate sessions before provider/session/mapping/couple locks. Session validity is rechecked after contended locks. Couple UUID is server-generated; couple plus creator membership are inserted atomically. Any failure rolls both back.

Response: {ok:true,value:{sessionId,userId,coupleId,membershipEpoch,created}}. 201 means created; 200 returns the same existing valid own waiting space. This is idempotency for the current open-space lifecycle, not a durable command history across future closing/reopening workflows, which remain separate work. No endpoint in this stage closes or reopens a space.

Context now distinguishes waiting_partner from no_active_pair and ready, returning only the current user's domain ID, own couple ID, epoch and nonsecret session ID. No partner identity or contact information is exposed. The waiting context never creates a chat queue or grants send/history access.

## Mobile generation and unknown outcomes

The action captures a cookie snapshot and preflights context with that exact cookie. It verifies the same provider session and previously discovered domain profile. A changed account/session/profile cannot silently receive the mutation. If the server already reports waiting or ready, the client rediscovers without another POST. Otherwise the captured cookie is sent with {}.

After acknowledgement the client ignores returned IDs as authorization inputs and rediscovers authoritative context. Waiting displays a dedicated RU/EN notice with refresh/logout only, without a composer or invitation action. A manual refresh may reflect a later authoritative state; this feature itself cannot join or activate anything.

Busy state coalesces repeated clicks. Logout/cancel increments generation and aborts networking without waiting for the server mutation. Late cookie, preflight, acknowledgement or rediscovery callbacks cannot restore stale state. Cancellation cannot undo a committed SQL transaction. A lost response offers explicit retry, which first rediscovers an already-created waiting space rather than duplicating it.

## Verification and limits

Unit/component tests cover explicit action, strict body, exact cookie/session/profile binding, active-pair refusal, terminal errors, unknown outcomes and seven cancellation stages. Real mobile controller → loopback HTTP → PostgreSQL creates a profile and waiting space through their actual endpoints without injected client mapping, simulates a lost acknowledgement, checks exactly one membership, and verifies both mobile and server deny waiting chat.

Server tests cover concurrent sessions, revoke-first/write-first races, expiry during lock waits, deleted profiles, rollback, invariant rejection, no bypass of existing active pairs and separate-account isolation. No invite or notification is sent and no external account/data is used.

Native I/O is mocked in unit tests; real SQL tests use the official Node auth-client fixture. iOS/Android Metro/Hermes export is JavaScript bundle evidence, not native build, hardware SecureStore, device or two-device proof. Dependencies/migrations are unchanged and prior audit findings remain unresolved. Current evidence is in evidence/waiting-space.

## Recorded author gates

592 mobile tests passed across 18 suites; global coverage 96.47% statements, 95.95% branches, 97.22% functions, 97.12% lines. Controller coverage exceeds 96% in every metric and the waiting/context clients have 100% coverage. API: 141 unit/SQL tests, 8 safety tests and 43 real PostgreSQL groups passed; all-runtime coverage 99.68/99.53/100/99.78%. Strict TypeScript and lint passed for both packages. Independent review remains required.

Both normal and real-auth-import iOS/Android Metro/Hermes exports passed. This remains bundle evidence only, not native-device proof.
