# deepseek-harness Helm chart

DSH 多租户宿主：`tenant host` Deployment + `Service` + 工作区 `PVC` + 沙箱所需 `ServiceAccount/Role/RoleBinding` + 租户配置 `Secret`。

本 chart 与 `deepseek-harness/docker/k8s/manifests/` + `docker/k8s/render.sh` **渲染同一批对象**（双轨制，规范见 `deploy-kit/docs/helm-standard.md`）。改任一侧都要同步另一侧，并用 `deploy-kit/scripts/helm-parity.sh` 校验。

```sh
# 语义比对（必须 PASS：fail=0 missing=0 extra=0，improve 是预期的「基线欠债被补上」）
deploy-kit/scripts/helm-parity.sh --repo deepseek-harness --site 130 --show-diff
deploy-kit/scripts/helm-parity.sh --repo deepseek-harness --site 171 --show-diff
helm lint deploy-kit/../deepseek-harness/deploy/helm/deepseek-harness --strict
```

---

## 1. 快速开始

### 1.1 站点部署（推荐：走 deploy-kit）

站点差异不写在这个仓库里。`deploy-kit/scripts/helm-site-map.txt` 会把 `deploy-kit/machines/<站点>.env` 里的一组键注入到下面的 values 路径，凭据来自 `<站点>.secrets.env`（不进 git）：

```sh
cd deploy-kit
./scripts/helm-parity.sh --repo deepseek-harness --site 130     # 先确认双轨一致
helm upgrade --install dsh-tenant ../deepseek-harness/deploy/helm/deepseek-harness \
  -n dsh --create-namespace \
  -f <(./scripts/site-values.sh --repo deepseek-harness --site 130)
```

### 1.2 单仓独立部署（没有 deploy-kit 时）

```sh
# 0) 前提：命名空间、PostgreSQL、镜像、RWX StorageClass、工作区目录树（见 §5）
kubectl create namespace dsh

# 1) 凭据（chart 默认不建 Secret；键名见 §4）
kubectl -n dsh create secret generic dsh-tenant-secret \
  --from-literal=DSH_TENANT_OIDC_SECRET='<与签发方共享的密钥>' \
  --from-literal=NEWAPI_API_KEY='<模型 key>' \
  --from-literal=DSH_OBJECT_ACCESS_KEY='<RGW access key>' \
  --from-literal=DSH_OBJECT_SECRET_KEY='<RGW secret key>'
kubectl -n dsh create secret generic dsh-llm-secret \
  --from-literal=DEEPSEEK_API_KEY='<模型 key>'

# 2) 装
helm upgrade --install dsh-tenant ./deploy/helm/deepseek-harness -n dsh \
  --set image.tag=ai-icac-dsh-v1.0.23 \
  --set middleware.database.password='<PG 密码>' \
  --set dependencies.dshPublicBaseUrl=http://<站点IP>:30788 \
  --set config.tenantConfig.volumeKind=secret
```

最后一行不是可选的：`volumeKind` 默认是 `configMap`（原清单的历史缺陷，见 §6），新环境用 `secret` 才能挂上 chart 自己建的那份租户配置。

### 1.3 只渲染不装

```sh
helm template dsh-tenant ./deploy/helm/deepseek-harness -n dsh | less
```

不带任何 `-f` / `--set` 也能渲染成功（`helm-standard.md` §三-1），只有凭据与对外地址是空值 —— 空值不会让渲染失败，由 §3 的清单点名。

---

## 2. 对象与名字

渲染出的 7 个对象（`kind` / 名字 / 命名空间全部写死在 values 的 `names.*`，不跟随 release 名）：

| kind | name | 说明 |
| --- | --- | --- |
| Deployment | `dsh-tenant-host` | 多租户宿主，`replicas` 只允许 1 |
| Service | `dsh-tenant` | 被 `hermes-jeecg-ai` 按固定 DNS 引用 |
| PersistentVolumeClaim | `dsh-workspace` | RWX 工作区，宿主与沙箱共用 |
| ServiceAccount / Role / RoleBinding | `dsh-host` | 沙箱 Pod 的 create/delete + `pods/exec` |
| Secret | `dsh-tenant-config` | 租户配置正文（`files/tenant-config.yaml`） |

为什么名字不可配：

