# Synthetic mobile auth/chat integration

Status: implemented, author checks passed, not independently accepted. No deployed service, real account, production configuration or native-device proof.

## Explicit wiring and disabled default

The ordinary App remains the existing Kimi-styled preview, with its navigation and central heart unchanged. It does not instantiate an auth client or make requests. To exercise the new panel, an isolated development harness explicitly calls createSyntheticRuntime(config) and renders PairspaceApp with its syntheticController prop. The configuration requires mode "synthetic-loopback", an exact HTTP loopback origin and a fixture identity map keyed by provider user ID. There are no environment-derived URLs, credentials or automatic production endpoints.

The map contains only synthetic domain UUID, couple UUID and membership epoch. It is not an authorization grant: every chat request still goes through authoritative server session and membership checks. Production session-to-domain discovery, provisioning and invitation flows are NOT implemented. No signup UI or real account is provisioned by this stage. Default auth configuration is null.

Official better-auth and @better-auth/expo are pinned together at 1.7.19 (MIT), above the previously reviewed security floor 1.7.16. Expo SDK 58 packages are pinned: SecureStore 58.0.2, Constants 58.0.15, Linking 58.0.16, Network 58.0.4, WebBrowser 58.0.7 and Crypto 58.0.7. These are official Expo packages from the npm registry, MIT, not custom security implementations. Crypto is used only for client command UUIDs.

The official Expo plugin owns cookie parsing and SecureStore persistence. The app consumes only the official getCookie() output to call the existing /v1/couples/:id/chat/messages contract. It does not implement cookie storage, cryptography or JWT fallback. The existing Bearer transport remains the explicit legacy fixture mode; this controller always selects cookie mode and supplies the exact trusted Origin on both auth and chat calls. Expo-origin does not override Origin. Cross-origin browser CORS support remains absent.

The runtime uses Expo streaming fetch for chat and passes the whole Request object so Expo can handle React Native's native body representation. The auth plugin uses its official fetch handling. Both GET/POST chat responses are byte-limited and have a total ten-second read deadline. Auth calls have a ten-second official fetch timeout, no retries; chat network waits abort after ten seconds. Timed-out transactions are not presumed rolled back.

## Session and draft boundaries

Auth mutations are serialized. Login first uses official signOut to clean up a persisted previous fixture session. It then signs in and verifies getSession with cookie cache disabled. No cached identity alone grants chat access, and no implicit restore occurs on startup.

Logout or cancellation increments the local generation immediately, aborts current chat networking and removes the queue, draft and displayed history. Official logout waits behind any in-flight auth mutation, so a late sign-in cannot restore the visible session. Failed cleanup blocks re-login until the user retries logout; it is not represented as successful server revocation. Busy/blocked UI remains explicit.

Chat replies must match the current generation. Latest history request wins for data/errors, but authoritative 401/403 denial from any request in the current generation blocks the session and clears visible private data. Late results from another generation cannot restore messages or drafts. A send cannot overlap another send; failed/unacknowledged commands retain their idempotency ID by body even if the draft is edited and restored, until confirmed success or session change. Queue capacity is 500 commands. Nothing is persisted offline.

## Verification and limitations

Mobile unit/component/contract tests use synthetic identities and mocked native modules. Real PostgreSQL tests execute the exact mobile controller and cookie transport through the composed HTTP server and official Better Auth Node client fixture. They prove send/history, lost-ACK replay without duplicate message/outbox, cross-pair state isolation, logout and completed revocation denial. They do NOT execute Expo SecureStore or React Native networking on a device.

Both normal iOS/Android Metro/Hermes exports and a separate build-only entry importing the current official Expo client/runtime are checked. Export is JavaScript/bundle evidence, not an iOS/Android native build, device test, keychain/keystore security test, deep-link verification or two-device acceptance. The build-only entry has no configuration and makes no network call.

Run mobile: npm ci --ignore-scripts; npm run typecheck; npm run lint; npm test; EXPO_NO_TELEMETRY=1 npm run export.
Run API: npm run typecheck; npm run lint; npm test; npm run test:safety; npm run verify:postgres.
The PostgreSQL runner retains its synthetic local-only environment guard, disposable database marker and bounded cleanup. It uses the previously reviewed pinned third-party npm PostgreSQL distribution, not a production server.

For the additional auth import export, temporarily point package.json main at a build-only entry that imports/exports createSyntheticRuntime and registers a null component; run Expo export for ios/android and restore package.json. No synthetic config is embedded or executed. Evidence logs identify that temporary entry. Source backups exclude generated bundles and node_modules.

Mobile dependency audit: 29 findings (28 moderate, 1 low, 0 high/critical); no automatic fix or clean-security claim. Native binary/library security remains separately unverified. Server audit and previously documented production deployment gates remain in force.

Top-level Map/Memory/ROADMAP are maintained by the parent. Independent review and exact final verification counts are required before publication.

## Recorded author checks

290 mobile tests passed (12 suites). Mobile global coverage: 95.41% statements, 95.10% branches, 96.21% functions, 96.32% lines. Auth runtime/controller group exceeds 97% across all four metrics; component and official-client adapter tests cover 100%. Coverage includes unimported production files without relaxed thresholds.

API: 109 unit/SQL tests, 8 safety tests and 11 real PostgreSQL groups passed; coverage 99.75/99.51/100/99.66%. Mobile/API strict TypeScript and lint passed. Normal and auth-import iOS/Android exports passed. These checks do not replace independent acceptance or native-device testing.

## Review correction: origin-bound SecureStore namespace

The historical checkpoint 74efd9d was rejected before publication because its fixed storagePrefix could attach one synthetic server's cookie to another server's initial logout. This revision derives the storage namespace from the exact validated origin, including host and port, by fixed-width four-hex-digit encoding of each UTF-16 code unit. This is reversible encoding, not cryptography and not a lossy character replacement. Keys contain only SecureStore-supported characters. Different exact origins cannot collide, and the same origin intentionally shares its official plugin storage.

The official Expo plugin is configured with disableCache:true to avoid cached profile/session hydration and auth fetches use redirect:error. Existing unscoped synthetic keys are not read, migrated or cleared because their origin cannot be safely inferred. This rejected checkpoint was never a deployed production migration.

A new API-side Vitest regression runs the actual official Expo plugin and actual Better Auth client through the actual mobile factory. Only native I/O modules and fetch are mocked with synthetic fixtures. It verifies three host/port origins cannot read/send/clear each other's cookies, same-origin clients share the correct cookie, logout is isolated, session data is not cached, redirects are disabled and legacy unscoped data remains untouched. The official plugin is inlined by the test runner so these assertions execute its real storage/fetch hooks rather than a plugin mock. This still does not test real SecureStore hardware or native networking.
