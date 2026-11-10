# Synthetic invitation preview and acceptance evidence

Base: `1bbe6f6d60b89a097472a4f65ca237bd40eaf9d2`.
Scope: API-only, explicitly enabled synthetic loopback preview and acceptance.
Independent review is pending. No mobile invitation UI, external token delivery,
contacts, notifications, deployment or production account/data operations are added.

The real composed flow verifies official signup, explicit domain provisioning,
waiting-space creation, invitation issuance, authenticated preview, explicit acceptance,
epoch-2 context discovery, and authorized chat send/history. No client-provided identity
mapping is used for that scenario. Preview reserves nothing and discloses no issuer or
couple identifiers. Accept rechecks authority and membership in its own transaction.

Evidence files:

- `api-typecheck.log`, `api-lint.log`, `api-unit-coverage.log`: final API static and
  coverage gates: 175 tests across 24 files passed. Coverage is 99.78% statements,
  99.70% branches, 100% functions and 99.85% lines. Both new runtime modules have
  100% in all metrics. All runtime sources remain included with unchanged 90% thresholds.
- `postgres.log`: 81 real disposable PostgreSQL groups, including 22 new acceptance
  groups. Tests cover two sorted UUID lock orders, competing recipients/sessions/pairs,
  revoke races, invitation/session expiry after lock waits, changed or deleted profiles,
  providers, mappings and memberships, rollback at every write, and lost-ACK replay.
- `postgres-first-run.log`: historical 80/81 run. One test expected 403 for a stale chat
  epoch; the existing contract returns 409 `stale_membership`. Only that assertion was
  corrected. No runtime or timeout change was needed; the full rerun passed.
- `safety.log`: 8 environment/runner safety tests.
- `mobile-regression.log`: 592 unchanged mobile tests; coverage 96.47% statements,
  95.95% branches, 97.22% functions and 97.12% lines.
- `mobile-typecheck.log`, `mobile-lint.log`: unchanged mobile static gates.
- `mobile-export.log`: default preview iOS and Android Metro/Hermes exports.
- `mobile-export-auth.log`: iOS and Android export with a temporary entry importing
  the real auth runtime. No configuration or network was invoked; the temporary entry
  was removed and package.json restored.

Migrations, dependencies and lockfiles are unchanged. Existing dependency audit findings
remain unresolved. The PostgreSQL runner uses the previously reviewed disposable binary
and loopback safeguards, not a production database. Export results are not native-device,
SecureStore hardware or two-device proof. No runtime-generated invitation token is logged
or archived; deterministic synthetic test inputs are not live credentials. Production rate
limiting, delivery and account/deletion lifecycle remain
separate work.

Same-recipient acceptance replay can succeed after the original invitation expires only
while the same pair remains active with the exact two live members and current authority.
It does not recreate a closed pair or add a member. A consumed-token preview is unavailable;
a lost-ACK retry should repeat explicit accept, then rediscover authoritative context,
rather than require a successful new preview first.

`SHA256SUMS` lists changed source, documents and evidence relative to the repository root.
The separate archive is generated from the frozen Git commit. Its hash and exact commit
are sent with the independent review request. The author does not publish this checkpoint.