* `dsh-tenant` 的 DNS 名写在 `hermes-jeecg-ai` 的 values 里（`SVC_TENANT`）；
* `dsh-tenant-host` 是 Service 的 selector 值，而 `spec.selector.matchLabels` **不可变**。

`spec.selector` 只保留历史键 `app: <component>`；`metadata.labels` 与 Pod 模板标签额外补了 `app.kubernetes.io/*` 与 `helm.sh/chart`（parity 允许的新增差异）。

---

## 3. 必填项（空值不报错，装完才暴露）

| values 路径 | 站点键 | 留空的后果 |
| --- | --- | --- |
| `middleware.database.password` | `DSH_PG_PASSWORD` | 连不上 PG，宿主反复重启 |
| `dependencies.dshPublicBaseUrl` | 派生于 `SITE_HOST` + `NP_TENANT` | 下载链接是空的，取不到文件，但不报错 |
| `config.cephRgwEndpoint` | `CEPH_RGW_ENDPOINT` | 上传与签名下载全部失败 |

`validation.failOnMissing=true` 把这张表变成渲染期硬失败（生产流水线建议开），其余情况由 `templates/NOTES.txt` 在装完后点名。

---

## 4. Secret 清单

| Secret | 键 | 谁创建 |
| --- | --- | --- |
| `dsh-tenant-secret`（`envFrom` 整份注入） | `DSH_TENANT_OIDC_SECRET` `NEWAPI_API_KEY` `DSH_OBJECT_ACCESS_KEY` `DSH_OBJECT_SECRET_KEY` | `up.sh` / 部署机。chart 默认 `secrets.tenant.create=false` |
| `dsh-llm-secret`（只取一个 key） | `DEEPSEEK_API_KEY` | 同上。`secrets.llm.create=false` |
| `dsh-tenant-config` | `tenant.config.yaml` | **chart 自己建**（`secrets.tenantConfig.create=true`），因为正文来自本仓 `files/` |

`DSH_TENANT_OIDC_SECRET` 缺失不会启动失败，表现为第一次管理面调用返回 `INVALID_TOKEN` —— 这条最容易漏。

租户配置正文里的 `mcpServers` 段要填真 token，而 token 只能来自配置文件（`applyEnvOverrides` 不覆盖它）。所以：**生产环境置 `secrets.tenantConfig.create=false`**，否则每次 `helm upgrade` 都会把 Secret 里的真 token 按仓库里的占位内容覆盖掉。

---

## 5. chart 默认不自建、但缺了跑不起来的东西

| 依赖 | 缺了的表现 |
| --- | --- |
| PostgreSQL `dsh-pg:5432`（同命名空间） | 宿主 `CrashLoopBackOff`，日志里是连接拒绝。置 `middleware.database.provision.create=true` 可由 chart 自建（含 PVC `dsh-pgdata`），需同时给 `middleware.database.password` 或 `provision.existingSecret` |
| ConfigMap `dsh-mcp-client-patch`（键 `index.js`） | Pod 卡在 `ContainerCreating`：`references non-existent config key`。它由 `up.sh` 在 `MCP_CLIENT_PATCH_SRC` 非空时建；没有 `up.sh` 时用 `--set config.mcpClientPatch.create=true --set-file config.mcpClientPatch.indexJs=...` 让 chart 建 |
| 工作区目录树 | 宿主能 Running，但沙箱第一次跑工具才失败。`dsh-workspace` 里需要有 `.dsh/system`、`.dsh/pyenv`（Python 解释器与依赖，沙箱镜像里没有）、`.dsh/tools`、`.dsh/users`、`.dsh/tenants`、`.dsh/archive` |
| 沙箱镜像 `dsh-tool-exec:<tag>` | 沙箱 Pod `ImagePullBackOff`（k8s 会回退 Docker Hub，部署网络通常拉不到） |
| Ceph RGW 桶 `dsh-public` 已开放匿名只读 | 上传成功但浏览器打不开下载链接 |
| RWX StorageClass | PVC `Pending` |

---

## 6. 与原清单的差异

### 6.1 补齐的欠债（parity 记为 `improve`，20 条）

