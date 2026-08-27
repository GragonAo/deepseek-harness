# Tenant tool-exec container image. The tool-exec server is a zero-dependency
# Node HTTP process (POST /exec spawns argv inside the container); this image
# bundles that single source (`../src/tool-exec.ts`) and ships it on
# Debian-slim, so the filesystem adapter's stat/find/base64/test/`command -v`
# coreutils semantics hold (alpine/busybox would change them). The bash tool
# spawns `bash -c`, and bash is a package (not part of coreutils), so the
# runtime stage installs it explicitly — `node:22-bookworm-slim` ships only
# dash as `/bin/sh`.
#
# Build from the repository root:
#   docker build -f packages/tenant/container-docker/docker/Dockerfile \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t dsh-tool-exec:latest .

FROM node:22-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /build
COPY packages/tenant/container-docker/src/tool-exec.ts ./tool-exec.ts
COPY packages/tenant/container-docker/docker/entry.mjs ./entry.mjs
RUN npm install --no-save --registry="$NPM_REGISTRY" esbuild@0.28.1 >/dev/null 2>&1 \
  && ./node_modules/.bin/esbuild tool-exec.ts --bundle --platform=node --format=esm --target=node22 --outfile=tool-exec.mjs

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/tool-exec
COPY --from=build /build/tool-exec.mjs /build/entry.mjs ./
EXPOSE 8642
ENTRYPOINT ["node", "entry.mjs"]
CMD ["8642", "0.0.0.0"]