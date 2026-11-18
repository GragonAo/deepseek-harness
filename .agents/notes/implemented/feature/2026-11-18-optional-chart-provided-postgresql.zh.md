# Agent Note: 可选的 chart 自带 PostgreSQL

Status: implemented

[English](2026-11-18-optional-chart-provided-postgresql.md) | 中文

## Problem

chart 里 PostgreSQL 只是几行连接坐标：`middleware.database` 只有 `host`、`port`、`name`、`user`、`password`，而 [README §5](../../../deploy/helm/deepseek-harness/README.md) 明确写着 PostgreSQL 不由本 chart 创建。于是在没有数据库的集群上安装本 chart，必须先跑一套没有记录的流程；这套流程没跑完之前，宿主一直停在 `CrashLoopBackOff` 里报连接被拒。

这个缺口正好废掉了 chart 本该提供的交付单位。把 chart 目录和 `dsh-tenant-host` 镜像拷过去并不足以完成安装，因为每次安装都需要的那个依赖仍然来自别处。当初用来创建 `dsh-pg` 的原始清单同样不在 Helm 的管辖内：没有升级路径，没有 `app.kubernetes.io/*` 标签，也没有任何记录说明这些对象归哪个 release 所有。

## Decision

`middleware.database.provision` 负责开通，与继续留在 `middleware.database` 里的连接坐标并列。连接与开通拆成两组，是因为运维可以只接一个已有数据库而不把它纳入管理，也可以新建一个而不改变宿主连它的方式。

`provision.create` 默认 `false`，保持已发布的行为：chart 只连，不渲染别的东西。置 `true` 时渲染 `templates/pg.yaml`，它声明三个对象：

- Deployment `dsh-pg`，使用 `strategy: Recreate`，因为数据卷是 `ReadWriteOnce`，不能在 Pod 之间漂移。
- PersistentVolumeClaim `dsh-pgdata`，带 `helm.sh/resource-policy: keep` 注解，使 `helm uninstall` 不会连数据一起删掉。
- Service `dsh-pg`，端口取 `middleware.database.port`。

资源名是写死的，不从 release 名派生。租户配置通过 `middleware.database.host` 解析这个 Service，而该值的默认就是字面量 `dsh-pg`；派生名会让默认连接串直接指错。

密码取 `middleware.database.password`，站点已自备 Secret 时取 `provision.existingSecret`。两者都没有而 `create=true`，渲染期由 `required` 直接失败，因此 chart 装不出一套空密码的数据库。其余随部署而变的选项是 `provision.image`、`.storage`、`.storageClass`、`.resources`；`values.schema.json` 用 `additionalProperties: false` 声明该组，写错键名是校验错误，而不是被静默忽略的设置。

开通范围不含应用配置。chart 只管进程、镜像、端口、磁盘和资源。应用读取的每一项设置都归 Nacos 所有 —— 自从删掉 `application-docker.yml` 之后，Nacos 是唯一的配置来源。

## Verification

`helm lint` 在本 chart 上通过。默认取值不渲染任何 `dsh-pg` 对象，这一点靠搜索渲染产物里的三个资源名确认。

`--set middleware.database.provision.create=true --set middleware.database.password=…` 恰好渲染三个对象，且 `kubectl create --dry-run=server` 在 130 集群（Kubernetes v1.28.2）上全部接受。

只传 `--set middleware.database.provision.create=true` 而不给密码时，渲染失败并报 `middleware.database.password 必填（或改用 provision.existingSecret）`。

## Alternatives considered

**恒建，去掉开关。** 无条件声明 `dsh-pg` 与 `dsh-pgdata` 的 chart 最贴合常见的单仓交付，还能少掉一个要写两遍的模式。它输在：130 上已经有一个用同样名字、由外部创建、带了 48 天数据的 `dsh-pg`，无条件安装要么在纳管时撞上冲突，要么改写一个生产数据库的生命周期；而所有自行管理 PostgreSQL 的运维将完全无法安装本 chart。

**Bitnami 风格的 PostgreSQL 子 chart。** 用 `dependencies:` 引一个维护中的 chart，可以把镜像锁定、探针和升级顺序交给上游，省下的维护量不止三个对象的代价。它输在两点：多一个 chart 仓库作为安装前提；它的 values 命名空间会和站点已在 `middleware.database` 里设的坐标重复，于是一个连接要在两处配置。

**留着原始清单、把流程写进文档。** 这是本仓库此前的做法。它输在：清单无法随 release 升级，没有归属记录，而且数据库名与密码会多出一个存放位置。

**用 release 名命名这些对象。** 派生名可以让两个 release 在同一命名空间共存。它输在：`middleware.database.host` 默认是字面量 `dsh-pg`，租户配置把这个值写进了连接串；派生的 Service 名会静默破坏默认接线。

## Consequences

全新安装时 chart 是自足的：一次 `--set` 就把 PostgreSQL 纳入 release，连同原始清单缺失的 PVC、Service 与归属标签一起。

代价是多了一个需要持续保证正确的模式。凡是在 Helm 之外管理 PostgreSQL 的站点，`provision.create` 必须保持 `false`，而同一个数据库不允许两种模式混用：要把已有的 `dsh-pg` 纳入一个 values 已置 `create: true` 的 release，需要 `helm upgrade --take-ownership`，并且存储类与容量要和已绑定的盘一致。

`helm uninstall` 按设计会留下 `dsh-pgdata`。清除某个站点的数据是一次显式的 `kubectl delete pvc` —— 这是 chart 有意做不到的运维动作。
