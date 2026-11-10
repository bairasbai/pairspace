# Explicit synthetic profile provisioning

Status: implemented and author-verified; independent acceptance pending. This is a synthetic, loopback-configured runtime slice, not production onboarding or a deployed service. No production schema, account, backfill, pair or external service is changed.

## Opt-in and HTTP contract

`createApiApplication` accepts optional `enableSyntheticProfileProvisioning?: boolean`. Omission/false disables `/v1/profile` with 404, even if an environment variable claims to enable it. True requires an explicit loopback baseURL host: `127.0.0.1`, `[::1]` or `localhost`. Non-boolean values are rejected. The existing trusted-origin rules, request byte/time limits, explicit secret and exact shared caller-owned pg.Pool still apply. The factory does not start a listener or provision anything during construction.

`POST /v1/profile` accepts `Content-Type: application/json` and an empty JSON object `{}` only. JSON whitespace and charset parameters are accepted. Every query parameter and nonempty body object is rejected, including user, provider-user, session and pair identifiers. Other methods return 405 with `Allow: POST`. There is no UUID picker, client-selected mapping, bearer fallback or implicit signup/context provisioning.

The caller must have an official Better Auth cookie and exact trusted Origin, or Expo-origin only when Origin is absent. The same composed provider instance verifies the session, with cookie caching disabled. Successful responses are:

- First creation, 201: `{ok:true,value:{sessionId,userId,created:true}}`.
- Existing live mapping or retry, 200: `{ok:true,value:{sessionId,userId,created:false}}`.

`sessionId` is the nonsecret verified provider session ID. `userId` is a new server/database-generated UUID, never copied from the provider ID or accepted from the caller. No email, token, provider user ID or profile fields are returned. Responses use no-store and nosniff.

Invalid body/query returns 400; unsupported media type 415; byte/read limits retain 413/408 behavior. Absent/expired/revoked provider sessions return 401. Composed origin rejection returns 403. An observed mapping change, missing mapped domain user or soft-deleted domain user returns 409 `{ok:false,error:'profile_unavailable'}`. Ambiguous/malformed database data and unexpected failures return opaque 503. A 503/network failure can have an uncertain commit outcome: a later explicit retry is idempotent; the server never blindly retries a failed/uncertain transaction.

## Transaction protocol

The implementation uses the existing official session verifier and SQL recheck, with an exclusive provider-user lock for this operation:

1. Discover the candidate mapping without taking a lock. Reject malformed/ambiguous results.
2. If mapped, lock its domain user `FOR SHARE` and require `deleted_at IS NULL`.
3. Lock the verified provider user `FOR UPDATE`. This serializes simultaneous requests from different sessions of the same provider account, not just identical session IDs.
4. Lock the exact matching authoritative provider session `FOR SHARE`; check its owner, creation, expiry and PostgreSQL clock after the lock waits. No synthetic session store is consulted.
5. Reread the mapping `FOR SHARE`. Existing mappings must remain identical. If initially unmapped and a mapping appeared while waiting, end this read-only transaction and retry once from domain-user discovery. The second transaction must see that exact expected mapping and take the domain-user lock first. It never acquires an existing domain-user lock after a provider lock.
6. Recheck the exact authoritative session and current clock again after the mapping-lock wait. Return the existing live profile if mapped.
7. Otherwise `INSERT INTO users(id) VALUES(gen_random_uuid()) RETURNING id`, then insert the unique provider-to-domain mapping. Both writes commit atomically. There is no UPSERT, overwrite, reassignment or resurrection path. Any failed/invalid insert rolls back the new user too.

Existing lock order remains domain user → provider user/session → mapping. The new user insert occurs only for an unmapped provider while holding its exclusive provider lock. A completed revocation wins if it precedes the authoritative session lock; provisioning already holding the session lock makes a revoker wait until transaction completion. Expiry is rechecked after a real mapping-row lock wait as well.

Mapping deletion/reassignment remains unsupported outside synthetic fixture tests. A mapping removed before any observation is indistinguishable from a never-mapped account in the existing schema: this slice adds no tombstone/migration and makes no claim to recover that history. Once a mapping is observed, disappearance/reassignment fails closed. Soft-deleted users retain their mapping and are never resurrected. Production lifecycle and tombstone design require separate review.

No couple/membership/chat/outbox rows are created. A successful profile is visible through the existing context route as `no_active_pair`; it is not pair authorization, an invitation or a claim that onboarding/account recovery is complete. Every chat operation still independently checks current authority and membership.

## Verification

Commands from services/api: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:safety`, `npm run verify:postgres`.

Author checks: 129 API unit/SQL tests and 8 harness-safety tests passed. Coverage of all API/domain runtime, including unimported sources: 99.63% statements, 99.45% branches, 100% functions, 99.75% lines. The new profile runtime has 98.57% statements, 98.38% branches, 100% functions and 100% lines. The existing ≥90% thresholds were not weakened.

The real PostgreSQL suite has 28 passing groups, including ten profile server groups and the new mobile-controller profile lifecycle. Coverage includes default-disabled and explicit enablement, strict request contract, separate-account identity isolation, no implicit signup provisioning, distinct-session concurrent requests with a read-only retry and preserved lock order, lost real HTTP acknowledgement after committed creation, both revocation race directions, expiry after a mapping lock wait, deleted/mutated mappings, and rollback of both rows when identity insertion fails. The lost-ack test destroys the real loopback response socket after COMMIT; it does not claim to simulate loss of PostgreSQL's COMMIT acknowledgement.

Sources: `src/profile-provision.ts`, `tests/profile-provision.test.ts`, `tests/postgres/profile-provision.integration.mjs`, `tests/postgres/profile-fixture.mjs`. Evidence is under `evidence/profile-provision/`. Mobile evidence/limitations are documented in `apps/mobile/PROFILE_PROVISIONING.md`. No dependency or migration changed. Full production auth lifecycle, live services, native device/two-device verification, security audit and independent acceptance remain open. Parent maintains top-level Map/Memory/ROADMAP.
