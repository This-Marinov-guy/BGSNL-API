#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Run on the VPS after updating the checkout. Build first; do not recreate a
# running service until the new image has successfully migrated the database.
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
compose_dir=${BGSNL_COMPOSE_DIR:-/root}
log_root=${BGSNL_DEPLOY_LOG_DIR:-/root/bgsnl-deploy-logs}
mkdir -p "$log_root"
exec 9>"$log_root/deploy.lock"
flock -n 9 || { echo 'Another BGSNL deployment or recovery holds the deployment lock.' >&2; exit 1; }
run_dir=$(mktemp -d "$log_root/run-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
exec > >(tee -a "$run_dir/deploy.log") 2>&1
echo "Deployment logs: $run_dir"
revision=$(git -C "$repo_dir" rev-parse HEAD)
cd "$compose_dir"

# Build both before taking the old containers offline. The Dockerfile runs as
# uid 1000; only the result subdirectory is writable by the temporary runner.
docker compose build bgsnl-api bgsnl-worker
mkdir "$run_dir/result"
chown 1000:1000 "$run_dir/result"
chmod 700 "$run_dir/result"

old_ids=$(docker compose ps -q bgsnl-api bgsnl-worker)
old_containers=()
while IFS= read -r id; do
  [[ -n "$id" ]] && old_containers+=("$id")
done <<< "$old_ids"
printf '%s\n' "${old_containers[@]}" > "$run_dir/previous-containers.txt"
quiesced=false
migrations_started=false
migrations_passed=false
handle_exit() {
  local code=$?
  trap - EXIT
  if (( code != 0 )) && [[ "$quiesced" == true && "$migrations_passed" == false ]]; then
    if [[ "$migrations_started" == false ]] || [[ -f "$run_dir/result/rollback.status" && "$(cat "$run_dir/result/rollback.status")" == rolled-back ]]; then
      echo 'Deployment blocked. Restarting the exact previous containers after safe rollback.'
      if (( ${#old_containers[@]} )); then docker start "${old_containers[@]}" || echo 'ERROR: previous containers could not restart; manual recovery required.' >&2; fi
    else
      echo 'ERROR: rollback is not confirmed. API/worker remain stopped. Inspect migrationRuns and the logs before recovery.' >&2
    fi
  fi
  if (( code != 0 )); then echo "Deployment FAILED (exit $code). Logs retained at $run_dir" >&2; fi
  exit "$code"
}
trap handle_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

quiesced=true
docker compose stop -t 90 bgsnl-api bgsnl-worker
for id in "${old_containers[@]}"; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$id")" == false ]] || { echo "Container $id is still running; refusing migration." >&2; exit 1; }
done

migrations_started=true
docker compose run --rm --no-deps -T \
  -e "DEPLOY_REVISION=$revision" \
  -e MIGRATION_OUTPUT_DIR=/migration-output \
  -v "$run_dir/result:/migration-output" \
  bgsnl-api node migrations/run.js --writers-stopped 2>&1 | tee "$run_dir/migrations.log"
migrations_passed=true

# No --build here: deploy the images that just passed the migration gate.
docker compose up -d --no-build bgsnl-api bgsnl-worker
echo "Deployment completed for $revision. Migration result: $run_dir/result/result.json"
# Keep old images and migration logs available for diagnosis/recovery.
