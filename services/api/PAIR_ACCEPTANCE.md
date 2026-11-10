# Explicit synthetic invitation preview and acceptance

Status: implemented; independent acceptance pending. This checkpoint is API-only, default-disabled, loopback-only and synthetic. It activates an existing waiting pair using an explicitly accepted opaque invitation. It adds no delivery, email, push, mobile screen, deep-link handling, production onboarding, public service or production data access. Issuance remains the separate [invitation contract](PAIR_INVITATIONS.md).

## Enablement and perimeter

`createApiApplication` accepts independent optional `enableSyntheticPairAcceptance?: boolean`. Omitted/false means both routes are absent (404), regardless of environment variables. True requires an explicit loopback baseURL host (`127.0.0.1`, `[::1]` or `localhost`). Non-booleans are rejected. Enabling this flag does not enable profile provisioning, waiting-space creation or invitation issuance.

Both routes accept POST only, returning 405 with `Allow: POST` otherwise. Every accepted POST passes the existing request-byte, body-read-deadline, transaction-statement and lock limits. Query strings are forbidden. Content-Type must be application/json; charset parameters and JSON whitespace are accepted. Exact trusted Origin is required, with Expo-origin considered only when Origin is absent. Authentication is the official current Better Auth cookie, with cookie caching disabled and no bearer fallback. All responses use no-store and nosniff.

The token is a canonical unpadded base64url encoding of 32 cryptographic bytes: exactly 43 characters, decoding to 32 bytes and round-tripping unchanged. Noncanonical trailing bits, padding, whitespace, malformed UTF-8/JSON, arrays and additional fields are rejected. Lookup uses Node crypto SHA-256 of the token. Raw tokens never enter SQL parameters or persisted state. The host must not log tokens, cookies, request/response bodies or SQL parameters. Successful responses are fixed bounded shapes with no arbitrary stored text; no issuer identity, contact information or token/hash is returned.

## Exact HTTP contract

- `POST /v1/pair-invitations/preview` accepts exactly `{token}`. Successful 200: `{ok:true,value:{state:'available',expiresAt}}`. `expiresAt` is a UTC ISO timestamp. Preview performs no writes, consumes nothing and reserves no slot. It means the invitation is available to this recipient at this snapshot only. Another request may accept or revoke it immediately afterward.
- `POST /v1/pair-invitations/accept` accepts exactly `{token,accept:true}`. Successful 200: `{ok:true,value:{state:'accepted',sessionId,userId,coupleId,membershipEpoch,replayed}}`. `sessionId` is the recipient's nonsecret current provider session ID, never its credential. `userId` and `coupleId` are server-selected UUIDs. First acceptance returns the incremented epoch and `replayed:false`; a valid retry returns the current epoch and `replayed:true`.

No owner, recipient, provider, session, couple, invite ID, slot or epoch selector is accepted. The token identifies a candidate invitation, not an authorization grant. Accept independently revalidates every condition whether or not preview was previously called. A GET, link open, preview or missing/false `accept` never creates membership.

Errors are exactly `{ok:false,error}`:

- 400 `invalid_request`: invalid query, JSON/UTF-8, shape or token syntax. Oversized/stalled composed body reads retain 413/408 (a Node adapter may close a stalled socket).
- 415 `unsupported_media_type`; 405 `method_not_allowed`; unknown/disabled route 404 `not_found`.
- 403 `forbidden`: composed origin perimeter.
- 401 `unauthenticated`: missing/expired/revoked official recipient session or failed current authoritative ownership/time check.
- 409 `profile_unavailable`: missing/deleted recipient profile or changed/missing recipient mapping.
- 409 `invitation_unavailable`: unknown token, self-join, expiry/revocation, third-party consumption, changed target or issuer identity, deleted issuer, conflicting/historical target membership, non-waiting space or invalid current pair shape. The response never identifies another person or pair.
- 503 `temporarily_unavailable`: unexpected errors, missing schema, malformed/ambiguous stored data, failed write acknowledgements or uncertain transaction result. Details and SQL/provider errors are redacted.

A malformed token is rejected before authentication; a canonical token is checked only after official session verification. Unmapped recipients must provision their own profile separately. Neither route creates profiles or waiting spaces.

## Transaction and lock protocol

