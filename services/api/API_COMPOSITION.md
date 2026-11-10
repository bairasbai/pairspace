# Explicit product API composition

Status: implemented and author-verified; pending independent acceptance of this revision. This is backend runtime code, not a deployed service. The historical verification counts below describe the original composition milestone; current session-context changes and checks are recorded in [SESSION_CONTEXT.md](SESSION_CONTEXT.md).

## API and ownership

`createApiApplication({pool, baseURL, secret, trustedOrigins, emailPasswordEnabled, limits})` returns `{handle(Request): Promise<Response>}`. Limits require bodyBytes, bodyReadMs, statementMs and lockMs; none is obtained from request input. The factory creates the official Better Auth instance and domain transaction adapter from **the exact same caller-owned pg.Pool** and binds the existing Better Auth session authority internally. Callers cannot accidentally inject a different verifier beside a different session store.

The pool must already be configured for the trusted PostgreSQL database/schema with the existing domain and official Better Auth migrations. The factory does not open a listener, initialize/migrate databases, configure connection credentials, provision domain users/pairs, create mappings, or own pool shutdown. Mapping/provisioning in tests is fixture-only. Caller-owned pool acquisition/query timeouts and server/proxy deployment configuration remain required.

The secret is explicit and must be a suitably random runtime secret, not source-controlled configuration. The factory passes both official `secret` and `secrets:[{version:1,value:secret}]`. Better Auth otherwise consults BETTER_AUTH_SECRETS even when secret is set. No environment fallback is used here, and no custom cryptography is introduced. Rotation beyond the one explicit key is separate work. Logging/telemetry are disabled in this slice, and official onAPIError.throw routes unexpected errors through the application's opaque 503 boundary rather than Better Call's raw console error fallback.

Email/password enablement is an explicit boolean. False is verified to prevent signup. Account email delivery/verification/recovery, OAuth and other provider setup are not configured by this factory.

## Mounted routes and request policy

- `/api/auth/*`: official Better Auth handler, unchanged provider schemas.
- `/v1/couples/:id/chat/messages`: existing product chat handler, send/history, membership checks, sequencing, deduplication and content-free outbox.
- `/v1/session/context`: read-only authenticated server-selected session context. See [SESSION_CONTEXT.md](SESSION_CONTEXT.md) for response variants, lock protocol and current evidence.
- Other paths return 404. Context allows GET only; the other routes allow GET/POST. Unsupported methods return 405 with Allow. No production close-couple HTTP endpoint was added.
- Every mounted request currently requires an exact allowed Origin (or Expo-origin only when Origin is absent). This strict policy is explicit: ordinary browser GETs without Origin are rejected. Cross-origin browser CORS/OPTIONS behavior and native Expo end-to-end transport remain separate work; accepting a scheme in the allowlist is not native runtime proof.
- POST requires application/json. Actual streamed bytes are bounded even without an honest Content-Length. Invalid declarations/read failures return 400, excessive bytes 413 and stalled reads 408 at the Request API level. The official Node adapter may close the underlying stalled socket instead of delivering 408; the loopback regression accepts and verifies that bounded close behavior.
- Controlled provider 4xx responses remain intact. Unexpected thrown/provider 5xx errors become an opaque 503. Responses have no-store and nosniff. SQL details and secrets are not returned; injected auth SQL failure also verifies no raw console.error logging.

The same authoritative Better Auth session is rechecked inside the domain transaction. No JWT/auth_sessions fallback was introduced. Product transaction SQL remains unchanged; the new pool adapter supplies BEGIN, bounded SET LOCAL-equivalent settings, COMMIT/ROLLBACK and release. Any rejected BEGIN is treated as uncertain execution and discards the borrowed connection, including a server-executed BEGIN whose acknowledgement was lost. A rollback failure discards the borrowed connection and fails closed. The adapter never retries a transaction with uncertain outcome.

## Verification

The real PostgreSQL suite now includes 10 groups: the previous 5 product-authority groups plus 5 composed-loopback groups. A test-only server binds 127.0.0.1 and mounts this exact product factory through the official Node adapter. Official better-auth/client calls cross real HTTP for signup, wrong/correct signin, getSession, chat send/replay/history, revoke and denial, and logout. Two independent pairs remain isolated; account creation alone creates no domain mapping or access.

Additional loopback checks cover CSRF/missing origins, media/JSON/body-size failures, unknown routes, deliberate auth/database errors, outbox rollback and retry, stalled upload followed by a healthy request, and disabled signup. Hostile synthetic PG* and Better Auth secret environment variables are injected by the test runner to exercise configuration isolation. No live services/accounts or personal data are used.

Run from services/api: `npm ci --ignore-scripts`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:safety`, `npm run verify:postgres`. Existing backend transport tests still need unchanged apps/mobile dependencies for Expo tsconfig resolution. The PostgreSQL test runner remains Linux x64-only with GNU timeout and the previously reviewed pinned third-party packaged PostgreSQL 18.6 runtime. No binary is included in the source backup. Native-library vulnerability scanning, production roles/RLS, TLS, reverse-proxy trust, rate limits, migrations/backfill, complete account lifecycle and mobile SecureStore/two-device verification remain open.

The original composition milestone was backend-only. Current mobile auth/context integration is documented under apps/mobile. Top-level Map/Memory/ROADMAP are maintained by the parent.

## Recorded checks for this revision

108 unit/SQL tests, 8 harness-safety tests and 10 real PostgreSQL groups passed. Strict TypeScript and ESLint passed. Global coverage is 99.75% statements, 99.51% branches, 100% functions and 99.66% lines; all three new runtime modules have 100% statement/branch/function coverage. Original ≥90% thresholds and inclusion of unimported production files remain unchanged.

Dependency audit remains 10 moderate findings in the existing ESLint/typescript-eslint/minimatch toolchain, 0 high/critical. No clean-security claim or auto-fix. pg 8.23.1 was promoted from dev to runtime dependencies because the composition requires a caller-supplied pg.Pool; no existing package version was upgraded. Evidence: evidence/api-composition. Source backup excludes node_modules, generated coverage and temporary clusters.

## Review correction: uncertain BEGIN

The prior composition checkpoint 976ec2e is historical and was not accepted: it returned a connection to the shared pool when BEGIN rejected before acknowledgement. This revision defaults to discarding the client until BEGIN successfully resolves. The regression explicitly models an open server transaction followed by a client read timeout and proves the domain callback is not called and release(true) destroys the connection. Existing success, rollback, rollback-failure and acquisition-failure checks remain covered. This lost-ack regression is a deterministic unit simulation, not a claim of network fault injection against PostgreSQL.
