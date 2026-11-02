# 租户宿主的 k8s 清单

本仓的 k8s 资产都在 `docker/k8s/` 下。**新形态**是 `manifests/` + `vars.env` + `render.sh`：

| 文件 | 作用 |
|---|---|
| `manifests/deploy-tenant-host.yaml` | 租户宿主 Deployment（挂工作区 PVC + `tenant.config.yaml`） |
| `manifests/svc-tenant.yaml` | Service；`SVC_TENANT_TYPE=NodePort` 时渲染带 `nodePort: __NP_TENANT__`，`ClusterIP` 时自动删掉该行 |
| `manifests/secret-tenant-config.yaml` | `tenant.config.yaml` 的 Secret（内容含 MCP 请求头与 OIDC 占位，所以用 Secret） |
| `manifests/pvc-dsh-workspace.yaml` | 30Gi **RWX** 工作区卷：宿主与沙箱 Pod 必须挂同一份 |
| `manifests/rbac.yaml` | `dsh-host` ServiceAccount / Role / RoleBinding（沙箱 Pod 的创建与 exec） |
| `vars.env`、`render.sh` | 本仓默认值与渲染器（渲染器与 `deploy-kit/gitops/render.sh` 逐字节一致） |

```bash
SITE_DIR=<deploy-kit>/machines ./render.sh --site 171 --diff
SITE_DIR=<deploy-kit>/machines ./render.sh --site 171 --apply
<deploy-kit>/scripts/up.sh 171 --only tenant      # 由 deploy-kit 统一编排
```

## 与旧文件的关系

同目录的 `tenant-host.yaml`、`tenant-rbac.yaml`、`pg.yaml` 是**首装参考**，含大量现场注释
（记录 130/171 的差异、沙箱挂载为什么必须是同一份存储等），保留作历史与对账：

* `tenant-host.yaml` —— 旧形态：把 `tenant.config.yaml` 当 Secret 建，但 Deployment 里是
  `secretName: dsh-tenant-config`；171 现役实际挂的是 **ConfigMap**，接管时会统一成 Secret。
* `tenant-rbac.yaml` —— Role 刻意不给 secrets/configmaps 权限（130 现役的 Role 给多了）。
* `pg.yaml` —— postgres 属于平台层既有设施，本栈不自建；文件留着记录连接串与存量。

前置条件（`up.sh` 会建或检查）：命名空间 `dsh`、`dsh-workspace`（RWX）、
Secret `dsh-llm-secret`/`dsh-tenant-secret`、ConfigMap `dsh-mcp-client-patch`。
