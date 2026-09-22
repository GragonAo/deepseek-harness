#!/bin/bash
# Container entrypoint: replay the deploy patches, then start the multi-tenant host.
#
# The patches live outside the image (mounted from the deployment directory), so an
# upstream sync never conflicts with them, and replaying them on every start keeps
# the image a pure build of the source while the deployment's local edits stay
# reproducible. A patch that cannot be applied aborts the start rather than booting
# a host on the wrong configuration.
set -euo pipefail

: "${DSH_REPO:=/root/work/deepseek-harness}"
: "${DSH_DEPLOY_DIR:=/opt/dsh-deploy}"

if [ -x "$DSH_DEPLOY_DIR/apply-patches.sh" ]; then
  echo "[dsh-entrypoint] replay deploy patches: $DSH_DEPLOY_DIR/patches"
  DSH_REPO="$DSH_REPO" "$DSH_DEPLOY_DIR/apply-patches.sh" \
    || { echo '[dsh-entrypoint] FATAL: deploy patches did not all apply'; exit 1; }
fi

echo "[dsh-entrypoint] start: node $DSH_REPO/apps/cli/lib/bin.js $*"
exec node "$DSH_REPO/apps/cli/lib/bin.js" "$@"
