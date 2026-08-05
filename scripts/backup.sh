#!/bin/sh
set -eu

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="${BACKUP_DIR:-./backups}/$timestamp"
mkdir -p "$destination"

docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$destination/database.dump"
docker compose exec -T app tar -czf - -C /data/files . > "$destination/files.tar.gz"
echo "$destination"
