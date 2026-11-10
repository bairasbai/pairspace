# Independent acceptance

Accepted on 2026-11-10 as an isolated compatibility experiment only.
Independent clean install reproduced handler/SQLite tests, strict TypeScript and both Expo JS exports; subsequent audit-helper review reproduced all five test groups and valid audit findings. Audit: five moderate findings, zero high/critical at verification time.

This directory does not replace product authentication. It does not establish native device, network login, PostgreSQL concurrency or production readiness. The referenced security advisory could not be independently fetched (404); do not treat the version floor as verified advisory coverage.

Source and lockfile are retained here; generated logs/registry metadata are in the source backup and can be regenerated with bash verify.sh. Audit failures are now distinguished from vulnerability findings. The full frozen archive SHA256 is 38dc5fd74232d71808e836c8d1614568db7968beb36b0c622dd2d2927196dad1.
