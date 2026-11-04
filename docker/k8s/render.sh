#!/usr/bin/env bash
# 渲染本仓的 k8s 清单：manifests/ 里的 __VAR__ 用「本仓 vars.env + 站点 env」替换。
#
# 这是「换一台机器只改一个 .env」的落地入口；每个仓都有一份相同副本，
# deploy-kit 的 scripts/contract.sh 会校验副本一致，防止各仓各写一套。
#
# 依赖：bash 4+、python3、kubectl（仅 --apply/--diff 时需要）。
#
#   ./render.sh --site /opt/icac/site.env               # 只渲染到 build/<site>/
#   ./render.sh --site /opt/icac/site.env --diff        # 列出与线上的差异
#   ./render.sh --site /opt/icac/site.env --apply       # 落地并等滚动
#   ./render.sh --site 171                              # 用 ${SITE_DIR}/171.env
#   ./render.sh --site 171 --set NS_CORE=jeecg-b --set NP_WEB=32800   # 同一集群跑第二套实例
#
# 变量优先级：vars.env（本仓默认） < 站点 env < --set。
# 站点 env 没写的用本仓默认；默认也没有的，渲染直接失败并列出缺哪些。
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
K8S="$HERE"
SITE_DIR=${SITE_DIR:-}
OUT=""
MODE=render
SITE_FILE=""
SETS=()

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --site)     SITE_FILE=${2:?--site 需要路径或站点名}; shift 2 ;;
    --out)      OUT=${2:?--out 需要目录}; shift 2 ;;
    --set)      SETS+=("${2:?--set 需要 KEY=VALUE}"); shift 2 ;;
    --apply)    MODE=apply; shift ;;
    --diff)     MODE=diff; shift ;;
    --render)   MODE=render; shift ;;
    -h|--help)  usage 0 ;;
    *) echo "未知参数 $1" >&2; usage 1 ;;
  esac
done

[ -n "$SITE_FILE" ] || { echo "缺少 --site（站点 env 文件或站点名）" >&2; usage 1; }
if [ ! -f "$SITE_FILE" ]; then
  if [ -n "$SITE_DIR" ] && [ -f "$SITE_DIR/$SITE_FILE.env" ]; then
    SITE_FILE="$SITE_DIR/$SITE_FILE.env"
  else
    echo "找不到站点配置 $SITE_FILE（--site 传文件路径，或设 SITE_DIR 后传站点名）" >&2; exit 1
  fi
fi
SITE=$(basename "$SITE_FILE" .env)
[ -n "$OUT" ] || OUT="$K8S/build/$SITE"

set -a
[ -f "$K8S/vars.env" ] && . "$K8S/vars.env"
. "$SITE_FILE"
# 凭据不进站点 env：同目录 <站点>.secrets.env（chmod 600，不进 git）里有就直接加载。
SECRETS_FILE=${SECRETS_FILE:-$(dirname "$SITE_FILE")/$SITE.secrets.env}
if [ -f "$SECRETS_FILE" ]; then . "$SECRETS_FILE"; fi
for kv in "${SETS[@]:-}"; do
  [ -n "$kv" ] || continue
  case "$kv" in *=*) export "${kv%%=*}=${kv#*=}" ;; *) echo "--set 需要 KEY=VALUE：$kv" >&2; exit 1 ;; esac
done
set +a

: "${WEB_PUBLIC_URL:=http://${SITE_HOST}:${NP_WEB}}"
: "${ADMIN_PUBLIC_URL:=http://${SITE_HOST}:${NP_ADMIN}}"
: "${OO_PUBLIC_URL:=http://${SITE_HOST}:${NP_OO}}"
: "${TENANT_URL:=http://${SITE_HOST}:${NP_TENANT}}"
: "${GATEWAY_URL:=http://${SITE_HOST}:${NP_GATEWAY}}"
: "${GATEWAY_EXT_URL:=http://${SITE_HOST}:8060}"
: "${DSH_PUBLIC_BASE_URL:=http://${SITE_HOST}:${NP_TENANT}}"
: "${TAG_OO:=${TAG}}"
export SITE SITE_HOST WEB_PUBLIC_URL ADMIN_PUBLIC_URL OO_PUBLIC_URL TENANT_URL GATEWAY_URL GATEWAY_EXT_URL DSH_PUBLIC_BASE_URL TAG_OO

