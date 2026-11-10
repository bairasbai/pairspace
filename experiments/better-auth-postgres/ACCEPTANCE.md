# Independent acceptance

Accepted 2026-11-10 as an isolated live PostgreSQL experiment. Independent clean run with hostile PG environment variables passed eight guard/audit/deadline and seven real PostgreSQL18.6 tests. Syntax checks passed and fresh npm audit reported zero findings. No PostgreSQL process or temporary cluster directory remained after normal completion.

Prior environment-sanitization and hanging-barrier findings are closed. Actual revoke DELETE versus domain FOR SHARE, reverse ordering, stale principal, membership/timestamp and rollback tests passed. One authoritative session table is retained.

Runtime is a third-party npm PostgreSQL distribution, not PGDG. Its registry signature was independently verified; full dependency attestation verification remains blocked by an unavailable set-cookie-parser key. This is not a product integration, native readiness, complete account-locking proof, crash-cleanup guarantee or bundled-library security approval. Loopback isolation was checked by source/regressions, not packet capture.

Source and lockfile are preserved here; generated evidence is reproducible with bash verify.sh. Frozen source archive SHA256: a23eaf43bcaca32141ea6625d678533a6a5d427f67ca9060f9f7740d112ad456.
