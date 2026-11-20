# deepseek-harness 部署

DSH 租户宿主（`dsh-tenant` 进程 + 按会话起的 `dsh-tool-exec` 沙箱）在 Kubernetes 上的部署单元。生产只走 Helm：

```
deploy/helm/deepseek-harness/   chart（唯一部署来源）
deploy/values/site.example.yaml 站点取值样例
```

## 前置依赖

| 依赖 | 要求 |
| --- | --- |
| 命名空间 | `dsh`（`namespace` 值，沙箱 Pod 也落在这里，Role 是命名空间级的） |
| PostgreSQL | 同命名空间可达，默认 `dsh-pg:5432`，库/用户 `dsh`；或置 `middleware.database.provision.create=true` 由 chart 建 `dsh-pg` + PVC `dsh-pgdata` |
| 工作区 PVC | 必须支持 `ReadWriteMany`（默认存储类 `rook-cephfs`，30Gi）；PVC 里的目录树不随 chart 创建：`.dsh/tools`、`.dsh/users`、`.dsh/tenants`、`.dsh/archive` |
| 资产 PVC | `persistence.assets.name`（默认 `shared-assets`，由中间件发布建在 `dsh` 命名空间）整块**只读**挂在 `persistence.assets.mountPath`（默认 `/opt/assets`）：卷里放 Python 运行时、系统层与字体（参考布局 `pyenv/`、`system/`、`fonts/`）。卷内布局由程序配置（`files/tenant-config.yaml` 的 `pythonRoot` / `systemRoot`）解释，chart 不切子目录。唯一可写例外是宿主的 `<mountPath>/system/skills`——平台启用系统技战法时往那里装技能。置 `persistence.assets.enabled=false` 则运行时与系统层退回工作区 PVC |
| Secret `dsh-llm-secret` | 键 `DEEPSEEK_API_KEY`（chart 不建，置 `secrets.llm.create=true` 时才建） |
| Secret `dsh-tenant-secret` | 键 `DSH_TENANT_OIDC_SECRET`、`NEWAPI_API_KEY`、`DSH_OBJECT_ACCESS_KEY`、`DSH_OBJECT_SECRET_KEY`（整份 `envFrom` 注入） |
| 镜像 tag | `image.tag`，形如 `ai-icac-dsh-v1.0.23`；留空回退 `Chart.appVersion` |
| 对象存储 | `config.cephRgwEndpoint`，桶 `dsh-public` 需开放匿名只读 |

## 安装

```bash
cp deploy/values/site.example.yaml deploy/values/site-130.yaml   # 填 namespace / 数据库 / 存储类 / 模型通道

# 预演，不碰集群
helm template deepseek-harness ./deploy/helm/deepseek-harness -n dsh \
  -f deploy/values/site-130.yaml

# 部署；密钥与密码走命令行，不写进值文件
helm upgrade --install deepseek-harness ./deploy/helm/deepseek-harness -n dsh \
  --create-namespace \
  -f deploy/values/site-130.yaml \
  --set config.tenantConfig.volumeKind=secret \
  --set middleware.database.password='<PG 密码>' \
  --timeout 10m
```

`--set config.tenantConfig.volumeKind=secret` 不是可选项：默认值 `configMap` 会让宿主的配置卷指向一份 ConfigMap，而 chart 建的租户配置是 Secret（同名 `dsh-tenant-config`），新环境照默认值挂不上。

`dsh-llm-secret`、`dsh-tenant-secret` 由部署机在集群里维护。集群里还没有时，加 `--set secrets.llm.create=true --set secrets.tenant.create=true` 让 chart 建，赋值走 `--set secrets.llm.data.DEEPSEEK_API_KEY=…` 这类形式（`secrets.*.data` 为空时 chart 不建这两个 Secret）。

## 必填 values

