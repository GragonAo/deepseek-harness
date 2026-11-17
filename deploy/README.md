# deepseek-harness 部署

DSH 租户宿主（tenant-host + tool-exec 沙箱）的平台部署单元。

## 快速部署

```bash
# 1. 准备取值文件
cp deploy/values/site.example.yaml deploy/values/site-130.yaml
# 填 namespace / middleware.database.* / persistence.workspace.* / tenantConfig.model.*

# 2. 预演，不碰集群
helm template deepseek-harness ./deploy/helm/deepseek-harness -n dsh \
  -f deploy/values/site-130.yaml

# 3. 部署，密钥走命令行
helm upgrade --install deepseek-harness ./deploy/helm/deepseek-harness -n dsh \
  -f deploy/values/site-130.yaml \
  --set config.tenantConfig.volumeKind=secret \
  --set secrets.llm.data.DEEPSEEK_API_KEY=<值> \
  --timeout 10m

# 4. 验证
kubectl -n dsh rollout status deploy/dsh-tenant-host --timeout=300s
curl -s http://<站点IP>:30788/openapi.json | head -c 200
```

## 必填值

| 值 | 说明 | 填错会怎样 |
|---|---|---|
| `config.tenantConfig.volumeKind` | **必须是 `secret`** | 默认 `configMap` 会把密钥写进 ConfigMap |
| `persistence.workspace.accessMode` | 必须 `ReadWriteMany` | 用 RWO 存储类会挂载失败 |
| `persistence.workspace.storageClass` | 必须支持 RWX，例 `rook-cephfs` | PVC 一直 Pending |
| `middleware.database.host` | 已存在的 PostgreSQL | 启动报 Connection refused |
| `tenantConfig.model.baseUrl` | 集群内可访问 | 对话时 502 |
| `replicaCount.host` | 必须 `1` | 会话状态分裂，工具执行找不到上下文 |

## 前置条件

```bash
kubectl -n dsh get secret dsh-llm-secret
kubectl get sc                     # 需要有支持 ReadWriteMany 的存储类
kubectl -n dsh get pvc             # dsh-workspace 能否绑定
```

## 常用操作

```bash
helm list -n dsh
helm history deepseek-harness -n dsh
helm rollback deepseek-harness -n dsh
helm uninstall deepseek-harness -n dsh     # 工作区 PVC 保留
```

## 改 chart 后

```bash
helm lint ./deploy/helm/deepseek-harness --strict
helm template oo ./deploy/helm/deepseek-harness -n dsh
helm show values ./deploy/helm/deepseek-harness
```

## 说明

本 chart 目前**没有 CI 校验**（`.github/workflows/` 下无 helm 任务），改模板后请手动跑上面三条命令。
