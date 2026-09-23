# Agent Note: 沙箱绑定挂载源在启动容器之前先被创建与校验

Status: implemented

[English](2026-09-23-sandbox-mount-source-preflight.md) | 中文

## 问题

通过管理端 API 建出来的租户，其沙箱启动后 `/workspace` 是空的。`container-docker` 会拼出六条 `docker run -v <source>:<target>` 参数，其中两个源在整个代码树里**没有任何创建者**：`<workspaceRoot>/users/<subject>`（挂到 `/workspace`）与 `<workspaceRoot>/shared/skills`（以自身宿主路径只读挂载）。`bootstrapTenantDirs` 只建 `dataRoot` 与 `<workspaceRoot>/shared`，`bootstrapUserDirs` 只建 `usersRoot` 那一层。provider 把每个源原样交给容器 CLI，不做任何检查，而 Docker 会把不存在的绑定挂载源**建成空目录**，于是任何一个环节都不会失败。

部署机实测：03:04 通过 API 建出的租户，其 `<workspaceRoot>/users/<sub>` 与 `<workspaceRoot>/shared/skills` 的 mtime 是 03:05——那是第一次工具调用的时刻，不是创建时刻；而 `tenant-admin` 确实创建的目录 mtime 是 03:04。整个会话一路报成功（`turn/end=completed`，注册 192 个工具），只有 `/workspace` 是空的。

有两条规则覆盖这种状态，而这个缺陷两条都违反了：缺失的指称对象**绝不静默跳过**；配置错误要在**能解析出它的最早一点**响亮失败。这里的指称对象既没有创建者，也没有任何失败点。

## 决策

缺失创建者的两侧各承担修复的一半。

`dsh-tenant-admin` 负责预置所有按租户划分的绑定挂载源。`bootstrapTenantDirs(record)` 用与用户层相同的 `TIER_DIRS` 列表创建案件共享层 `<workspaceRoot>/shared/{config,skills,tools}`，并为每个已准入成员创建 `<workspaceRoot>/users/<subject>`。`bootstrapUserDirs(subject, workspaceRoot?)` 新增可选的第二个参数——租户的 workspace 根：因为 `/global` 层与案件工作区属于不同的所有者，`create` 与 `membersAdd` 传入记录的 `workspaceRoot`，`usersEnsure` 什么都不传——该操作只点名一个主体，没有可据以创建案件工作区的租户。`membersAdd` 在创建任何目录之前先解析记录，因此未知租户不会再为一次失败的准入留下主体的宿主机目录。

`dsh-container-docker` 在触碰容器 CLI 之前先在宿主上校验每一个源。`startContainer` 构造唯一的 `mounts(tenant, user)` 列表，校验与 `-v` 参数都由它渲染，因此不存在「挂了但没校验」的源。`requireMountSources` 用注入的 `HostPathProbe`（`src/python-env.ts` 为 `pythonRoot` 已定义的宿主读取接缝）探测每个源，并在清除同名容器之前抛出，报错中列出每一个缺失的源、它对应的容器内路径，以及它属于哪个 (租户, 成员)：

```text
container-docker: refusing to start the sandbox of tenant 'api-demo' member 'api-user': bind-mount source '/opt/dsh/tenants/api-demo/workspace/users/api-user' (for '/workspace') is missing on this host. Docker creates a missing bind-mount source as an empty directory, so the start would report success and hand that subject an empty mount. Create each path on the host, or drop the configuration that names it: tenant-admin creates '<workspaceRoot>/shared/<tier>' and '<workspaceRoot>/users/<subject>' on tenant create and member add, and the deployment owns 'usersRoot', 'systemRoot', 'pythonRoot', and a tenant's 'toolsRoot'.
```

校验覆盖全部六个源，而不只是原先缺创建者的那两个：`usersRoot`、`systemRoot` 与租户的 `toolsRoot` 同样会到达 `docker run`，而一个 `systemRoot` 挪过位置的部署，否则会在「每一条系统 skill 配套文件所引用的那个路径」上挂进空目录。校验发生在每次冷启动，而不是加载时一次：宿主运行期间被删掉的源会让该主体下一次启动失败——这正是能发现它的最早时刻。

## 考虑过的替代方案

