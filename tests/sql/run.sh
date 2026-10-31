#!/bin/sh
# Applies the previous schema (tests/sql/schema_v1.sql), adds a row, upgrades with the current
# supabase/schema.sql twice (idempotency) and runs the RLS tests on a throwaway database.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres sh tests/sql/run.sh
set -e
export PGOPTIONS="-c client_min_messages=warning"
cd "$(dirname "$0")/../.."
psql -q -v ON_ERROR_STOP=1 -c "drop database if exists homehub_test" -c "create database homehub_test" >/dev/null
psql -q -v ON_ERROR_STOP=1 -d homehub_test -f tests/sql/supabase_stub.sql
psql -q -v ON_ERROR_STOP=1 -d homehub_test -f tests/sql/schema_v1.sql
psql -q -v ON_ERROR_STOP=1 -d homehub_test -c "insert into public.accounts (name, last4) values ('upgrade-survivor', '9999')"
psql -q -v ON_ERROR_STOP=1 -d homehub_test -f supabase/schema.sql
psql -q -v ON_ERROR_STOP=1 -d homehub_test -f supabase/schema.sql
psql -q -v ON_ERROR_STOP=1 -d homehub_test -f tests/sql/rls_test.sql