1. Discover the recipient domain mapping, invitation by token hash and issuer provider mapping without row locks. Missing invitation or self-join is unavailable. These reads select candidates only.
2. Lock **both recipient and issuer domain users FOR UPDATE in stable UUID order before any provider, session, mapping, couple or invitation lock**. Require both profiles to exist and be live. This serializes accepts across different sessions of the same recipient and avoids opposing owner/recipient lock-order cycles.
3. Lock the issuer provider user FOR SHARE and recheck the recipient provider user and exact current session FOR SHARE. Reread both identity mappings FOR SHARE; each must match discovery. The issuer must still have a provider identity, but no issuer session is required. Owner logout alone does not cancel an issued invitation.
4. Lock the discovered couple FOR UPDATE, then reread the invitation by the same hash FOR UPDATE. Compare locked invitation ID, hash, issuer and couple to discovery; never follow a changed target.
5. After all these potentially contended locks, `lockedBetterAuthSessionTime` rereads the recipient's exact owner-matching session and obtains fresh PostgreSQL `clock_timestamp()`. Its time must be within authoritative creation/expiry and the originally verified expiry. This same time determines invitation expiry and consumption. Waiting beyond invitation/session expiry cannot grant membership.
6. Require issuer's current live membership to remain in this couple, slot 1, and exactly one active member in a waiting couple. For a new acceptance the recipient must have no active membership anywhere, including their own waiting space. An existing historical recipient tuple in this target couple is rejected rather than restored. Historical revoked memberships in other couples do not collide and are not rewritten.
7. Insert recipient slot 2 as active, set couple active and increment membership_epoch exactly once, then record consumed_at and consumed_by_user_id. All three writes occur atomically. Verify each RETURNING acknowledgement against the intended mutation; missing or malformed acknowledgements throw and roll back. The next epoch must remain in the existing application's positive PostgreSQL-int range (strictly below 2,147,483,647). There is no wraparound, UPSERT, reassignment or automatic retry.

All future supported identity/membership/status writers must use this lock protocol. Current product endpoints do not expose mapping reassignment, account merge, unpairing or arbitrary administration. The schema stores the issuer domain UUID, not original provider-identity history. Revalidation detects mapping changes observed between discovery and locking, not arbitrary administrative reassignments completed before discovery; no historical-provenance guarantee is claimed.

## Replay and interrupted responses

A consumed invitation is unavailable to preview and to any other recipient. The same recipient may explicitly retry acceptance only if both profiles/providers/mappings are still live, the recipient's session is currently valid, the pair remains active with exactly the original issuer in slot 1 and recipient in slot 2, and both current memberships still match. Closed, revoked, deleted or changed-membership states fail closed. No historical membership is resurrected.

For this valid replay only, expiry of the invitation's original TTL does not revoke an already committed membership. Stored consumption must still be coherent and strictly before the original expiry. Replay writes nothing and returns the pair's current valid epoch, not a cached response or fresh grant. It cannot double-increment the epoch.

A lost HTTP/COMMIT acknowledgement can leave the caller uncertain. There are no automatic database retries. A later explicit same-recipient acceptance safely reads committed state or, if nothing committed and the invitation is still valid, performs the first acceptance. A different recipient never receives the committed pair identity. If the invitation expired before any commit, retry fails. Because consumed-token preview is unavailable, a recovery client explicitly retries accept directly, then refreshes context rather than requiring another successful preview. Context and chat independently validate current pair membership and epoch after activation; stale pre-activation epoch 1 cannot authorize chat at epoch 2.

## Schema reuse and verification boundary

No migration, dependency, lockfile, new table, outbox type or notification was added. This stage reuses migrations 001–004: unique active membership per user, unique active pair slot, exact-two deferred active-pair constraints, invitation unique hash/current slot, tenant-bound issuer/consumer membership FKs and coherent consume/revoke timestamps. The acceptance transaction inserts the recipient before setting its consumer FK. No chat message or outbox event is emitted merely by pairing.

From services/api run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:safety`, and `npm run verify:postgres`. Unit tests cover strict input/canonical tokens, hash-only SQL, independent enablement, bounded streaming, stable user lock ordering, authoritative session/expiry rechecks, every write acknowledgement, conflicts, privacy and replay. PGlite tests compose waiting creation → issuance → preview → acceptance → replay using unchanged migrations and prove actual rollback after malformed acknowledgements of each write. Separate real PostgreSQL tests exercise official Better Auth through loopback HTTP, concurrent recipients/pairs, owner logout and lock races. These are not native-device, production deployment or completed security-review claims. Parent records final aggregate evidence under `evidence/invite-acceptance/` after the final exact revision is checked.

Production grants/RLS, abuse/rate limiting, token delivery/deep links, mobile consent UI, retention/unpairing, native two-device verification and independent security review remain separate work. This API-only synthetic stage does not make production pairing ready.
