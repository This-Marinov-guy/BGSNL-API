#!/usr/bin/env bash
set -Eeuo pipefail

# Redis is a separate Compose project. Keep its existing project name and
# named volume: never run down -v, flush data, or start unrelated services.
redis_dir=${BGSNL_REDIS_COMPOSE_DIR:-/root/bgsnl-redis}
redis_wait=${BGSNL_REDIS_WAIT_SECONDS:-60}
[[ "$redis_wait" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid Redis health timeout.' >&2; exit 1; }
for file in "$redis_dir/compose.yml" "$redis_dir/.env"; do
  [[ -r "$file" ]] || { echo "Required Redis configuration is missing: $file" >&2; exit 1; }
done
redis_compose=(docker compose --project-name bgsnl-storage --env-file "$redis_dir/.env" -f "$redis_dir/compose.yml")

healthy() {
  local container state
  container=$("${redis_compose[@]}" ps -a -q bgsnl-redis) || return 1
  [[ -n "$container" && "$container" != *$'\n'* ]] || return 1
  state=$(docker inspect --format '{{.State.Status}} {{.State.Paused}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing-healthcheck{{end}}' "$container") || return 1
  [[ "$state" == 'running false healthy' ]]
}

if healthy; then
  echo 'BGSNL Redis is healthy; keeping its running container.'
  exit 0
fi

echo 'BGSNL Redis is missing, stopped or unhealthy. Recreating it with its existing data volume...'
# The current service uses the official Redis image, so it has no custom image
# to rebuild. --build also supports a future build-backed service definition.
"${redis_compose[@]}" up -d --build --force-recreate --no-deps --wait --wait-timeout "$redis_wait" bgsnl-redis
healthy || { echo 'BGSNL Redis did not become healthy; deployment blocked.' >&2; exit 1; }
echo 'BGSNL Redis recovered and is healthy.'
