#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/sanitize-pg-env.sh
# Pinned third-party packaged PostgreSQL binaries from the official npm registry.
node scripts/prepare-runtime.mjs
export PATH="$PWD/node_modules/@embedded-postgres/linux-x64/native/bin:$PATH"
missing=()
for binary in initdb pg_ctl node; do
  command -v "$binary" >/dev/null || missing+=("$binary")
done
if (( ${#missing[@]} )); then
  printf 'NOT RUN: missing local PostgreSQL prerequisites: %s\n' "${missing[*]}" >&2
  exit 77
fi
runtime="$(mktemp -d /tmp/pairspace-pg.XXXXXXXX)"
started=0
cleanup() {
  if (( started )) || [[ -f "$runtime/data/postmaster.pid" ]]; then
    if ! pg_ctl -D "$runtime/data" -m immediate -t 5 -w stop >/dev/null; then
      echo "Cleanup failed: temporary cluster retained at $runtime; stop it before removing files." >&2
      trap - EXIT
      exit 1
    fi
  fi
  rm -rf -- "$runtime"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export PAIRSPACE_PG_HOST=127.0.0.1 PAIRSPACE_PG_USER=pairspace_fixture
export PAIRSPACE_PG_PASSWORD="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
export PAIRSPACE_PG_NONCE="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
export PAIRSPACE_PG_DATABASE="pairspace_spike_$(node -e "process.stdout.write(require('node:crypto').randomBytes(8).toString('hex'))")"
export PAIRSPACE_PG_PORT="$(node --input-type=module -e "import net from 'node:net';const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
export TZ=UTC
umask 077
printf '%s\n' "$PAIRSPACE_PG_PASSWORD" > "$runtime/password"
mkdir "$runtime/socket"
initdb -D "$runtime/data" -U "$PAIRSPACE_PG_USER" --pwfile="$runtime/password" --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --no-locale > "$runtime/initdb.log"
if ! pg_ctl -D "$runtime/data" -l "$runtime/postgres.log" -o "-h 127.0.0.1 -p $PAIRSPACE_PG_PORT -c unix_socket_directories='' " -t 10 -w start >/dev/null; then
  cat "$runtime/postgres.log" >&2
  exit 1
fi
started=1
node scripts/bootstrap-database.mjs
npm run test:postgres
