#!/bin/sh
# Runs supabase/schema.sql twice (idempotency) and the RLS tests on a throwaway database.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres sh tests/sql/run.sh
set -e
export PGOPTIONS="-c client_min_messages=warning"
cd "$(dirname "$0")/../.."
psql -q -v ON_ERROR_STOP=1 -c "drop database if exists homehub_test" -c "create database homehub_test" >/dev/null
for f in tests/sql/supabase_stub.sql supabase/schema.sql supabase/schema.sql tests/sql/rls_test.sql; do
  psql -q -v ON_ERROR_STOP=1 -d homehub_test -f "$f"
done
