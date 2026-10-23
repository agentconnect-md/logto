#!/usr/bin/env bash
set -euo pipefail

image="${1:?Pass the image built with --target verification}"
network="logto-fork-verify-$$"
database="logto-fork-db-$$"
runner="logto-fork-check-$$"
cleanup() {
  docker rm -f "$runner" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

docker run --rm --name "$runner" --cpus=2 --memory=3g --entrypoint sh "$image" \
  -c 'cd /etc/logto/packages/core && NODE_OPTIONS=--max-old-space-size=2048 pnpm build:test && NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=2048" pnpm exec jest --runInBand build/queries/user.test.js build/routes/admin-user/social.test.js build/routes/experience/classes/helpers.test.js build/routes/experience/classes/experience-interaction.test.js build/routes/experience/classes/experience-interaction.adaptive-mfa.test.js build/routes/experience/classes/experience-interaction.trusted-device.test.js'
docker network create "$network" >/dev/null
docker run -d --name "$database" --network "$network" --cpus=1 --memory=512m \
  -e POSTGRES_USER=logto -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=logto \
  postgres:16-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec "$database" pg_isready -U logto >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$database" pg_isready -U logto
docker run --rm --name "$runner" --network "$network" --cpus=1 --memory=1g \
  -e "DB_URL=postgres://logto:local-test-only@${database}:5432/logto" \
  --entrypoint npm "$image" run cli -- db seed --swe
docker exec "$database" psql -U logto -d logto -v ON_ERROR_STOP=1 \
  -c "alter role logto_tenant_logto_default login password 'local-test-only'"
docker run --rm --name "$runner" --network "$network" --cpus=2 --memory=1g \
  -e "DB_URL=postgres://logto_tenant_logto_default:local-test-only@${database}:5432/logto" "$image"