- **由 `container-docker` 自动创建缺失的源**：否决。provider 分不清「这个租户还没被预置」与「运维删掉了这个租户的数据」，而且它会往自己并不拥有的目录里写——租户的 `workspaceRoot` 属于 `dsh-tenant-admin`，`systemRoot`/`pythonRoot` 属于部署。它还会让这种失败变得不可达：目录一旦总是存在，就再没有任何状态能区分「已预置的沙箱」与「挂载从未被预置的沙箱」。创建属于目录的所有者；provider 的职责是拒绝一次它无法兑现的启动。
- **把需要执行的 `mkdir` 写进部署 README**：否决。缺陷的本质就是该指称对象既无创建者又无失败点，写成文档步骤等于部署行为照旧，直到运维自己注意到空目录——正是仓库规则要避免的结果。
- **让 `usersEnsure` 创建所有准入该主体的租户的案件工作区**：否决。`tenant.admin.users.ensure` 只点名一个主体，其作用是 `usersRoot/<sub>/{config,skills,tools}` 目录树；从注册表反推租户集合会让一个操作的效果取决于调用方从未点名的成员关系状态。重新加一次成员已经能修复案件工作区，因为 `membersAdd` 每次调用都会引导目录。
- **在加载阶段而不是启动阶段失败**：对按租户划分的源否决。它们是租户记录与主体的函数，两者在加载时都不存在，因此加载阶段既说不出缺什么，也说不出是谁的。`pythonRoot` 保留自己的加载期校验，因为它是自包含的配置，做得到。
- **只校验原先缺创建者的那两个源**：否决。静默空挂载是绑定挂载的性质，不是这两个路径的性质；对挂载列表做统一的校验，才能阻止后续新增的挂载重新引入这个缺陷。

## 后果

- `usersRoot`、`systemRoot`、`pythonRoot` 或租户的 `toolsRoot` 不存在的部署，现在会在沙箱启动时失败，而不是在那里挂进一个空目录。这些路径都存在的宿主上没有任何变化。
- 本次改动之前由 Docker 建出来的目录仍然是空的，没有任何迁移能把它与「合法为空的 workspace」区分开。案件工作区是那样建出来的主体，保留它已经有的空目录；缺失的目录在重新加一次成员时会重建，而该主体此后写进去的内容不受影响。
- 注入的 `HostPathProbe` 现在有两个使用方——构造时的 `pythonRoot` 布局解析，与启动时的挂载源校验——因此伪造容器 runner 的测试也必须声明宿主上存在哪些目录。
- 每次冷启动按已配置的挂载数量各花一次 `stat`；未通过校验的启动不会产生任何容器 CLI 调用。

## 测试

- `packages/tenant/container-docker/tests/docker.spec.ts` 覆盖：案件工作区源缺失的启动，断言报错带有该路径、其容器内挂载点与 (租户, 成员)，且没有发生任何容器 CLI 调用；一个六个源全缺的宿主，断言一次失败把它们全部列出；以及原有的启动断言——其 probe 现在声明挂载源存在。该文件 29 个测试通过。
- `packages/tenant/tenant-admin/tests/tenant-admin.spec.ts` 覆盖：create 预置 `shared/{config,skills,tools}` 与该成员的案件工作区；`membersAdd` 预置它所准入主体的案件工作区。该文件 11 个测试通过。
- `packages/tenant/tenant-demo/tests/agent-isolation.spec.ts` 与 `http-parity.spec.ts` 显式声明宿主的目录，因为它们伪造了容器 runner。
## 部署机验证

在部署机上（multi-tenant profile：`usersRoot: /opt/dsh/.dsh/users`、`systemRoot: /opt/dsh/.dsh/system`、`pythonRoot: /opt/dsh/.dsh/pyenv`），用本次改动的构建产物覆盖镜像里的两个 `lib/index.js`，并在容器内校验过哈希：

- 把一个成员的案件工作区移走，随后该主体的会话通过 `bash` 工具执行 `ls -la /workspace`。工具结果就是原样的拒绝信息——`container-docker: refusing to start the sandbox of tenant 'api-demo' member 'api-user': bind-mount source '/opt/dsh/tenants/api-demo/workspace/users/api-user' (for '/workspace') is missing on this host.`——没有创建任何沙箱容器，宿主目录也仍然不存在：没有任何东西静默地把它建出来。
- 对该主体执行 `tenant.admin.members.add` 重新建出了该目录（mtime 就是这次调用的时刻），随后的 `ls -la /workspace` 通过一个真正启动的沙箱返回了该目录的真实内容。
- 通过 `tenant.admin.create` 建出的租户，其 `workspace/users/<sub>`、`workspace/shared`、`workspace/shared/{config,skills,tools}` 与 `usersRoot/<sub>` 的 mtime 都是创建那一刻，而不是第一次工具调用的时刻。在该沙箱内，`mount` 列出了全部六个绑定挂载，系统 skill 树有 3 个条目，Python 环境有 `bin/include/lib/share`，`python3 -V` 报 `Python 3.11.16` 且 `sys.prefix` 就在挂载内，而写进 `/workspace` 的文件出现在宿主上那个由程序创建的目录里。
