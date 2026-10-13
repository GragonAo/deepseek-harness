#!/bin/bash
# 构建租户栈用到的两个镜像。所有下载与编译都在这里、在构建期完成 —— 运行中的容器不联网取任何东西。
#
#   docker/build-images.sh
#   NPM_REGISTRY=https://registry.npmjs.org docker/build-images.sh
#   NODE_IMAGE=node:22-bookworm TOOL_EXEC_NODE_IMAGE=node:22-bookworm-slim docker/build-images.sh
#
# dsh-tool-exec 是宿主运行时按 (租户,用户) 拉起的沙箱；dsh-tenant 是租户服务宿主本身，
# 生产由 k8s 的 Deployment 起（docker/k8s/tenant-host.yaml），本地开发由
# docker/docker-compose.tenant.yml 起。两个镜像的基座必须不同，所以各用一个变量。
#
# dsh-tool-exec 里没有任何 Python 运行时：沙箱用的解释器与全部依赖都来自宿主目录挂载进来的
# /opt/.dsh/pyenv，由构建之外维护（packages/tenant/container-docker/README.md）。所以它的基座
# 是 slim —— 也是那个 Dockerfile 自己的默认值。完整基座是 buildpack-deps，自带 python3-minimal，
# 用它构建沙箱会把第二个、无关的解释器塞进镜像，在 PATH 上遮蔽挂载进来的那个，静默废掉整套安排。
# TOOL_EXEC_NODE_IMAGE 默认 slim，必须保持 slim。直接 `docker build` 那个 Dockerfile 是安全的
# （它的 ARG 默认值就是 slim），所以这个变量与脚本末尾的自检是给脚本这条路兜底，而不是修 Dockerfile。
#
# dsh-tenant 要从源码编译整个仓库，需要完整基座的工具链，所以 NODE_IMAGE 默认完整镜像。
#
# 两个镜像共用一个变量就是这套拆分要避免的错误：它曾构建出 /usr/bin/python3 与挂载的
# /opt/.dsh/pyenv 并存的沙箱镜像。每次构建都重新自检：
#
#   docker run --rm --entrypoint sh dsh-tool-exec:latest -c 'command -v python3 || echo NO-PYTHON'
#
# 必须打印 NO-PYTHON。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
NODE_IMAGE=${NODE_IMAGE:-docker.m.daocloud.io/library/node:22-bookworm}
TOOL_EXEC_NODE_IMAGE=${TOOL_EXEC_NODE_IMAGE:-docker.m.daocloud.io/library/node:22-bookworm-slim}
DOCKER_CLI_IMAGE=${DOCKER_CLI_IMAGE:-docker.m.daocloud.io/library/docker:27-cli}
cd "$ROOT"

# 构建上下文排除了 .git，所以显式传入源码提交：镜像据此记录自己的来源，否则构建会在
# `git rev-parse HEAD` 上失败。
DSH_COMMIT=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo 0000000)
echo "== 源码提交 $DSH_COMMIT"

echo "== dsh-tool-exec:latest（租户沙箱，宿主运行时按需拉起）"
docker build -f packages/tenant/container-docker/docker/Dockerfile \
  --build-arg "NODE_IMAGE=$TOOL_EXEC_NODE_IMAGE" \
  --build-arg "NPM_REGISTRY=$NPM_REGISTRY" \
  -t dsh-tool-exec:latest .

echo "== dsh-tenant:latest（租户服务宿主）"
docker build -f Dockerfile.tenant \
  --build-arg "NODE_IMAGE=$NODE_IMAGE" \
  --build-arg "DOCKER_CLI_IMAGE=$DOCKER_CLI_IMAGE" \
  --build-arg "NPM_REGISTRY=$NPM_REGISTRY" \
  --build-arg "DSH_COMMIT=$DSH_COMMIT" \
  -t dsh-tenant:latest .

echo "== 自检：沙箱镜像不含 Python（解释器由挂载的 /opt/.dsh/pyenv 提供）"
if docker run --rm --entrypoint sh dsh-tool-exec:latest -c 'command -v python3' >/dev/null 2>&1; then
  echo "!! dsh-tool-exec 里存在 python3：基座不是 slim（TOOL_EXEC_NODE_IMAGE=$TOOL_EXEC_NODE_IMAGE）" >&2
  echo "!! 镜像自带的解释器会遮蔽挂载的 /opt/.dsh/pyenv，沙箱行为与部署契约不一致。" >&2
  exit 1
fi
echo "   OK: NO-PYTHON"

echo '== done'