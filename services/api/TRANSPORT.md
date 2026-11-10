# In-process transport prototype

`createChatHandler(database, verifier)` requires a trusted verifier implementation. There is no
runtime fallback, login, token issuance or provider SDK. AUTH.md describes the added jose verifier
and SQL identity/session references; this still is not an end-user authentication lifecycle. Legacy tests contain synthetic opaque-token maps; signed integration tests use ephemeral keys
and genuine JWT verification against synthetic SQL identities/sessions. This is not authentication shipped
for users. The jose verifier checks authenticity, expiry and session revocation; each use case repeats the
session/user checks inside its transaction before checking couple membership.
A verifier failure returns a generic 503; invalid/expired/revoked credentials all return opaque 401.
That response is not proof of membership revocation and must never erase queued text. Never use test token maps
in production. Sessions and couple membership are separate checks.

## Prototype using v1 routes, not the complete v1 contract
- POST `/v1/couples/{id}/chat/messages`: `{client_message_id,membership_epoch,body}` with matching Idempotency-Key and application/json.
- GET the same path with `membership_epoch`, `limit` (default 50), optional `beforeSeq` query.
- Both require `Authorization: Bearer …`. New send returns 201; replay/history 200, with internal
  `{ok:true,value:…}` DTOs. The send response contains canonical message + replay flag.
- Couple identity always comes from the path; any body couple/user/sender override is ignored.
- Validation errors: 400, missing/invalid session: 401, unavailable membership: 403, conflict or
  stale epoch: 409, unsupported content type: 415, unexpected verifier/SQL failure: generic 503.
- Reads/sends always query SQL membership. Forged sender/user fields cannot replace the principal.
- JSON stream consumption is capped at 65,536 bytes, independent of Content-Length; malformed
  UTF-8/JSON is rejected. Responses are no-store. No request/SQL/body/token logging exists.

This is a temporary test seam. `docs/CHAT.md` v1 still requires snake_case response
DTOs, opaque cursors instead of beforeSeq, 404 unavailable, editing/deletion and sync.
The paths/methods match v1, but do not expose this prototype or claim full compatibility with that contract.
No HTTP listener, network deployment, CORS policy, TLS termination, request timeout, rate limiting,
CSRF/cookie policy, auth provider, account system, RLS or production driver is included.
The streaming cap bounds buffered bytes; a real server still needs connection/time/concurrency limits.

## Mobile adapter
401 pauses and preserves the queue with `auth_required`; generic 403 also pauses with
`access_required`. Sending and history requests stay paused pending trusted revalidation;
no automatic resume is performed. Only an explicit trusted membership-revocation event or logout may clear it.
429 returns `rate_limited` and preserves queued records without an automatic retry loop. The caller
must schedule/back off explicitly; this prototype does not implement a Retry-After scheduler.

The standalone adapter in `apps/mobile/src/chat/transport.ts` uses an injected Request/Response
transport and trusted session context. It is not wired into the mobile UI. Store writes are
synchronous reducer transitions; a late response cannot change a new login/session's queue.
Each operation captures a mandatory credentialGeneration and checks it against a trusted getter
before settling responses. Increment it on every credential replacement, even within the same scope.
The trusted refresh coordinator must pause/requeue prior in-flight sends before resuming with the
new credential. Old-generation responses cannot pause the fresh session or settle its sends.
Tokens are supplied per operation, never stored in queue state or logged. HTTPS is required by default. An explicit test-only switch permits HTTP only on loopback hosts.
Do not pass credentials to an untrusted base URL/transport. Real TLS, secure token storage and provider integration remain work.
History is a validated response page, not a durable local database, sync protocol or chat screen.

## Verification boundary
Tests exercise synthetic users only, in-process handler and embedded PGlite. They cannot prove
real authentication, concurrent PostgreSQL behavior, network security, native runtime or 24/7 uptime.
Independent review of this revision is required. The application remains an unconnected preview.

Typechecking uses Bundler resolution to include React Native source in cross-layer tests.
No emitted Node build is provided; a future runtime/build adapter must validate its own resolution.

Client response buffering is capped at 64 KiB for sends and 8 MiB for history (100 messages can
expand through JSON escaping). Malformed UTF-8/JSON, wrong pair/author/IDs and stale scopes are
rejected. Interrupted streams are retryable, preserving idempotency. Native Fetch streaming is
unverified: injected transport must provide standard Response.body.getReader and TextDecoder.
A native-compatible bounded transport implementation is a release prerequisite, not proven by Hermes export.
