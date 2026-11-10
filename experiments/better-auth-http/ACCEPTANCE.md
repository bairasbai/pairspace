# Independent acceptance

Accepted 2026-11-10 as isolated synthetic HTTP integration evidence. Clean install, syntax checks, six test groups and validated audit reproduced independently. Audit: five moderate findings, zero high/critical at verification time.

Real official Node client calls loopback HTTP; domain principal comes from Better Auth and SQL mapping. The transaction rechecks the same authoritative session, ownership, timestamps and active membership. Revoke barrier and insert-failure rollback tests pass. Current membership epoch is read and recorded; it is not compared against a previously captured epoch.

This is not product login, Expo SecureStore/device verification, PostgreSQL concurrency proof or production readiness. Product code is unchanged. Source and lockfile are retained here; generated evidence can be reproduced using bash verify.sh. Frozen archive SHA256: f6f7e8fa1ac7dedf415bc5aa6f7604267814bebc0a52bd158793a02c3538c94b.