| 对象 | 补了什么 | 为什么 |
| --- | --- | --- |
| Deployment | `resources` 真值（requests 200m/512Mi，limits.memory 2Gi） | 原值是 `resources: {}`，等于 BestEffort，节点压力下第一批被驱逐；沙箱与宿主同节点，驱逐会连带打断会话 |
| Deployment | `containers[].securityContext`（`allowPrivilegeEscalation: false`、`privileged: false`、`readOnlyRootFilesystem: false`、`capabilities.drop: [ALL]`） | 原值是空 pod 级 `securityContext: {}`；不写等于默认更宽 |
| Deployment | `podSecurityContext.seccompProfile: RuntimeDefault` | 同上 |
| Deployment | `startupProbe`（10s × 30 ≈ 300s） | 原清单靠 liveness 的 `initialDelaySeconds: 60` 兜冷启动，即第 60 秒就判死；RWX 首次挂载慢时会被反复杀 |
| PVC | `helm.sh/resource-policy: keep` | 里面是案件数据，`helm uninstall` 不该回收 |
| 全部对象 | `app.kubernetes.io/*` + `helm.sh/chart` 标签 | `helm-standard.md` §4 要求，历史清单没落地 |

`limits.cpu` 刻意不配：CPU 是压缩型资源，设上限只会让运行时被限流（GC 停顿被放大），而且 130/171 的节点 allocatable 只有 4 核，加 cpu limits 会变成调度门槛。

### 6.2 删除的导出残留

`creationTimestamp: null`、`terminationMessagePath`/`terminationMessagePolicy`、Pod 模板上的 `kubectl.kubernetes.io/restartedAt` 注解。

### 6.3 照抄的缺陷（**不要当成设计**）

`config.tenantConfig.volumeKind` 默认 `configMap`，而 chart 建的租户配置对象是 **Secret**，两者同名 `dsh-tenant-config`。

这是原清单的真实不一致：`manifests/secret-tenant-config.yaml` 建的 Secret 从来没被挂载过，卷一直指向 130 上一份历史 ConfigMap。为了双轨一致默认值照抄这个缺陷；**新环境必须 `--set config.tenantConfig.volumeKind=secret`**。

`config.tenantConfig.volumeKind` 没有做成「默认 secret、parity 时覆盖」是因为站点值注入只认 `helm-site-map.txt` 里声明过的键，改默认值会直接让 parity 失败。

---

## 7. DNS：`ndots` 必须是 `"1"`

```yaml
dnsConfig:
  enabled: true
  ndots: "1"     # 字符串，不是数字
```

这是 2026-11-16 修掉的线上问题，不是调优：集群默认 `options: ndots:5` 时，`jeecg-boot-mcp-server.jeecg.svc.cluster.local` 只有 4 个点，每次解析都要先拼 4 个 search 域撞 NXDOMAIN 才回退，实测单次 6 秒（并发 12 时最长 31 秒），表现为「**提问转圈没有回复**」，日志里没有任何错误。改成 `"1"` 后降到 1–2 毫秒。

`dnsConfig.enabled=false` 等于把这个 bug 装回去，只用于临时对比排查。

---

## 8. 其余关键取值

| 项 | 取值 | 原因 |
| --- | --- | --- |
| `strategy.type` | `Recreate` | 单副本宿主不允许新旧并存（新宿主会收掉旧的沙箱）；且节点 requests 已接近打满，`maxSurge` 会卡 Pending |
| `replicaCount.host` | 只允许 `1`（schema `maximum: 1`） | 多副本会互相删对方正在用的沙箱 Pod |
| `service.tenant.type` | `ClusterIP` | `render.sh` 在 `ClusterIP` 时会整段删掉 `nodePort:`，所以两个站点的基线 Service 都没有 nodePort。要开 NodePort：`--set service.tenant.type=NodePort`（`nodePort` 只在 NodePort 下渲染） |
| `probes.readiness/liveness` | 10s/10s、60s/30s，`failureThreshold: 3` | 与原清单逐字一致，parity 会比对 |
| `podSecurityContext` | 只加 `seccompProfile` | 刻意不设 `runAsUser`/`runAsNonRoot`/`fsGroup`：镜像以什么用户跑、PVC 目录归谁，本仓没有声明，猜一个值会让容器起不来或写不进 `/opt/dsh` |
| `readOnlyRootFilesystem` | `false` | 宿主会往镜像内的临时目录写 sqlite 与缓存 |
| `middleware.database.host` | `dsh-pg` | 同命名空间短名可用；跨命名空间请写全 FQDN |

