# Authenticated session context discovery

Status: implemented and author-verified; independent review pending. This is a read-only discovery endpoint in the composed API, not account/pair provisioning or a deployed login service.

## HTTP contract

`GET /v1/session/context` accepts no query parameters, request body, user ID, pair ID or membership epoch. POST and other methods return 405 with `Allow: GET`; query parameters/body transport return 400. Every composed request requires the existing exact trusted Origin, or Expo-origin only when Origin is absent. A valid official Better Auth cookie is required, and Authorization headers are rejected. No bearer fallback exists.

Successful responses contain only `ok: true` and one `value` variant:

- `{state: 'unmapped', sessionId}`: verified provider session with no domain mapping.
- `{state: 'no_active_pair', sessionId, userId}`: live mapped domain user without a current active pair.
- `{state: 'waiting_partner', sessionId, userId, coupleId, membershipEpoch}`: own waiting space with exactly one active member, the caller in slot 1; never chat authorization.
- `{state: 'ready', sessionId, userId, coupleId, membershipEpoch}`: current active pair selected from server membership.

`sessionId` is the nonsecret verified Better Auth session ID, not its token. Mobile can match it against official getSession output before using the response. No token, provider user ID, email or profile fields are returned. `userId` and `coupleId` are domain UUIDs. Responses have `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

Absent/invalid/revoked/expired/deleted provider sessions return 401. Deleted domain users and an observed mapping change also fail closed with 401. Invalid/ambiguous database context and unexpected failures return only `{ok:false,error:'temporarily_unavailable'}` with 503. The composed origin perimeter returns 403 before provider verification. Context is not an authorization grant: all chat operations independently recheck the session, mapping, active pair and membership epoch.

## Composition and transaction protocol

The composed factory uses the same existing Better Auth instance and exact caller-owned pg.Pool for auth, context and chat. Cookie caching remains disabled. `better-auth-session.ts` shares official-output validation and authoritative provider-session SQL with `createBetterAuthAuthority`; there is no copied cryptography, token parser or alternate session schema.

`createSessionContextHandler(database, {getSession, trustedOrigins})` is the internal composition entry point. It first calls official getSession, then performs discovery and authoritative checks inside one domain transaction:

1. Discover the candidate domain mapping without taking a lock. Reject ambiguous/malformed IDs.
2. If mapped, lock the live domain user `FOR SHARE`.
3. Lock the provider user and matching provider session `FOR SHARE`, then sample PostgreSQL clock_timestamp() and recheck ownership/creation/expiry.
4. Read and lock the mapping again. A mapping added, removed or changed since discovery is rejected, never silently followed.
5. Discover the active membership candidate, lock that couple `FOR SHARE`, and reread memberships in a fresh READ COMMITTED statement. Validate cardinality, UUID, allowed pair status and integer epoch. A waiting pair must have exactly one active member: this caller in slot 1.
6. Recheck authoritative provider session time after mapping/couple waits before returning any successful snapshot.

Lock order matches chat: domain user → provider user/session → mapping → couple. Provider revocation waits when context already holds the session lock. Revocation completed after official verification but before the authoritative transaction returns 401. The shared verifier retains the existing conservative second-rounded expiry, possibly rejecting up to 999ms early.

If membership disappears while waiting for the couple lock, return no_active_pair. If it moves to another pair during that wait, return opaque 503 and let a later request rediscover rather than adding a new lock-order path. Closed pairs return no_active_pair. A valid own waiting pair returns waiting_partner; malformed waiting membership fails closed with opaque 503. Absence of mapping or membership is a safe snapshot, not a claim that insertion is blocked. Mapping mutations and general membership lifecycle operations remain unsupported runtime features; tests mutate synthetic fixtures only.

This context route adds no migrations, listeners, provisioning, pair creation, client identity fixtures, persistent credentials or production access. Separate default-disabled synthetic actions are documented in [PROFILE_PROVISION.md](PROFILE_PROVISION.md) and [WAITING_SPACE.md](WAITING_SPACE.md). Waiting-space changes and current gate counts are recorded in the latter; the counts below describe the original context milestone. Existing API and mobile deployment/native-device limitations still apply.

## Checks

Run from services/api: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:safety`, `npm run verify:postgres`.

Author checks: 119 API unit/SQL tests and all 17 real PostgreSQL groups passed. The six new PostgreSQL groups cross real loopback HTTP and exercise three context states, two-pair isolation, strict selectors/origins/methods, epoch/pair refresh, expiry/deletion/revocation, opaque SQL errors, revocation between verification and transaction, session-lock contention, and unsupported mapping remap detection. Fixtures use official provider output, disposable synthetic users and the existing bounded PostgreSQL harness. No live accounts or data were used.

Coverage across API/domain runtime: 99.79% statements, 99.57% branches, 100% functions, 99.71% lines. Both new runtime modules have 100% statements/branches/functions/lines; all production source files remain included and the ≥90% thresholds are unchanged. No dependencies or lockfiles changed. Fresh evidence is in `evidence/session-context/`; parent maintains top-level Map/Memory/ROADMAP and final revision acceptance.
