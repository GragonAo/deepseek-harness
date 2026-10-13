# Tenant tool-exec container image. The tool-exec server is a zero-dependency
# Node HTTP process (POST /exec spawns argv inside the container); this image
# bundles that single source (`../src/tool-exec.ts`) and ships it on
# Debian-slim, so the filesystem adapter's stat/find/base64/test/`command -v`
# coreutils semantics hold (alpine/busybox would change them). The bash tool
# spawns `bash -c`, and bash is a package (not part of coreutils), so the
# runtime stage installs it explicitly — `node:22-bookworm-slim` ships only
# dash as `/bin/sh`.
#
# The image carries no Python runtime: every interpreter and every package a case
# skill imports comes from the host directory `Config.pythonRoot` mounts at its
# own absolute path (packages/tenant/container-docker/README.md). One portable
# Python lives on the host, so a version bump or a new dependency is one directory
# change for every sandbox rather than an image rebuild, the interpreter version
# cannot drift from the packages installed beside it, and no package index supplies
# the interpreter. A sandbox started without that mount has no `python3` at all,
# which is the intended failure — the mount is a hard requirement, not an
# optimization.
#
# Build from the repository root:
#   docker build -f packages/tenant/container-docker/docker/Dockerfile \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t dsh-tool-exec:latest .

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /build
COPY packages/tenant/container-docker/src/tool-exec.ts ./tool-exec.ts
COPY packages/tenant/container-docker/docker/entry.mjs ./entry.mjs
RUN npm install --no-save --registry="$NPM_REGISTRY" esbuild@0.28.1 >/dev/null 2>&1 \
  && ./node_modules/.bin/esbuild tool-exec.ts --bundle --platform=node --format=esm --target=node22 --outfile=tool-exec.mjs

FROM ${NODE_IMAGE}
# The slim base ships only dash as /bin/sh; a full node:22-bookworm already has bash,
# and skipping the install keeps the build working where the Debian mirrors are
# unreachable from it.
RUN command -v bash >/dev/null 2>&1 || (apt-get update \
  && apt-get install -y --no-install-recommends bash \
  && rm -rf /var/lib/apt/lists/*)
# Signal delivery runs `kill` as a program, not as a shell builtin (session-probe.ts:142-153),
# so the binary must exist: without it a terminal session cannot be signalled or torn down.
# The slim base ships no kill binary, and the guard is a path test rather than `command -v`,
# which succeeds on the shell builtin and would silently skip this install.
RUN [ -x /usr/bin/kill ] || (apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*)
# ripgrep backs the glob/grep tools, whose execution side is THIS container: the
# harness resolves @vscode/ripgrep on the host, and that absolute path does not
# exist here, so the tenant stack points dsh-tool-fs-search's `ripgrepPath` at the
# path installed below (packages/tenant/tenant-app/src/spine.ts). The platform
# package carries the static binary, so this install reaches no GitHub release —
# only the npm registry the build already uses. The version matches the host-side
# @vscode/ripgrep dependency range, and the package installed is the linux-x64 one
# this amd64-hosted image uses; a build for another architecture trips the final
# assertion instead of shipping a binary the container cannot exec, and the
# assertion equally keeps a registry failure, a vanished file, or an unloadable
# binary out of a shipped image.
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN mkdir -p /tmp/rg \
  && cd /tmp/rg \
  && npm install --no-save --registry="$NPM_REGISTRY" @vscode/ripgrep-linux-x64@1.18.0 >/dev/null \
  && install -m 0755 /tmp/rg/node_modules/@vscode/ripgrep-linux-x64/bin/rg /usr/local/bin/rg \
  && rm -rf /tmp/rg /root/.npm \
  && test -x /usr/local/bin/rg \
  && /usr/local/bin/rg --version
# Case scripts discover skills by enumerating one root, and the provider mounts each
# skill tier under it: /opt/data/skills/<tier>/<skill>/. Tiers keep their own
# subdirectory because a mount carries one source to one path, and one skill name may
# exist in more than one tier at once. The interpreter is not in this image, so
# /opt/hermes/.venv/bin/python3 is a wrapper around `python3` from PATH, where the
# provider puts the mounted environment's bin directory first. With no environment
# mounted the wrapper fails as `python3: not found` instead of running some other
# interpreter.
RUN mkdir -p /opt/data/skills /opt/hermes/.venv/bin \
  && printf '#!/bin/sh\nexec python3 "$@"\n' > /opt/hermes/.venv/bin/python3 \
  && chmod 0755 /opt/hermes/.venv/bin/python3
WORKDIR /opt/tool-exec
COPY --from=build /build/tool-exec.mjs /build/entry.mjs ./
EXPOSE 8642
ENTRYPOINT ["node", "entry.mjs"]
CMD ["8642", "0.0.0.0"]