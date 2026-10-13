# Agent Note: 沙箱里的技能层是挂载进来的，不是软链

Status: implemented

[English](2026-10-08-sandbox-skill-tiers-are-mounts.md) | 中文

## 问题

案件技能是按 `/opt/data/skills/<skill>/...` 寻址的：案件自己的脚本写在沙箱出现之前的那套宿主布局上，而它们调用的报告构建器就是按这个绝对路径写死的。tool-exec 镜像用 `ln -s /shared/skills /opt/data/skills` 满足了这个拼写。可这条别名照样把挂载位置写死在镜像里（紧挨着它的解释器包装脚本是另一回事），所以它没消除任何耦合；而且它只能指向一个来源，那个路径上因此永远只可能有 case 一层，而宿主侧的注册表是通过 `skill-tier` 的排序根把三层（case、user-global、system）合并起来的。

## 决策

技能只以挂载形式进沙箱。每一层都只读挂到同一个根下：`/opt/data/skills/<kind>`，`<kind>` 沿用 `skill-tier` 已经注册的那几个——`case` 来自 `<workspaceRoot>/shared/skills`、`user-global` 来自 `<usersRoot>/<subject>/skills`、`system` 来自 `<systemRoot>/skills`。沙箱侧的发现方式就是遍历这个根，而某一层的目录只在它对应的配置根存在时出现，遍历天然容忍这一点。镜像只建目录（`mkdir -p /opt/data/skills`），别的一概不做：容器内不再有任何一个路径去命名挂载进来的路径，所以也不会再出现悬空或过期。同一棵树既按宿主路径挂、又挂进聚合根，不额外占卷，因为 `volumesFor` 是按后端存储给卷取键的。

## 备选方案

- **保留软链，指向一个由宿主组装的合并目录。** 否决：那等于让宿主为它已经在提供的数据再写一份视图并保持同步，以后每加一层都要在两个地方各加一次。
- **把各层平铺挂进根目录，保留 `/opt/data/skills/<skill>`。** 否决：一次挂载只能把一个来源放到一个位置，多层落同一个路径根本做不到，而同名技能会在无声中被覆盖。
- **让案件资产改用宿主绝对路径（`<workspaceRoot>/shared/skills/...`）。** 否决：那些资产不在本仓库里、已按案件部署，而聚合根给了它们一个切后端也不变的稳定拼写。
- **在预置阶段把各层硬链或拷贝进一个目录。** 否决：那是每次技能变更都要重建的状态，而且硬链跨不过本 provider 挂载的宿主路径/claim 边界。

## 后果

- 技能在沙箱里的路径变成 `/opt/data/skills/<kind>/<skill>/...`，不再是 `/opt/data/skills/<skill>/...`。按遍历寻址的调用方不受影响；写死平铺形式的调用方得跟着层走。
- 沙箱启动前三个层目录必须存在：`<workspaceRoot>/shared/skills`（建租户时由 `dsh-tenant-admin` 创建）、`<usersRoot>/<subject>/skills`、`<systemRoot>/skills`（后两个来自部署自己的根）。`container-docker` 会把路径写进错误里直接失败；claim 部署会把缺失的 `subPath` 建成空目录，于是失败发生在更晚的地方。
- 聚合根里每一层都是只读的。沙箱写不了技能；共享层在 `/shared` 仍可写。
- 宿主侧的层合并没变：`skill-tier` 照旧读它那三个宿主根并排序（[供应记录](2026-08-26-multi-tenant-skill-tier-supply.md)），沙箱里的聚合根不是那次合并。
- `/opt/hermes/.venv/bin/python3` 仍是包装脚本。它的理由是镜像里没有解释器，不是别名：它交给自己 `PATH` 上的 `python3`，没挂环境时以 `python3: not found` 失败，而不是跑去执行别的解释器。

### 验证

- `packages/tenant/container-k8s/tests/pod-spec.spec.ts` 断言了那三条聚合挂载、它们的只读属性、必须原样往返的层仍然原样往返，以及同一棵树挂两次仍只占一个卷。
- `packages/tenant/container-docker/tests/docker.spec.ts` 断言了同一张表的对应 `-v` 条目，两个后端因此不会各自漂移。
- `pnpm exec tsc -b tsconfig.host.json` 无输出；两个 provider 的测试通过（86 条里过 83 条，那 3 条是需要 `sh` 的既有 Windows 用例）。
- 集群上，用重建后的镜像起的一个探针 Pod 报告：`/opt/data/skills` 是目录、解释器包装是普通文件、`NO-PYTHON`，且 `find /opt /shared -type l` 为空——镜像里不再有任何路径去命名挂载点。
- 在已部署的租户栈上跑了一轮真会话（`trial-tenant`/`trial-user`，claim 模式）：它创建的沙箱 Pod，`volumeMounts` 里除了各层原有的宿主路径，还有 `/opt/data/skills/{case,user-global,system}`，init 容器挂的是同一张表。这个沙箱——无论是直接 `exec` 进去看，还是看模型自己那次以 `completed` 结束的 `bash` 工具调用——都把 `/opt/data/skills` 列为目录、里面是三个已挂载的层，且 `find /opt/data -maxdepth 3 -type l` 为空。
