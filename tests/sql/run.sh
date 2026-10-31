#!/bin/sh
# Database tests on throwaway databases:
#  1. new project: supabase/schema.sql twice (idempotency) + RLS/history tests
#  2. upgrade of a project created from the previous version (tests/sql/schema_v2.sql, the state of
#     the production database before the user master), in the same order as production:
#     add the new parts -> check the old app still works -> remove the old parts.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres sh tests/sql/run.sh
set -e
export PGOPTIONS="-c client_min_messages=warning"
cd "$(dirname "$0")/../.."
run() { psql -q -v ON_ERROR_STOP=1 -d "$@"; }
STAGE1=$(mktemp)
awk '/Removal of the single-owner version/{exit} {print}' supabase/schema.sql > "$STAGE1"

psql -q -v ON_ERROR_STOP=1 -c "drop database if exists homehub_test" -c "create database homehub_test" >/dev/null
run homehub_test -f tests/sql/supabase_stub.sql
run homehub_test -f supabase/schema.sql
run homehub_test -f supabase/schema.sql
run homehub_test -f tests/sql/rls_test.sql

psql -q -v ON_ERROR_STOP=1 -c "drop database if exists homehub_upgrade" -c "create database homehub_upgrade" >/dev/null
run homehub_upgrade -f tests/sql/supabase_stub.sql
run homehub_upgrade -f tests/sql/schema_v2.sql
run homehub_upgrade -f tests/sql/upgrade_seed.sql
run homehub_upgrade -f "$STAGE1"
run homehub_upgrade -f "$STAGE1"
run homehub_upgrade -f tests/sql/upgrade_stage1_test.sql
run homehub_upgrade -f supabase/schema.sql
run homehub_upgrade -f supabase/schema.sql
run homehub_upgrade -f tests/sql/upgrade_final_test.sql

# 3. upgrade of the current production state (tests/sql/schema_v3.sql) to this version
psql -q -v ON_ERROR_STOP=1 -c "drop database if exists homehub_v3" -c "create database homehub_v3" >/dev/null
run homehub_v3 -f tests/sql/supabase_stub.sql
run homehub_v3 -f tests/sql/schema_v3.sql
run homehub_v3 -f tests/sql/upgrade_v3_seed.sql
run homehub_v3 -f supabase/schema.sql
run homehub_v3 -f supabase/schema.sql
run homehub_v3 -f tests/sql/upgrade_v3_test.sql
rm -f "$STAGE1"
