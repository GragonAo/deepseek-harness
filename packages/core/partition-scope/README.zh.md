# dsh-partition-scope

[English](README.md) | 中文

环境请求分区 seam。`RequestPartition` 是一次操作所充当的身份：租户、当部署按用户隔离时的已认证主体、两者的存储安全标识形式，以及该分区状态所处的部署私有根目录。分区化部署把 `PartitionScope` 挂到 `ctx.partitionScope`，由 `currentPartition(ctx)` 读取；`isPartitionlessFailure(error)` 用于识别分区化后端对「在任何分区之外运行的操作」的拒绝。不挂任何 provider 的部署即单分区部署。

## 公开 API

- `RequestPartition` 环境分区记录。`tenant` 与 `user` 是部署注册的原始 id，`tenantName`/`userName` 是它们的存储安全形式，`dataRoot` 是持有该分区的设置、凭据与技能的部署私有根目录。`user` 与 `userName` 恰好只在部署按用户隔离时出现。名字由 provider 派生，所以消费方永远不需要派生规则——只需要它据以寻址 schema、守卫键或容器名的那个形式。
- `PartitionScope.current(): RequestPartition | undefined` provider 接口，作为可选服务 `ctx.partitionScope` 承载。只有分区化部署会注册它，且一个部署至多承载一个。
- `currentPartition(ctx): RequestPartition | undefined` 环境分区，经 `ctx.get` 读取（可选服务惯用法的严格存储读取），而非拓扑敏感的属性代理，因此缺如的 provider 解析为 `undefined` 而不是一个待决服务。`undefined` 表示单分区部署，或已挂 provider 但没有环境请求分区。
- `isPartitionlessFailure(error): boolean` 某个失败是否为分区化后端对「在任何请求分区之外运行的操作」的拒绝（代码 `NO_TENANT_IN_SCOPE`）。必须容忍无分区情形的消费方——启动时急切初始化、尚无请求作用域的注册表——检查这个断言，而不是后端的错误类。

## 设计契约

这个 seam 的存在，是为了让「需要分区状态的消费方」依赖 seam 而不是某个多租户实现：`dsh-storage-domain`、`dsh-workspace`、`dsh-settings`、`dsh-settings-file`、`dsh-credentials-local` 都在这里读取环境分区，且不 import 任何多租户包。环境权威与分区名派生归 provider 所有，因此移除多租户实现即一并移除分区化，每个消费方都退回自己的单分区路径。

分区化后端会拒绝它无法归位的操作——不存在可供它服务的分区元组——并以 `isPartitionlessFailure` 所匹配的代码报告该拒绝。

## 已知限制与后续工作

- **一次请求一个分区** —— 该服务只承载一个环境分区，嵌套不属于它；必须在一次请求中寻址两个分区的消费方在此没有 seam 可用。
- **`@deepseek-ai/dsh-host-apiproxy` 尚未迁移** —— 它的租户管理 RPC 面仍为租户记录类型、默认管理作用域与错误映射 import `@deepseek-ai/dsh-tenant`，因为该包的 RPC 方法表是静态接口，而不是贡献点。
- **无分区代码是共享字符串。** `isPartitionlessFailure` 只匹配每个分区化后端都会抛出的那一个代码；另造代码的后端不会被识别，而类型系统对此没有任何约束。
