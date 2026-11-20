# deepseek-harness Helm chart

DSH 多租户宿主的部署单元：一个 `Deployment`（`dsh-tenant` 宿主进程）、一个 `Service`、一块工作区 `PVC`、沙箱所需的 `ServiceAccount/Role/RoleBinding`，以及租户配置的 `Secret`。工具不在宿主进程里执行，而在宿主按会话创建的 `dsh-tool-exec` 沙箱 Pod 里执行。

## 渲染出的对象

`kind` / 名字 / 命名空间全部由 `values.names.*` 写死，不跟随 release 名：

| kind | name | 说明 |
| --- | --- | --- |
| Deployment | `dsh-tenant-host` | 租户宿主，`replicas` 只允许 1 |
| Service | `dsh-tenant` | 默认 `ClusterIP:8788`，被 jeecg 后端按固定 DNS 引用 |
| PersistentVolumeClaim | `dsh-workspace` | RWX 工作区（30Gi），宿主与沙箱 Pod 共用 |
| PersistentVolumeClaim | `shared-assets` | 只引用不创建：长期共享资产卷，承载 Python 运行时与系统层（字体、技能、库） |
| ServiceAccount / Role / RoleBinding | `dsh-host` | 沙箱 Pod 的 create/delete + `pods/exec` |
| Secret | `dsh-tenant-config` | 租户配置正文，键 `tenant.config.yaml` |

资源名不随 release 名变化（`values.names.*` 是固定值）：`dsh-tenant` 的 DNS 名写在 `hermes-jeecg-ai` 的 values 里，`dsh-tenant-host` 是 Service 的 selector 值，而 `Deployment.spec.selector` 不可变，所以改名前先确认没有按名字引用的调用方。

## 前置依赖

| 依赖 | 要求 |
| --- | --- |
| 命名空间 | `namespace` 值，默认 `dsh`；宿主与沙箱 Pod 同命名空间（Role 是命名空间级的，不能跨 ns） |
| PostgreSQL | `middleware.database.*` 指向的库先可用；`provision.create=true` 时才由 chart 建 `dsh-pg` + PVC `dsh-pgdata` |
| 工作区 PVC | `persistence.workspace.enabled=true` 时由 chart 建，需要支持 `ReadWriteMany` 的 StorageClass（默认 `rook-cephfs`）；`keepOnDelete=true` 保证卸载不回收数据。chart 只建 PVC 不建目录，里面要有 `.dsh/tools`、`.dsh/users`、`.dsh/tenants`、`.dsh/archive` |
| 资产 PVC | `persistence.assets.enabled=true`（默认）时，`persistence.assets.name` 那块 RWX PVC 必须先存在：它由中间件发布建，其 `dsh/system`、`dsh/pyenv` 两个 `subPath` 下要已有系统层与 Python 运行时。置 false 则二者退回工作区 claim，删租户时会一起丢 |
| Secret `dsh-llm-secret` | 键 `DEEPSEEK_API_KEY`；chart 只在 `secrets.llm.create=true` 时创建 |
| Secret `dsh-tenant-secret` | 整份 `envFrom` 注入，键见下文「Secret 清单」；chart 只在 `secrets.tenant.create=true` 时创建 |
| 镜像 tag | `image.tag`，形如 `ai-icac-dsh-v1.0.23`；留空回退 `Chart.appVersion`。宿主镜像 `dsh-tenant`，沙箱镜像 `dsh-tool-exec`（后者写进租户配置，不在 Deployment 里）；`image.tenantTag` 只覆盖宿主镜像的 tag，用于「只改了宿主代码」的发布 |

## 安装

```bash
# 预演
helm template deepseek-harness ./deploy/helm/deepseek-harness -n dsh

# 装（密钥与密码走命令行）
helm upgrade --install deepseek-harness ./deploy/helm/deepseek-harness -n dsh \
  --create-namespace \
  --set image.tag=ai-icac-dsh-v1.0.23 \
  --set config.tenantConfig.volumeKind=secret \
  --set middleware.database.password='<PG 密码>' \
  --set dependencies.dshPublicBaseUrl=http://<站点地址>:<端口> \
  --timeout 10m
```

`dependencies.dshPublicBaseUrl` 的端口取决于 `service.tenant.type`：`ClusterIP` 时填对外转发（Ingress / 站点反代）的那个口，`NodePort` 时就是 `service.tenant.nodePort`（默认 30788）。

`dsh-llm-secret`、`dsh-tenant-secret` 默认由部署机在集群里维护；集群里没有时加 `--set secrets.llm.create=true --set secrets.tenant.create=true` 让 chart 建，赋值走 `--set secrets.llm.data.DEEPSEEK_API_KEY=…`（`secrets.*.data` 为空时 chart 不建）。

站点差异（IP、存储类、模型通道、镜像 tag）用一份 `-f` 的站点值文件表达，样例见 `deploy/values/site.example.yaml`。不带任何 `-f` / `--set` 也能 `helm template` 与 `helm lint` 通过。

