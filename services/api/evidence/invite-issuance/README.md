# Invitation issuance checkpoint evidence

Scope: API-only, explicitly enabled synthetic loopback invitation issuance, own metadata
and conditional revocation. No recipient acceptance, activation, mobile invitation UI,
external delivery, production migration or live service. Independent review is pending.

Base: `82b66b3258c244dd0ecbfab706541209ebf6f9b9`.

Verification logs in this directory:

- `api-typecheck.log`, `api-lint.log`, `api-unit-coverage.log`: final API gates;
  158 tests across 21 files passed. Coverage: 99.74% statements, 99.63% branches,
  100% functions and 99.82% lines; both new runtime modules have 100% in all metrics.
- `safety.log`: 8 runner/environment safety tests.
- `postgres.log`: 59 real disposable PostgreSQL groups, including 16 new invitation groups.
- `postgres-first-run.log`: historical first run, 58/59. One test used
  `Date.parse(pgDate)`, which loses milliseconds when stringifying a Date. It was
  corrected to `getTime()` without weakening the post-lock timestamp assertion.
  The full PostgreSQL rerun passed.
- `mobile-regression.log`: 592 unchanged mobile tests; coverage 96.47% statements,
  95.95% branches, 97.22% functions and 97.12% lines.
- `mobile-typecheck.log`, `mobile-lint.log`: unchanged mobile static gates.
- `mobile-export.log`: default preview iOS and Android Metro/Hermes exports.
- `mobile-export-auth.log`: separate iOS and Android export importing the real auth
  runtime through a temporary entry point. No runtime configuration or networking
  was invoked. The entry was removed and package.json restored afterward.

All dependencies and lockfiles are unchanged. Existing dependency audit findings
remain unresolved; this is not a clean-security claim. PostgreSQL uses the previously
reviewed disposable registry-distributed binary and guarded loopback runner, not a
production database. No native-device, SecureStore hardware, two-device or deployment
proof is claimed. No generated invitation token is intentionally logged or archived.

`SHA256SUMS` lists changed source/document/evidence files relative to the repository
root. The separate source archive is generated from the frozen Git commit; its hash
and exact commit are supplied alongside the review request. No publication is performed
by this checkpoint author.
