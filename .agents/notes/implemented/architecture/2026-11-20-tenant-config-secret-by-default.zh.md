# Agent Note: 租户配置正文是部署机自己的 Secret

Status: implemented

[English](2026-11-20-tenant-config-secret-by-default.md) | 中文

## Problem

chart 用 `config.tenantConfig.volumeKind` 决定把租户配置正文挂进 `/etc/dsh/tenant.config.yaml`，而这个键默认是 `configMap` —— 那是本 chart 出现之前就存在的 ConfigMap 的 kind。chart 自己为同一份正文创建的对象却是 Secret：只要部署没显式改这个键，卷就指着一份没人创建的 ConfigMap，Pod 根本起不来，`MountVolume.SetUp failed for volume "config" : configmap "dsh-tenant-config" not found`。渲染照样成功，所以直到真在集群里跑才暴露；130 上线 v1.0.30 撞上的就是这一条。

正文还有第二个独立的失败方式。生产不能把正文交给 chart —— `mcpServers` 每一条都要真实 token，而 `applyEnvOverrides` 从不提供它，chart 自己持有的正文会在每次升级时被仓库占位内容覆盖。所以部署机自己留一份，而那份就冻结在它被创建时的版本上。v1.0.30 新增了一段必填配置（`plugins.tool-skill-publish.config.record`），从 v1.0.24 带过来的正文装载时报 `配置有误` / `invalid config: $.record missing required value (at record)` —— 一个看起来像挂载或凭据问题的结构不匹配。

## Decision

`config.tenantConfig.volumeKind` 默认改成 `secret`：chart 建的正文对象是 Secret，部署机自建的那份也是 Secret，默认值因此与全新安装真正拿到的东西一致。正文确实放在 ConfigMap 里的站点显式置 `configMap`（schema 仍然接受）。

生产把正文留在 chart 之外：`secrets.tenantConfig.create: false` 加上 `secrets.tenantConfig.existingSecret` 指向部署机维护的那份 Secret（130 上是 `dsh-tenant-config-live`）。helm 既不创建也不更新它。

正文从此在 chart 之外演进，所以 chart 的 README 写的是合并口径而不是整份替换：用 `create=true` **并且**带上 `middleware.database.password` 渲染出本版本的正文，保留新结构，凡是新正文留成占位或空值的地方，取上一版正文的值。漏掉口令会渲染出 `postgres://dsh:@dsh-pg:5432/dsh`，并在更晚一步报 `SASL: client password must be a string` —— 又一个属于取值、不属于挂载的失败。

## Alternatives considered

- **保留 `configMap` 默认值，让所有站点都 `--set`。** 这是此前 README 的口径。否决：不匹配在渲染期看不出问题，只在集群里失败，于是每个新环境都得记住一个开关，而它缺失时报的是「找不到某个对象」而不是「你少了这个开关」。
- **把 `volumeKind` 做成没有默认值的必填键。** schema 本来就要求这个键，但 helm 校验的是合并后的取值，chart 自己的默认值总能满足它；「必填且无默认」在这里表达不出来。否决，等于没做。
- **正文继续归 chart 所有，用取值把真 token 传进去。** 否决：token 会搬进站点 values 文件，而正文照样每次升级整份替换，把部署机手工改对的内容全丢掉。

## Consequences

- 新部署不再需要为卷 kind 传 `--set`；正文在 ConfigMap 里的站点必须明说。
- 一旦某个版本新增了必填正文，部署机必须自己合并正文 —— chart 做不到，失败形态是启动即拒并指名缺哪个键。
- 真实 token 只留在跑集群的机器上，仓库里只有占位。

## References

- [chart README：租户配置来源](../../../../deploy/helm/deepseek-harness/README.md)
- [整块资产卷挂载](2026-11-20-whole-claim-asset-mount.md) —— 本 chart 另一处从 claim 而非从 chart 挂进来的卷