`/opt/dsh` 这类宿主根路径在模板和 `files/tenant-config.yaml` 里都是字面量：它是镜像与 PVC 布局共同定死的，不是站点变量。改一边必须改另一边（Deployment 的 `volumeMounts[dsh].mountPath` 与租户配置的四条 `*Root`）。

---

## 9. 站点值注入键（`helm-site-map.txt` 里与本 chart 相关的行）

| 站点键 | values 路径 |
| --- | --- |
| `NS_DSH` | `namespace` |
| `NP_TENANT` | `service.tenant.nodePort` |
| `SC_RWX` | `persistence.workspace.storageClass` |
| `SIZE_DSH_WS` | `persistence.workspace.size` |
| `PVC_DSH_WS` | `persistence.workspace.name` |
| `REPLICAS_TENANT` | `replicaCount.host` |
| `DSH_PG_USER` / `DSH_PG_PASSWORD` / `DSH_PG_DB` | `middleware.database.user` / `.password` / `.name` |
| `CEPH_RGW_ENDPOINT` | `config.cephRgwEndpoint` |
| `SVC_TENANT_TYPE` | `service.tenant.type` |
| `SECRET_LLM` / `SECRET_TENANT` / `SECRET_TENANT_CONFIG` | `secrets.llm.existingSecret` / `secrets.tenant.existingSecret` / `secrets.tenantConfig.existingSecret` |
| `CM_MCP_PATCH` | `config.mcpClientPatchConfigMap` |
| `SA_DSH` | `serviceAccount.name` |
| `SITE_HOST` | `site.host` |
| `TAG` | `image.tag` |
| `RELEASE_VERSION` | `releaseVersion` |

**已知映射缺口**（本次未改 `helm-site-map.txt`，避免与并行改其它仓的会话冲突）：

* 两个站点的 `machines/*.env` 写的是 `TENANT_SVC_TYPE=NodePort`，而映射行认的是 `SVC_TENANT_TYPE` —— 键名不一致，所以 `service.tenant.type` 从来没被注入过，实际一直是 `ClusterIP`。要么把站点 env 改成 `SVC_TENANT_TYPE`，要么补一行 `TENANT_SVC_TYPE | service.tenant.type | deepseek-harness`。
* 建议补：`IMG_TENANT | image.tenant`、`IMG_TOOL_EXEC | image.toolExec`、`SVC_DSH_PG | middleware.database.host`、`DSH_PUBLIC_BASE_URL | dependencies.dshPublicBaseUrl`（后者目前靠派生的 `SITE_HOST` + `NP_TENANT` 覆盖，能对上，但站点若用域名对外就不够）。

---

## 10. 升级、回滚、卸载

* `helm upgrade` 会重渲染租户配置正文。`secrets.tenantConfig.create=true` 时**会覆盖集群里 Secret 的真 token**；生产置 `false`。
* PVC 带 `helm.sh/resource-policy: keep`：`helm uninstall` 不删 `dsh-workspace`，要删请手动 `kubectl delete pvc`。
* `Recreate` 策略下升级有秒级不可用窗口（宿主重启期间正在跑的沙箱会被收掉）。
* `values.schema.json` 关掉了主要分组的 `additionalProperties`，拼错的 `--set` 会在渲染期报错，不会静默变成空值。

---

## 11. 文件布局

```
Chart.yaml               # parity-with 注解指向 docker/k8s/manifests
values.yaml              # 每个键都有可用默认值
values.schema.json       # 严格模式，抓 --set 拼写错误
files/tenant-config.yaml # 租户配置正文（156 行，原 Secret 的 stringData 逐字节搬来，值改成 values 引用）
templates/
  _helpers.tpl                    # 名称、标签、镜像、租户配置正文、必填项清单
  deployment-tenant-host.yaml
  service-tenant.yaml
  pvc-tenant-workspace.yaml
  rbac.yaml                       # ServiceAccount + Role + RoleBinding
  secret-tenant-config.yaml       # 租户配置正文（默认渲染，parity 需要）
  secret-credentials.yaml         # 可选：create=true 时建 dsh-llm-secret / dsh-tenant-secret
  configmap-mcp-client-patch.yaml # 可选：create=true 时建补丁 ConfigMap
  NOTES.txt
```

`files/tenant-config.yaml` 里 20 处站点/机器相关的值改成了 values 引用；正文与基线逐字节一致（parity 会比对 Secret 的 `stringData` 全文，改一个空格都会报 fail）。
