#!/usr/bin/env bash
# Source before any PostgreSQL utility or Node pg client. Unset names only,
# never print inherited credential or connection-setting values.
for pg_variable in ${!PG@}; do
  unset "$pg_variable"
done
unset pg_variable
