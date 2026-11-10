# Central navigation care signal: verification record

Status: locally verified, awaiting independent acceptance of frozen SHA.
Baseline local commit `f1043690aaf5f46f4e76afe90de64967265d3b9b`, tree
`239a3b446ef0eed9b95b26894de69289bf084499`, equal to published
`c52591d31a55ae286f46e1585736da9017e1a99f` tree.

## Scope

Explicit synthetic injection only. One controller and its existing care transport,
no new runtime, server, secret store, persistence, production connection or push.
Central Kimi-styled heart remains centered and pulsating with reduced-motion support.
Connected chat removes its duplicate send heart, retains explicit incoming reading.
The server verifies fresh scope per action; ACK is saved, not delivery or reading.
Navigation and language changes do not send requests. Default App remains offline
and uses its original alert. Other screens remain demonstration UI.

Controller lifetime is App-wide. A microtask ownership lease tolerates StrictMode
replay, captures the exact replaced controller and never signs the provider out.
Standalone panel retains synchronous disposal and its inherited StrictMode reset.
App opts out of standalone ownership. No auth lifecycle changes.

Cooldown is server-authoritative: 429 clears the rejected command, displays a reason,
and allows later explicit retry. No client timer, polling or automatic retransmission.
Unknown ACK retains the command through tab/locale changes. Logout/scope change resets
immediately; App removal/replacement disposes at its next microtask.

## Commands and outcomes (2026-11-10)

- Mobile `npm --prefix apps/mobile test`: 32 suites, 1004 tests passed. All production
  files included; statements 97.48%, branches 97.03%, functions 98.45%, lines 98.29%.
- Mobile typecheck and lint passed.
- `EXPO_NO_TELEMETRY=1 CI=1 npm --prefix apps/mobile run export`: iOS/Android JavaScript
  export passed. This is not a native build, simulator or real-device test.
- 15 new App cases use real session/care controllers and synthetic fixtures: RU/EN,
  all tabs, one heart, no implicit care requests, unavailable scopes, repeated tap,
  lost ACK/same-ID retry, malformed ACK, 429/404, draft and locale continuity,
  logout, unmount, controller replacement and preauthenticated StrictMode.
- API `npm --prefix services/api test`: 181 tests passed; statements 99.80%, branches
  99.55%, functions 100%, lines 99.86%. Typecheck/lint passed; safety harness 9/9.
- `npm --prefix services/api run verify:postgres`: PostgreSQL 94/94 passed, including
  existing two-pair care authorization/replay/race tests. API code unchanged.
- Root `npm test`: 9/9 passed. Root Next.js code unchanged. Root typecheck/build not
  rerun: inherited dependency graph unavailable, no installation required.

Logs: `apps/mobile/evidence/central-heart/` and `docs/evidence/central-heart/`.
Local dependency materialization errors were resolved before final checks: Metro
needs local mobile dependencies; PostgreSQL hydration validates package-local paths.
Existing dependencies copied to this checkout, no version changes or new install.
Expo telemetry disabled to avoid an unavailable default home directory.

## Remaining gates

Independent exact-SHA review required. Native iOS/Android rendering, accessibility,
background/foreground and real two-device QA remain unperformed. No pixel parity,
native acceptance, production readiness, E2EE, notification delivery, restart
durability, abuse resistance or retention policy is claimed. No preview, production,
Space or remote publication was performed in this slice.
