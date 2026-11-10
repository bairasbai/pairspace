# Annual shared dates mobile verification

Final mobile source: 53 suites / 1409 tests passed. Full coverage:
97.03% statements, 96.13% branches, 98.22% functions, 98.60% lines.
TypeScript and ESLint passed. iOS + Android JS exports passed, not native builds.

Initial export could not create the default Expo home. A writable temporary home
with telemetry disabled resolved that environment issue. Metro then could not
resolve external symlinked dependencies; existing baseline dependencies were
copied locally, with no manifest or lockfile changes, and export passed.
Full tests, lint and TypeScript were rerun using the local dependency copy.

No native simulator/device, two-device, accessibility or production acceptance
is claimed. No reminder, notification, countdown or background scheduling added.

Correction after initial freeze: original typecheck claim was false. The completed
log contained TS5097, masked by a shell command ending with successful git status.
That original log is retained as typecheck-initial-failed.log. Mobile noEmit strict
bundler configuration now enables allowImportingTsExtensions for shared Node .ts
imports. Final typecheck.log is independently rerun with explicit checked exit code.
