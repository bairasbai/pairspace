# Real PostgreSQL Better Auth transaction spike

2026-11-10. **Seven real PostgreSQL integration groups passed. Pending independent review of this exact revision.** Separate fresh artifact; earlier SQLite, HTTP and prepared PostgreSQL contract snapshots are unchanged. No product replacement, publication, deployment, live user data or production database access.

## Actual runtime and provenance

The cloud initially lacked PostgreSQL tools. The configured Debian snapshot mirror returned invalid InRelease data; apt refused it. Signature checks were not weakened and no Debian package was installed.

This stage instead uses the explicitly permitted registry-distribution route:
- `@embedded-postgres/linux-x64` **18.6.0-beta.19**, from the official npm registry, pinned integrity in lockfile. Registry signature verified with `npm audit signatures` (evidence/postgres-runtime-signature.log).
- This is a **third-party packaged PostgreSQL distribution**, not an official PostgreSQL binary release. Repository: https://github.com/leinelissen/embedded-postgres . Its README credits zonky embedded-postgres binaries. Package code is MIT; README attributes upstream binary distribution to Apache 2.0. Upstream bundled components may retain their own licenses. No binaries are redistributed in the source archive.
- The package's beta suffix is retained exactly. Executed server and initdb report **PostgreSQL 18.6**, Linux x64. The embedded binary reports an Ubuntu GCC7.5 build. This proves test behavior on this runtime, not approval of its bundled libraries or production suitability.
- `better-auth` **1.7.19** and `pg` **8.23.1**, both MIT, official npm registry. The official Better Auth PostgreSQL/Kysely integration receives a real pg.Pool.

All npm lifecycle scripts are disabled during installation. Before invoking the package's symlink hydrator, our wrapper validates all 14 source/target entries remain inside its installed package; after hydration it verifies actual targets. No root/user creation, system package install, service registration, credentials discovery or persistent access grants.

The environment disallows Unix-domain socket creation. The first startup failed cleanly. The final runner disables Unix sockets and binds **only 127.0.0.1 TCP**, with SCRAM-SHA-256 synthetic credentials. The initial TCP binding had already succeeded; no permission escalation or retry of the prohibited Unix socket was performed.

## Passed real PostgreSQL tests

Seven groups run against a fresh disposable local PostgreSQL cluster, using official Better Auth migrations and real SQL connections:
1. Signup, signin, incorrect password, getSession, logout; independent domain UUID mapping; actual pair A/B isolation; wrong session-owner rejection; valid message insert.
2. Completed official revoke after initial auth resolution causes the domain transaction to reject the stale principal.
3. Domain session FOR SHARE acquired first blocks the **actual Better Auth revoke endpoint's DELETE**. A separate observer connection sees pg_stat_activity wait_event_type='Lock'. The domain commits; revoke then completes; later operations fail authentication.
4. Direct synthetic DELETE transaction acquired first blocks the domain session reader; pg_stat_activity confirms the lock wait. DELETE commits, domain rejects and inserts nothing. This reverse case exercises SQL ordering, not another official revoke endpoint call.
5. Current membership, expiry and future creation are rechecked after prior auth resolution and prevent stale authorization.
6. NOT NULL insert failure rolls back, and a subsequent operation through the pool succeeds.
7. A real pre-barrier SQL failure (synthetic renamed session table) promptly rejects readiness, is observed without an unhandled rejection and cleans up without hanging.

The observer assertions test real database lock waits rather than inferring concurrency from sleeps. Initial official getSession/cookie verification is real. Session SQL remains authoritative; there is no second session store, synthetic JWT fallback or custom token issuer.

Eight additional guard/audit/deadline groups pass. JavaScript/module/Bash syntax checks pass. These scripts are JavaScript, not a strict-TypeScript implementation. Fresh npm audit reports **0 findings for this backend-only graph**; npm audit does not establish absence of CVEs in bundled native PostgreSQL libraries. Separate Expo dependency findings are not cleared.

