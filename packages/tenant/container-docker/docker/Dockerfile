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
# cannot drift from the packages installed beside it, and this build reaches no
# package index. A sandbox started without that mount has no `python3` at all,
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
# Case skills are written against their original host layout: the bundled report
# builder is invoked as /opt/data/skills/<skill>/report_html/build_report_html.py
# with /opt/hermes/.venv/bin/python3. /opt/data/skills is the case-shared skill
# directory it is mounted from; the interpreter is not in this image, so that path
# is a wrapper around `python3` from PATH, where the provider puts the mounted
# environment's bin directory first. With no environment mounted the wrapper fails
# as `python3: not found` instead of running some other interpreter.
RUN mkdir -p /opt/data /opt/hermes/.venv/bin \
  && ln -s /shared/skills /opt/data/skills \
  && printf '#!/bin/sh\nexec python3 "$@"\n' > /opt/hermes/.venv/bin/python3 \
  && chmod 0755 /opt/hermes/.venv/bin/python3
WORKDIR /opt/tool-exec
COPY --from=build /build/tool-exec.mjs /build/entry.mjs ./
EXPOSE 8642
ENTRYPOINT ["node", "entry.mjs"]
CMD ["8642", "0.0.0.0"]