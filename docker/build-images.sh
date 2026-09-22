#!/bin/bash
# Build every image the multi-tenant deployment runs. All downloading and building
# happens here, at build time — the running containers fetch nothing.
#
#   docker/build-images.sh
#   NODE_IMAGE=node:22-bookworm NPM_REGISTRY=https://registry.npmjs.org docker/build-images.sh
#
# dsh-tool-exec is the per-(tenant,user) sandbox the host spawns at runtime;
# dsh-multi-tenant is the host that compose starts directly.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
NODE_IMAGE=${NODE_IMAGE:-docker.m.daocloud.io/library/node:22-bookworm}
DOCKER_CLI_IMAGE=${DOCKER_CLI_IMAGE:-docker.m.daocloud.io/library/docker:27-cli}
cd "$ROOT"

# The build context excludes .git, so pass the source commit explicitly: the build
# records it in client artifacts and would otherwise fail on `git rev-parse HEAD`.
DSH_COMMIT=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo 0000000)
echo "== 源码提交 $DSH_COMMIT"

echo "== dsh-tool-exec:latest（租户沙箱，宿主运行时按需拉起）"
docker build -f packages/tenant/container-docker/docker/Dockerfile \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --build-arg "NPM_REGISTRY=$NPM_REGISTRY" \
  -t dsh-tool-exec:latest .

echo "== dsh-multi-tenant:latest（多租户宿主，compose 直接用这个镜像）"
docker build -f Dockerfile.multi-tenant \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --build-arg "DOCKER_CLI_IMAGE=$DOCKER_CLI_IMAGE" \
  --build-arg "NPM_REGISTRY=$NPM_REGISTRY" \
  --build-arg "DSH_COMMIT=$DSH_COMMIT" \
  -t dsh-multi-tenant:latest .

echo '== done'