`middleware.database.password`、`dependencies.dshPublicBaseUrl`、`config.cephRgwEndpoint` 为空不会让渲染失败，只会在运行到那条路径时暴露。置 `validation.failOnMissing=true` 改成渲染期硬失败，生产流水线建议开。

## 租户配置来源

租户配置正文是 chart 内的 `files/tenant-config.yaml`：`tpl` 渲染后落进 Secret `dsh-tenant-config` 的 `tenant.config.yaml` 键，再以单文件挂到容器 `/etc/dsh/tenant.config.yaml`（镜像 CMD 读这个路径）。配置不来自 Nacos 或其它外部配置中心。

正文里随站点/机器变化的值都写成了 values 引用（监听端口、数据库连接串、沙箱命名空间与镜像、沙箱资源预算、对象存储端点、公开地址、模型通道）；`/opt/dsh/*` 这类宿主根是镜像与 PVC 布局定死的字面量，改一边必须改 Deployment 的 `volumeMounts[dsh].mountPath`。

`mcpServers` 段要填真 token，而 token 只能来自配置文件（`applyEnvOverrides` 不覆盖它）。生产请置 `secrets.tenantConfig.create=false`，由部署机维护这份 Secret；否则每次 `helm upgrade` 都会把仓库里的占位内容盖上去。

## Secret 清单

| Secret | 键 | 谁创建 |
| --- | --- | --- |
| `dsh-tenant-secret` | `DSH_TENANT_OIDC_SECRET`、`NEWAPI_API_KEY`、`DSH_OBJECT_ACCESS_KEY`、`DSH_OBJECT_SECRET_KEY` | 集群或 `secrets.tenant.create=true` |
| `dsh-llm-secret` | `DEEPSEEK_API_KEY` | 集群或 `secrets.llm.create=true` |
| `dsh-tenant-config` | `tenant.config.yaml` | 本 chart（`secrets.tenantConfig.create=true`，默认开） |

`DSH_TENANT_OIDC_SECRET` 缺失表现为第一次管理面调用 `INVALID_TOKEN`；`NEWAPI_API_KEY` 是租户配置里 `apiKeyEnv` 指向的变量。

## 已知缺陷：租户配置卷的默认 kind

`config.tenantConfig.volumeKind` 默认是 `configMap`，而 chart 自建的租户配置对象是 Secret `dsh-tenant-config`：同名不同 kind，卷会指向一份不存在的 ConfigMap，Pod 卡在 `ContainerCreating`。默认值保留是为了不改动已有站点的挂载方式；**新环境必须 `--set config.tenantConfig.volumeKind=secret`**。

## 关键取值

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `replicaCount.host` | `1` | schema 上限 1：多副本会互相删对方正在用的沙箱 Pod |
| `strategy.type` | `Recreate` | 单副本宿主不允许新旧并存，升级有秒级不可用窗口 |
| `service.tenant.type` | `ClusterIP` | 要浏览器直连改 `NodePort`；`nodePort` 只在 NodePort 下渲染 |
| `dnsConfig.ndots` | `"1"` | 必须保留：集群默认 `5` 时短名解析 6–31 秒，表现为「提问转圈不回复」且日志无错误 |
| `persistence.workspace.accessMode` | `ReadWriteMany` | 宿主与沙箱 Pod 同时挂，不支持 RWO |
| `persistence.assets.*` | `shared-assets` / `dsh/system` / `dsh/pyenv` | 资产卷名与卷内两条 `subPath`；置 `enabled=false` 则运行时与系统层退回工作区 claim |
| `sandbox.*` | 6Gi / 15min / 3min / 10min | 沙箱内存上界、空闲回收、启动超时、单次工具超时 |

## 升级、回滚

```bash
helm upgrade deepseek-harness ./deploy/helm/deepseek-harness -n dsh --reuse-values
helm rollback deepseek-harness -n dsh [修订号]     # 修订号见 helm history
```

## 排查

```bash
kubectl -n dsh rollout status deploy/dsh-tenant-host --timeout=300s
kubectl -n dsh logs -f deploy/dsh-tenant-host
kubectl -n dsh get pod -o wide
kubectl -n dsh get endpoints dsh-pg
kubectl -n dsh describe pod -l app=dsh-tenant-host
```

## 文件布局

```
Chart.yaml               # chart 元数据，appVersion 是默认镜像 tag
values.yaml              # 每个键都有可用默认值
values.schema.json       # 严格模式，抓 --set 拼写错误
files/tenant-config.yaml # 租户配置正文（values 引用处已占位）
templates/
  _helpers.tpl                    # 名称、标签、镜像、租户配置正文、必填项清单
  deployment-tenant-host.yaml / service-tenant.yaml / pvc-tenant-workspace.yaml / rbac.yaml
  secret-tenant-config.yaml       # 租户配置正文（默认渲染）
  secret-credentials.yaml         # 可选：create=true 时建 dsh-llm-secret / dsh-tenant-secret
  configmap-mcp-client-patch.yaml # 可选：create=true 时建补丁 ConfigMap
  NOTES.txt
```

本 chart 没有 CI 校验，改模板后手动跑 `helm lint ./deploy/helm/deepseek-harness --strict` 与 `helm template`。
