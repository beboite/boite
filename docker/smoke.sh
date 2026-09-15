#!/usr/bin/env bash
set -euo pipefail
image=${1:?usage: bash docker/smoke.sh IMAGE}
channel=${2:-stable}
version=${3:-}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
name="boite-smoke-${RANDOM}-$$"
volume="${name}-data"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
docker run -d --name "$name" --cpus=2 --memory=2g \
  -e BOITE_ECHO=1 -e BOITE_DATA_DIR=/data \
  --mount "type=volume,source=$volume,target=/data" "$image" >/dev/null
ready() {
  for ((attempt=0; attempt<60; attempt++)); do
    if docker exec "$name" bun /app/healthcheck.ts >/dev/null 2>&1; then return; fi
    sleep 1
  done
  docker logs "$name"
  return 1
}
ready
test "$(docker exec "$name" id -u)" != 0
docker cp "$script_dir/smoke.ts" "$name:/tmp/smoke.ts"
docker exec -e "BOITE_SMOKE_CHANNEL=$channel" -e "BOITE_SMOKE_VERSION=$version" "$name" bun /tmp/smoke.ts create
docker stop --time 20 "$name" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$name")" = 0
docker start "$name" >/dev/null
ready
docker exec -e "BOITE_SMOKE_CHANNEL=$channel" -e "BOITE_SMOKE_VERSION=$version" "$name" bun /tmp/smoke.ts restore
echo 'Docker smoke passed: UI, authentication, echo turn, persistence, graceful stop, non-root user'
