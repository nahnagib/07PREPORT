#!/usr/bin/env bash
# Deploy / roll back the 07ps stack on the Docker host. See docs/DEPLOYMENT.md sections 6 and 7.
#
#   scripts/deploy.sh deploy   <image-tag>   # backup -> migrate -> pull/build -> up -> smoke (auto-rollback on failure)
#   scripts/deploy.sh rollback [image-tag]   # back to <image-tag>, or the previously deployed tag
#   scripts/deploy.sh status                 # current/previous tag and container health
#
# Environment (all optional):
#   IMAGE_REGISTRY      e.g. ghcr.io/your-org  -> images are pulled as $IMAGE_REGISTRY/07ps/<svc>:<tag>
#                       (unset = images are built on this host from the checked-out source)
#   MIGRATIONS          space-separated files from data/warehouse/migrations (default: 0022_etl_run_log.sql)
#   MIGRATION_ENV_FILE  env file with DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME of an account that may
#                       CREATE TABLE (NOT the app or ETL account). Unset = skip migrations (you ran them).
#   SKIP_BACKUP=1       skip the pre-deploy database backup (scripts/backup_db.sh)
#   AUTO_ROLLBACK=0     leave a failed deployment in place instead of rolling back
#   SMOKE_ARGS          extra args for post_deploy_check.py (default: --run-etl)
# Secrets (SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD, ETL_API_KEY) must be exported by the caller.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
STATE_DIR=".deploy_state"
mkdir -p "$STATE_DIR"

log() { printf '%s [deploy] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

current_tag() { cat "$STATE_DIR/current_tag" 2>/dev/null || echo ""; }

preflight_files() {
  for f in .env backend/.env data/etl/.env; do
    [ -f "$f" ] || die "missing $f (copy the matching .env.example / deploy/config/<env>/*.env.example and fill it in)"
  done
  docker compose config -q || die "docker compose config is invalid"
}

wait_healthy() {
  local deadline=$((SECONDS + ${HEALTH_TIMEOUT:-240}))
  log "waiting for services to become healthy (timeout ${HEALTH_TIMEOUT:-240}s)"
  while [ "$SECONDS" -lt "$deadline" ]; do
    local unhealthy
    unhealthy=$(docker compose ps --format '{{.Service}} {{.Health}}' | awk '$2 != "healthy" {print $1}' | tr '\n' ' ')
    if [ -z "$unhealthy" ]; then log "all services healthy"; return 0; fi
    sleep 5
  done
  docker compose ps
  return 1
}

images_present() {
  local svc
  for svc in etl-api backend frontend etl-worker; do
    docker image inspect "07ps/$svc:$1" > /dev/null 2>&1 || return 1
  done
}

# bring_up <tag> <build|reuse>: "build" (deploy) builds/pulls the release; "reuse" (rollback) starts images
# that already exist locally under <tag> and never rebuilds -- a rebuild would tag the *current* checkout
# with the old tag.
bring_up() {
  local tag="$1" mode="${2:-build}"
  export IMAGE_TAG="$tag"
  if [ "$mode" = "build" ]; then
    if [ -n "${IMAGE_REGISTRY:-}" ]; then
      # Retag registry images to the local names docker-compose.yml uses.
      for svc in etl-api backend frontend etl-worker; do
        docker pull "$IMAGE_REGISTRY/07ps/$svc:$tag"
        docker tag "$IMAGE_REGISTRY/07ps/$svc:$tag" "07ps/$svc:$tag"
      done
    else
      docker compose build
    fi
  elif ! images_present "$tag"; then
    if [ -n "${IMAGE_REGISTRY:-}" ]; then
      bring_up "$tag" build
      return
    fi
    die "images 07ps/*:$tag are not on this host; check out tag $tag and run: scripts/deploy.sh deploy $tag"
  fi
  docker compose up -d --remove-orphans
}

smoke() {
  # shellcheck disable=SC2086
  python3 scripts/post_deploy_check.py ${1:-}
}

cmd_deploy() {
  local tag="${1:-}"
  [ -n "$tag" ] || die "usage: deploy.sh deploy <image-tag>"
  preflight_files
  local previous
  previous=$(current_tag)

  if [ "${SKIP_BACKUP:-0}" != "1" ]; then
    log "backing up the database"
    scripts/backup_db.sh
  fi

  if [ -n "${MIGRATION_ENV_FILE:-}" ]; then
    log "applying migrations: ${MIGRATIONS:-0022_etl_run_log.sql}"
    # shellcheck disable=SC2086
    ( set -a; . "$MIGRATION_ENV_FILE"; set +a; python3 data/warehouse/apply_migrations.py ${MIGRATIONS:-0022_etl_run_log.sql} )
  else
    log "MIGRATION_ENV_FILE not set: assuming migrations were applied by hand"
  fi

  log "starting release $tag (previous: ${previous:-none})"
  bring_up "$tag"
  if wait_healthy && smoke "${SMOKE_ARGS:---run-etl}"; then
    if [ -n "$previous" ]; then echo "$previous" > "$STATE_DIR/previous_tag"; fi
    echo "$tag" > "$STATE_DIR/current_tag"
    log "release $tag deployed and verified"
    return 0
  fi

  log "release $tag FAILED verification"
  if [ "${AUTO_ROLLBACK:-1}" = "1" ] && [ -n "$previous" ]; then
    cmd_rollback "$previous"
    die "rolled back to $previous; investigate release $tag"
  fi
  die "no automatic rollback (AUTO_ROLLBACK=${AUTO_ROLLBACK:-1}, previous=${previous:-none})"
}

cmd_rollback() {
  local tag="${1:-$(cat "$STATE_DIR/previous_tag" 2>/dev/null || true)}"
  [ -n "$tag" ] || die "no tag given and no previous tag recorded"
  preflight_files
  log "rolling back to $tag (database migrations are additive and are NOT reverted; restore a backup for data)"
  bring_up "$tag" reuse
  wait_healthy || die "services unhealthy after rollback to $tag"
  smoke "" || die "smoke check failed after rollback to $tag"
  echo "$tag" > "$STATE_DIR/current_tag"
  log "rolled back to $tag"
}

cmd_status() {
  echo "current:  $(current_tag)"
  echo "previous: $(cat "$STATE_DIR/previous_tag" 2>/dev/null || echo -)"
  docker compose ps
}

case "${1:-}" in
  deploy)   shift; cmd_deploy "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  status)   cmd_status ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