echo "== 渲染 $REPO"
echo "   站点：$SITE_FILE"
echo "   输出：$OUT"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -a "$K8S/manifests/." "$OUT/"

python3 - "$OUT" <<'PY'
import hashlib, os, re, sys

out = sys.argv[1]
TOKEN = re.compile(r'__([A-Z0-9_]+)__')
missing = {}

def body_of_cm(text, key='default.conf'):
    body, inside = [], False
    for line in text.splitlines():
        if not inside:
            if line.startswith('  ') and line.strip() == key + ': |':
                inside = True
            continue
        if line.startswith('    '):
            body.append(line[4:])
        elif line.strip() == '':
            body.append('')
        else:
            break
    while body and body[-1] == '':
        body.pop()
    return chr(10).join(body) + chr(10)

cm_md5 = {}
for name in sorted(os.listdir(out)):
    if not name.endswith('.yaml'):
        continue
    with open(os.path.join(out, name), encoding='utf-8') as fh:
        if 'default.conf: |' in fh.read():
            with open(os.path.join(out, name), encoding='utf-8') as fh2:
                cm_md5[name] = hashlib.md5(body_of_cm(fh2.read()).encode('utf-8')).hexdigest()
if len(set(cm_md5.values())) > 1:
    print('   渲染目录里有多个 default.conf，无法确定 checksum：' + ', '.join(sorted(cm_md5)), file=sys.stderr)
    sys.exit(2)
CM_MD5 = list(cm_md5.values())[0] if cm_md5 else ''

for name in sorted(os.listdir(out)):
    if not name.endswith('.yaml'):
        continue
    path = os.path.join(out, name)
    with open(path, encoding='utf-8') as fh:
        text = fh.read()

    if CM_MD5:
        text = text.replace('__CM_WEB_MD5__', CM_MD5).replace('__CM_ADMIN_MD5__', CM_MD5)

    def sub(m):
        key = m.group(1)
        val = os.environ.get(key)
        if val is None or val == '':
            missing.setdefault(key, []).append(name)
            return m.group(0)
        return val

    text = TOKEN.sub(sub, text)

    if re.search(r'(?m)^\s*type:\s*ClusterIP[ \t]*\n', text):
        text = re.sub(r'(?m)^\s*nodePort:\s*[0-9A-Za-z_]+[ \t]*\n', '', text)

    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(text)
leftovers = {}
for name in sorted(os.listdir(out)):
    if not name.endswith('.yaml'):
        continue
    with open(os.path.join(out, name), encoding='utf-8') as fh:
        for m in TOKEN.finditer(fh.read()):
            leftovers.setdefault(m.group(1), []).append(name)

if missing or leftovers:
    for key in sorted(missing):
        print('   缺少变量 %s（用于 %s）' % (key, ', '.join(sorted(set(missing[key])))), file=sys.stderr)
    for key in sorted(leftovers):
        if key not in missing:
            print('   未解析占位符 %s（用于 %s）' % (key, ', '.join(sorted(set(leftovers[key])))), file=sys.stderr)
    sys.exit(2)
print('   变量全部解析')
PY

echo "   清单：$(ls -1 "$OUT" | tr '\n' ' ')"
[ "$MODE" = render ] && exit 0
[ "$MODE" = diff ] && { kubectl diff -f "$OUT" || true; exit 0; }

kubectl apply -f "$OUT"
python3 - "$OUT" <<'PY' | while IFS= read -r d; do
import os, sys
out = sys.argv[1]
for name in sorted(os.listdir(out)):
    if not name.endswith('.yaml'):
        continue
    with open(os.path.join(out, name), encoding='utf-8') as fh:
        text = fh.read()
    if 'kind: Deployment' not in text:
        continue
    dep = ns = None
    for line in text.splitlines():
        if dep is None and line.startswith('  name: '):
            dep = line.split(':', 1)[1].strip()
        if ns is None and line.startswith('  namespace: '):
            ns = line.split(':', 1)[1].strip()
        if dep and ns:
            break
    if dep and ns:
        print(ns + '/' + dep)
PY
  echo "== 等滚动 $d"
  kubectl -n "${d%%/*}" rollout status "deploy/${d##*/}" --timeout="${ROLLOUT_TIMEOUT:-420}s"
done
echo "== 完成：$SITE"
