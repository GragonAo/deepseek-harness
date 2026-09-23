#!/bin/bash
# Build every image the multi-tenant deployment runs. All downloading and building
# happens here, at build time — the running containers fetch nothing.
#
#   docker/build-images.sh
#   NPM_REGISTRY=https://registry.npmjs.org docker/build-images.sh
#   NODE_IMAGE=node:22-bookworm TOOL_EXEC_NODE_IMAGE=node:22-bookworm-slim docker/build-images.sh
#
# dsh-tool-exec is the per-(tenant,user) sandbox the host spawns at runtime;
# dsh-multi-tenant is the host that compose starts directly.
#
# The two images need different base images, so they take different variables.
#
# dsh-tool-exec carries no Python runtime at all: the interpreter and every package the
# sandboxes run come from the host directory compose mounts at /opt/.dsh/pyenv, maintained
# outside this build (packages/tenant/container-docker/README.md). Its base is therefore the
# slim image, which is also the Dockerfile's own default. The full base is buildpack-deps and
# ships python3-minimal, so building the sandbox on it puts a second, unrelated interpreter
# inside the image, shadows the mounted one on PATH, and silently defeats the arrangement.
# TOOL_EXEC_NODE_IMAGE defaults to slim and must stay slim. A `docker build` straight from
# that Dockerfile is safe on its own — its own ARG default is already slim — so this variable
# and the check at the end of this script backstop the script path rather than repair the
# Dockerfile.
#
# dsh-multi-tenant compiles the harness from source and needs the full base's toolchain,
# so NODE_IMAGE defaults to the full image.
#
# One variable for both is the mistake this split prevents: it built a sandbox image with
# /usr/bin/python3 next to the mounted /opt/.dsh/pyenv. Every run re-checks with
#
#   docker run --rm --entrypoint sh dsh-tool-exec:latest -c 'command -v python3 || echo NO-PYTHON'
#
# which must print NO-PYTHON.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
NODE_IMAGE=${NODE_IMAGE:-docker.m.daocloud.io/library/node:22-bookworm}
TOOL_EXEC_NODE_IMAGE=${TOOL_EXEC_NODE_IMAGE:-docker.m.daocloud.io/library/node:22-bookworm-slim}
DOCKER_CLI_IMAGE=${DOCKER_CLI_IMAGE:-docker.m.daocloud.io/library/docker:27-cli}
cd "$ROOT"

# The build context excludes .git, so pass the source commit explicitly: the build
# records it in client artifacts and would otherwise fail on `git rev-parse HEAD`.
DSH_COMMIT=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo 0000000)
echo "== 源码提交 $DSH_COMMIT"

echo "== dsh-tool-exec:latest（租户沙箱，宿主运行时按需拉起）"
docker build -f packages/tenant/container-docker/docker/Dockerfile \
  --build-arg "NODE_IMAGE=$TOOL_EXEC_NODE_IMAGE" \
  --build-arg "NPM_REGISTRY=$NPM_REGISTRY" \
  -t dsh-tool-exec:latest .

echo "== dsh-multi-tenant:latest（多租户宿主，compose 直接用这个镜像）"
docker build -f Dockerfile.multi-tenant \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --build-arg "DOCKER_CLI_IMAGE=$DOCKER_CLI_IMAGE" \
  --build-arg "NPM_REGISTRY=$NPM_REGISTRY" \
  --build-arg "DSH_COMMIT=$DSH_COMMIT" \
  -t dsh-multi-tenant:latest .

echo "== 自检：沙箱镜像不含 Python（解释器由挂载的 /opt/.dsh/pyenv 提供）"
if docker run --rm --entrypoint sh dsh-tool-exec:latest -c 'command -v python3' >/dev/null 2>&1; then
  echo "!! dsh-tool-exec 里存在 python3：基座不是 slim（TOOL_EXEC_NODE_IMAGE=$TOOL_EXEC_NODE_IMAGE）" >&2
  echo "!! 镜像自带的解释器会遮蔽挂载的 /opt/.dsh/pyenv，沙箱行为与部署契约不一致。" >&2
  exit 1
fi
echo "   OK: NO-PYTHON"

echo '== done'
