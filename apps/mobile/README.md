# Pairspace mobile foundation

Expo 58.0.23 / React Native 0.88.1 / React 19.3.0, from Expo's bundledNativeModules.json.
This is a small local preview, not a functioning couples messenger.

## Works locally
- RU/EN navigation: Today, Chat, Together, Us.
- Central “Thinking of you” action, subtle pulse, safe static default and live Reduce Motion changes.
- The action explicitly says nothing was sent; there is no network transport.
- Practice text draft remains in RAM while navigating. Clear asks for confirmation.
- Draft and language reset when the app restarts. Do not enter personal information.

## Run
From this directory: `npm ci`, `npm start`.
Checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run export`.
Use Node 22.18+; this iteration was checked on Node 24.22.1 only.
An independent package/lockfile keeps native React dependencies out of the existing Next.js demo.
The root TypeScript project excludes this directory; run both projects' checks separately.

## Evidence and limits, 2026-11-10
- Lint, TypeScript and 9 Jest tests passed.
- Coverage includes all 8 own runtime TS/TSX files (even unimported): 100% statements/branches/functions/lines.
- Tests mock native APIs. Passing these does not validate a native screen or OS accessibility behavior.
- iOS/Android Hermes bundle export passed; these are JS artifacts, not signed native applications.
- No simulator/device, native build, visual screen review, screen-reader or multi-device E2E performed.
- No auth, pair, backend, persistent storage, real delivery, encryption, media or push.
- No runtime telemetry SDK added and no production credentials/data used.
- Safe `npm audit fix` applied; final audit still has 1 low + 42 moderate dependency findings,
  independently rechecked after implementation. Advisory counts can change as the registry updates.
  Roots include Expo CLI/Jest/ESLint glob/minimatch/deepmerge dependency chains. No high/critical reported.
  Do not run audit fix --force: the proposed Expo 52 downgrade is incompatible.
- Full repository ≥90% coverage is not claimed: the inherited web demo is not covered by this mobile gate.
- Tooling config, tests and generated lockfile are not production coverage targets.
- The mobile preview has not passed independent acceptance or production release gates.

## Dependencies
Expo, React, React Native and safe-area-context are MIT licensed; verify the full resolved
transitive SBOM/license set before distributing. Test/lint packages are development tooling.
Lockfile is npm-generated and is the explicit >600-line exception; no handwritten file exceeds the limit.