| values 路径 | 说明 | 填错的表现 |
| --- | --- | --- |
| `middleware.database.password` | PG 密码，或改指 `provision.existingSecret` | 连不上库，宿主反复重启 |
| `dependencies.dshPublicBaseUrl` | 浏览器可达的宿主地址 | 下载链接为空，取不到文件但不报错 |
| `config.cephRgwEndpoint` | 对象存储端点 | 上传与签名下载全部失败 |
| `persistence.workspace.storageClass` | 必须支持 RWX | PVC 一直 `Pending` |
| `replicaCount.host` | `1`（schema 上限 1） | 多副本互相删对方在用的沙箱 Pod |
| `tenantConfig.model.baseUrl` / `.id` | 集群内可达的模型通道 | 对话时 502 或 `model-unavailable` |

置 `validation.failOnMissing=true` 可把空值变成渲染期失败（生产流水线建议开）；默认不满时由 `helm upgrade` 结束打印的 NOTES 点名。

## 租户配置来源

租户配置正文（`http`、`database`、`sandbox`、`model`、`tools`、`files` 等）来自 chart 内的 `deploy/helm/deepseek-harness/files/tenant-config.yaml`，经 `tpl` 渲染后用 `values` 里的值替换端口、连接串、命名空间、镜像、模型通道等站点相关项，落进 Secret `dsh-tenant-config` 的 `tenant.config.yaml` 键，再以单文件挂到容器的 `/etc/dsh/tenant.config.yaml`（镜像 CMD 读的就是这个路径）。配置不来自 Nacos 或其它外部配置中心。

正文里的 `mcpServers` 段要填真 token，而 token 只能来自配置文件（`applyEnvOverrides` 不覆盖它）。生产请置 `secrets.tenantConfig.create=false`，由部署机维护这份 Secret，否则每次 `helm upgrade` 都会用仓库里的占位内容覆盖真 token。

## 升级、回滚、卸载

```bash
helm upgrade deepseek-harness ./deploy/helm/deepseek-harness -n dsh -f deploy/values/site-130.yaml
helm history deepseek-harness -n dsh
helm rollback deepseek-harness -n dsh [修订号]
helm uninstall deepseek-harness -n dsh        # 工作区 PVC 保留，需手动 kubectl delete pvc
```

密码与密钥用 `--set` 传的不写进值文件，升级时要重传一次。升级策略是 `Recreate`，单副本，升级期间有秒级不可用窗口（宿主重启时正在跑的沙箱会被收掉）。

## 排查

```bash
kubectl -n dsh rollout status deploy/dsh-tenant-host --timeout=300s
kubectl -n dsh logs -f deploy/dsh-tenant-host
kubectl -n dsh get pod -o wide
kubectl -n dsh get endpoints dsh-pg                  # 连库失败时先看这条
kubectl -n dsh describe pod -l app=dsh-tenant-host   # ContainerCreating 时看挂载与 Secret/ConfigMap
curl -s http://<站点IP>:30788/openapi.json | head -c 200   # Service 为 NodePort 时
```

- Pod 卡 `ContainerCreating` 且报 `references non-existent config key`：租户配置卷的 kind 与对象对不上（见上面 `volumeKind`），或 `config.mcpClientPatch.mount=true` 但 ConfigMap 缺 `index.js`。
- 沙箱 Pod 起不来：看 `kubectl -n dsh get events`，以及资产卷 `shared-assets` 根下的 `pyenv/` 是否齐全（沙箱镜像不含 Python；`assetsClaim` 指的名字与宿主挂的 PVC 不一致时，表现为目录空而不是报错）。
- 「提问转圈没有回复」且日志无错误：`dnsConfig.ndots` 必须是字符串 `"1"`，回落集群默认的 `5` 会让短名解析慢到 6–31 秒。

## 改 chart 之后

```bash
helm lint ./deploy/helm/deepseek-harness --strict
helm template deepseek-harness ./deploy/helm/deepseek-harness -n dsh
helm show values ./deploy/helm/deepseek-harness
```

本 chart 没有 CI 校验（`.github/workflows/` 下没有 helm 任务），改模板后请手动跑上面三条命令。模板、对象名、探针取值等细节见 `deploy/helm/deepseek-harness/README.md`。