## Independent-review blocker fixes

The prepared predecessor's reviewer found two blockers. This live revision fixes both before acceptance:
- All inherited PG* environment variables are removed before native utilities or pg client bootstrap. Configuration parsing independently rejects any surviving PG* key, including PGHOSTADDR, PGSERVICE, PGSERVICEFILE and PGOPTIONS. Regressions cover these keys and unknown future PG keys. A complete real PostgreSQL run passed with hostile synthetic PGHOSTADDR/PGSERVICE/PGOPTIONS deliberately injected into the caller environment.
- Every concurrent task is observed immediately. Barrier readiness races task failure/early completion and a 3s deadline. Regressions cover rejection, early completion, stuck readiness and stuck cleanup, plus the real SQL failure above.
- Connections have 3s acquisition, 8s client query, 7s server statement, 5s lock and 10s idle-in-transaction limits. Pool cleanup is bounded 5s; pending-task settlement is bounded 10s. The outer runner uses GNU timeout 60s, TERM followed by KILL after 10s; pg_ctl startup/shutdown are bounded 10s/5s. Promise deadlines alone do not cancel underlying work; the process-level runner is the final bound. A harmless stuck-subprocess regression verifies GNU timeout's nonzero termination.

Only the PostgreSQL runtime package's registry signature is claimed verified. The reviewer reported full-graph signature validation blocked by a missing signature key for set-cookie-parser 3.2.2; this report does not claim all dependency attestations verified.

## Verified transaction policy and limits

Domain order: auth user FOR SHARE → exact authoritative session FOR SHARE → couple FOR SHARE → domain user/membership FOR SHARE → message insert → commit. Session row ownership must match authenticated user. Server time is sampled with `clock_timestamp()` **after acquiring the session lock**, not stale transaction-start `now()`. Returned pg Date values must be finite; future creation and expired sessions fail closed.

A completed revoke before authorization blocks the write. A domain transaction already holding the session row may commit before a waiting revoke finishes, after which subsequent access fails. Expiry is an authorization-time snapshot, not exact-instant cancellation of a running transaction. Lock/statement timeouts are 5s/7s for this experiment.

Verified scope is the tested PostgreSQL 18.6 setup and Better Auth 1.7.19 revoke flow. It is not proof of the complete production lock protocol, user deletion, password reset, account linking, every session mutation, serializable isolation, high-load stability, or cancellation/timeout recovery across crashes. Membership mutations here are synthetic; a production revoker needs its own agreed lock order and concurrency tests.

No native iOS/Android/SecureStore/two-device proof, OAuth, recovery/email delivery, TLS/reverse proxy, RLS/least-privilege roles, product migration/backfill or production coverage claim. This artifact does not replace Pairspace's jose/auth_sessions prototype. The fixture role is superuser only inside the disposable private cluster.

## Reproduce and cleanup

Linux x64, Node 24.22.1/npm 11.9.0. `bash verify.sh` installs the pinned npm graph with scripts disabled, runs syntax/guard/audit checks, hydrates the validated runtime, creates a fresh cluster and executes seven PostgreSQL groups. psql/createdb are not required: a small pg bootstrap creates the randomly named database and marker.

The runtime uses a short randomized /tmp directory, fresh password/nonce and random loopback port. A restricted temporary password file is removed with the cluster. The marker must match before fixture schema creation/deletion; remote hosts and generic PG environment fallbacks are rejected. Separate generated schemas isolate fixtures. Runtime state is never included in source archives. If shutdown fails, the runner fails and reports the retained temporary directory rather than deleting a live cluster's files.

Evidence: postgres-test.log, full-verification.log, guard-test.log, check.log, audit.json, audit-validation.log, postgres-runtime-provenance.json and postgres-runtime-signature.log. Source identity: evidence/SHA256SUMS. Earlier prebootstrap missing-tools evidence is labeled as such. No handwritten file exceeds 600 lines; lockfile is generated. Independent review must rerun this exact source before acceptance.
