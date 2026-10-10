#!/bin/sh
# Applies every migration in name order to an existing database.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres PGPASSWORD=... PGDATABASE=audit ./apply.sh
# The connecting user must be a superuser, because 001 creates an event trigger.
set -eu

dir="$(cd "$(dirname "$0")" && pwd)/migrations"
psql="${PSQL:-psql}"

for f in "$dir"/*.sql; do
  echo "applying $(basename "$f")"
  "$psql" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "migrations applied"
