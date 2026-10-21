# Agent Note: 租户单一根目录与目录清单

Status: implemented

[English](2026-10-13-single-tenant-root-and-directory-list.md) | 中文

## 问题

租户在宿主上的目录被写在三处、彼此可能不一致：两个容器 provider 各自按配置根拼挂载表，`tenant-admin` 按自己那份清单建目录，而部署文档又告诉运维手工建哪些子目录。只有一个地方知道的路径会**静默失败**——容器运行时拿到一个不存在的绑定挂载源时，会建成空目录而不是拒绝：本部署的 system 技能层就是这样挂成了空层，没有任何东西报告它。另外有两棵树落在部署的数据根之外（`/opt/dsh/tenants`、`/opt/dsh/tools`），所以"只挂一个根"并不成立。

## 决定

宿主路径只在 `@deepseek-ai/dsh-tenant` 里声明一次：

- `tenantDirectories(input)` 返回一个租户及其成员在宿主上需要的每一个目录——父目录先于子目录、重复项折叠。`tenant-admin` 建的正是这份清单：开通租户时（`bootstrapTenantDirs`）、`users.ensure` 时、以及启动时记录仓挂载后（`hydrate`），因此没有运维需要手工建任何子目录。
- `TENANT_TIER_DIRS` 与 `TENANT_SHARED_DIR_NAME` / `TENANT_USERS_DIR_NAME` / `TENANT_SKILL_DIR_NAME` 携带目录名，两个容器 provider 都用这些名字拼挂载源，因此改名不会让一方仍挂旧路径。
- `tenant-admin` 持有 `systemRoot` 与 `pythonRoot`，由 `tenant-app` 组合时从 sandbox 小节接入，因此部署级的根并入同一份清单，而不依赖运维或镜像里的 `RUN mkdir`。

沙箱的聚合根 `/opt/data/skills` 在 k8s provider 里是一个**容器本地挂载**（`kind: 'local'`），紧插在第一个挂在它下面的层之前。落在只读来源（`/shared`、`/global`）内部的 Pod 卷挂载点在挂载装配阶段建不出来，所以各层的挂载点需要一个 Pod 自己提供的可写父目录；`docker -v` 会自己创建缺失的目标，因此 docker provider 没有对应的一条。

每一个部署根都保持为配置：代码不为 `dataRoot`、`workspaceRoot`、`usersRoot`、`archiveRoot`、`toolsRoot`、`systemRoot`、`pythonRoot` 硬编码任何默认值。

## 考虑过的替代方案

- **让每个 provider 各自维护挂载表。** 否决：两张表按意图是同一份清单，而它们与 `tenant-admin` 清单之间的每一次漂移都是上面那个静默空层故障。
- **由部署方建目录。** 否决：它把每个新层变成手工步骤，而这里失败的部署恰恰是没人执行它的那些——而租户面的目录本来就归租户面管。
- **要求运维预建共享根。** 同理否决：这些根就是配置，读配置的那一面就该建它命名的东西。
- **把 `/opt/data/skills` 从宿主挂。** 否决：它要在 claim 下多一个来源而没有换来任何东西，各层本来就已单独投影。
- **为启动建目录引入插件的 `start()` 生命周期。** 否决：`packages/*/src` 下没有任何 `Service` 子类用它，而记录仓的出现本来就是水合所等待的那条顺序契约。

## 后果

- 建目录与挂载现在派生自同一个函数：一个路径要进挂载表，必须先进清单，并由 `packages/tenant/tenant/tests/layout.spec.ts` 钉住名字。
- `tenant-admin` 现在也创建 `toolsRoot` 与 `archiveRoot`，它旧那份清单漏了这两个。
- 启动建目录跑在水合里，而插件没有暴露可等待的就绪点，所以测试目前无法确定性地断言水合后的状态。
- 部署仍需把 `workspaceRoot` 与 `DSH_TENANT_WORKSPACE_ROOT` 指到单一 `.dsh` 根之下：这两个值是必填配置，不是默认值。

## 相关

同样的三层技能在宿主那一侧的供给见 [2026-10-13](../../implemented/bug-fix/2026-10-13-tenant-app-skill-tier-wiring.md)：它记录了这份记录所消除的那份耦合——容器挂载与宿主扫描现在通过同一个目录名与同一份创建清单来命名 `<systemRoot>/skills`，而不再是两处必须保持同步的配置。