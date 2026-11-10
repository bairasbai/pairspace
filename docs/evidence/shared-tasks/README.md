# Shared-task validation logs

Machine-generated output is retained without runtime tokens or real user content.
Trailing whitespace and extra blank lines at EOF were normalized after review;
test outcomes and other log content are unchanged.
These files are test/build evidence, not hand-authored source subject to 600 lines.

- api-unit.log: complete API/domain Vitest coverage run.
- api-focused.log: focused shared-task/composition tests.
- mobile-unit.log: complete mobile Jest coverage run.
- api/mobile-typecheck.log and api/mobile-lint.log: compiler/static checks.
- mobile-export.log: Expo iOS/Android JS bundles; writable temporary HOME for Expo cache.
  This is not native/device validation.
- postgres-focused.log: targeted new feature integration against disposable PostgreSQL.
- postgres-full.log: complete disposable PostgreSQL integration suite.
- postgres-input-before.sha256 and postgres-input-after.sha256: identical runtime,
  migrations, PostgreSQL tests, mobile runtime and domain input snapshots around full run.
- root-domain.log and safety.log: existing root domain and bounded-run safety tests.

The PostgreSQL runner keeps a 240-second outer bound, 10-second kill grace and
unchanged individual/query/cleanup bounds. An existing scheduled-letter scenario
waits 61 seconds against the actual server release gate. The old 180-second total
was expanded only to accommodate the added tests; the safety test checks the bound.
