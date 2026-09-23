# Agent Note: 沙箱只读挂载系统 skill 树

Status: implemented

[English](2026-09-22-sandbox-system-skill-mount.md) | 中文

## 问题

skill 分三层：案件共享（`<workspaceRoot>/shared/skills`）> 用户全局（`<usersRoot>/<sub>/skills`）> 系统（`$DSH_HOME/system/skills`）。沙箱容器只挂了三个目录：

```
<workspaceRoot>/users/<sub>  ->  /workspace
<workspaceRoot>/shared       ->  /shared
<usersRoot>/<sub>            ->  /global
```

前两层的目录**恰好**落在挂载点内，所以它们的配套文件在沙箱里可读。系统层不在任何挂载点内：skill 正文经宿主侧 provider 注入模型上下文（大文件还会 spill 到沙箱 `/tmp/dsh-spill-*`），正文里引用的配套文件（报告模板、方法论、校验脚本、范例 HTML）在沙箱里**读不到**。

重资产 skill 会在正文里按**相对 skill 目录**的路径引用这些文件，并要求执行其中的脚本。实测一个 55 KB 的线索初核 skill：agent 加载正文后按指令找 `report_template.md`，只能 `find / -name` 满世界搜索，找不到，收口阶段的 `verify_delivery.py` 也无法执行。

## 决策

`container-docker` 新增 `systemRoot` 配置项，把系统 skill 树**以同一绝对路径**只读挂进沙箱：

```
-v <systemRoot>:<systemRoot>:ro
```

同路径而非固定的容器内位置，因为 skill 正文引用的相对路径要相对**宿主解析出的那个目录**成立；挂到别处会让每一条引用失效。只读，因为沙箱只执行、不拥有系统资产。省略该配置时行为不变：系统 skill 树留在宿主侧，只有正文能到达模型。

case 层与用户层不需要对应配置：`/shared` 和 `/global` 本来就是它们的挂载点。

## 考虑过的替代方案

- **固定的容器内位置**（例如 `/system/skills`）：否决。skill 正文里每一条配套文件引用都相对 skill 目录，因此挂载点必须是 provider 解析出的那个宿主路径。
- **把该树读写挂载**：否决。沙箱只执行系统资产、并不拥有它们，可写的共享树会让一个主体的写入改变其他每一个主体读到的东西。
- **不做成配置项、始终挂载**：否决。宿主路径随部署而变，没有把 `$DSH_HOME` 挂在同一绝对路径上的部署会在每个沙箱里挂进一个空目录，而不是看到一次明确的失败。

## 后果

- 部署侧要保证宿主容器把 `$DSH_HOME` 挂在与容器内**相同**的绝对路径上，否则宿主交给 docker 的路径在真实宿主上不存在，docker 会建空目录挂进去。`docker-compose.yml` 与 `.env.example` 已按此约束写死绝对路径。
- 沙箱多一个只读挂载点；`/opt/.dsh/system` 下的内容因此对沙箱内进程可见（本就无凭据，系统 skill 是共享资产）。
