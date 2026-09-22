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
# Case data is Excel (.xlsx/.xls) and this image ships no reader for it. Install one
# at build time — the sandbox downloads nothing at run time — from the PyPI mirror the
# deployment host can reach. The interpreter has no ensurepip, so pip itself comes from
# get-pip.py, and PEP 668's externally-managed marker is overridden because this image
# exists only to run case tooling.
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
RUN curl -sS https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py \
  && python3 /tmp/get-pip.py --quiet --break-system-packages \
  && pip3 install --no-cache-dir --break-system-packages -i "${PIP_INDEX_URL}" openpyxl xlrd pandas \
  && rm -rf /tmp/get-pip.py /root/.cache/pip
# Case skills are written against their original host layout: the bundled report
# builder is invoked as /opt/data/skills/<skill>/report_html/build_report_html.py
# with /opt/hermes/.venv/bin/python3. Both paths resolve inside the sandbox —
# /opt/data/skills is the case-shared skill directory it is mounted from, and the
# interpreter is this image's own python3.
RUN mkdir -p /opt/data /opt/hermes/.venv/bin \
  && ln -s /shared/skills /opt/data/skills \
  && ln -s /usr/bin/python3 /opt/hermes/.venv/bin/python3
WORKDIR /opt/tool-exec
COPY --from=build /build/tool-exec.mjs /build/entry.mjs ./
EXPOSE 8642
ENTRYPOINT ["node", "entry.mjs"]
CMD ["8642", "0.0.0.0"]