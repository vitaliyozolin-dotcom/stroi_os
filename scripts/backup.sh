#!/bin/sh
set -eu

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="${BACKUP_DIR:-./backups}/$timestamp"
mkdir -p "$destination"

docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$destination/database.dump"
docker run --rm -v stroios_files:/source:ro -v "$(pwd)/$destination:/backup" alpine:3.22 \
  tar -czf /backup/files.tar.gz -C /source .

find "${BACKUP_DIR:-./backups}" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} +
echo "$destination"
