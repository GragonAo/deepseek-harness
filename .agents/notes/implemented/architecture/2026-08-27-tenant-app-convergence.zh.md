# Agent Note：租户应用是唯一启动入口，执行层由配置驱动

Status: implemented

[English](2026-08-27-tenant-app-convergence.md) | 中文

## 问题

租户栈此前是借 DeepSeek Harness 自己的组合面搭起来的：`packages/bundle/multi-tenant` 是一层由 `dsh --profile multi-tenant` 选中的补丁层，因此启动一个租户等于启动 harness CLI，并随之继承它的 bundle、profile 与 cordis.yml 机制。租户部署需要变化的一切——沙箱镜像、命名空间、宿主根目录——只能通过那份 bundle 传递，等于把租户的部署策略放进了单租户产品面所拥有的文件里。两个执行后端也在分叉：`container-k8s` 把 schema 声明在模块层，而对默认导出的类插件 cordis 只读静态成员上的 `Config`，所以它的 `Config` 从未被校验；租户组合随后又传入了 `toolTimeoutMs`、`kubeconfig`、`memoryLimit`、`cpuLimit` 这些 provider 并未声明的名字，schemastery 静默丢弃它们，于是部署方可能配置出一个默默忽略了自己一半指令的沙箱。

## 决定

**租户栈是一个独立应用，不是一个 harness profile。** `packages/tenant/tenant-app` 自己拥有 bin、类型化配置（`src/config.ts`）、插件清单（`src/spine.ts`）与手写组合（`src/compose.ts`）；它以普通工作区依赖的身份消费 dsh 核心层包，不使用 Loader、cordis.yml、bundle 或 profile。`packages/bundle/multi-tenant` 与 `multi-tenant` profile 模板被删除，仅作演示的 `api-http`、`tenant-demo` 两个包一并删除。

**部署面按同一条线拆开。** `docker/build-images.sh` 构建本栈运行的两个镜像 —— 按 (租户,用户) 的沙箱 `dsh-tool-exec`（来自 `packages/tenant/container-docker/docker/Dockerfile`）与宿主 `dsh-tenant`（来自 `Dockerfile.tenant`）—— 两个形态各自保留自己的装配：`docker/docker-compose.tenant.yml` 配 `docker/tenant.config.example.yaml` 是本地开发形态（docker 沙箱后端，用宿主网络是因为沙箱的执行端口发布在宿主 loopback 上，各根目录在容器内外按同一路径挂载），`docker/k8s/tenant-host.yaml` 是生产形态（k8s 沙箱后端，ConfigMap、Deployment、Service）。profile 时代的部署文件 —— `Dockerfile.multi-tenant`、`docker/entrypoint.multi-tenant.sh`、`docker/docker-compose.multi-tenant.yml` —— 已删除：它们以补丁层启动 harness CLI 并在每次启动重放部署补丁，而租户 bin 从不做这些。两个镜像都按固定顺序从干净检出构建，因为 Host 工程图会到达那些 `/remote` 导入要等 Host tsdown 之后才存在的 Client 工程：先用 tsc 发射 `lib/types`（这一轮把这些导入报成未解析，它不是门），再跑生成 Typert 约定的 Host tsdown，然后两个 face 各自重跑 tsc 作为门，最后跑 Client tsdown 出那些只有这一轮才产出的运行时入口（`typert-registry`、Client 插件）。

**插件清单是一张表，模块名是封闭集合。** `src/spine.ts` 有 103 行 `{ id, module, config?, disabled? }`；`src/deps.ts` 以 const 元组导出 `SPINE_MODULES`，`SpineRow.module` 取其元素类型，因此模块名写错是编译错误，而不是运行到那一行才失败。每一行都可在租户配置里按 id 覆盖（`plugins.<id>.enabled` / `.config`），且所有模块都按名装载，被禁用的行不产生任何代价。

**一个模块只有一个归属：清单或静态挂载，不能两处都是。** 配置来自具名小节的几块（HTTP 服务、会话存储、租户注册表、认证、管理面、两个 HTTP 载体、PostgreSQL 会话持久化、容器子进程与文件系统、容器运行时）由 `src/compose.ts` 带类型化配置直接挂载，不再作为清单行出现——cordis 拒绝同一个服务的第二次注册。挂载结束后由 `assertMountedServices` 核对一份必在服务清单（HTTP 宿主、会话存储、租户准入与管理、业务面网关与其 `/api` 载体、目录选择）：cordis 会跳过注入没被满足的插件，少一个提供者就会静默地整块少一个面，而进程照常启动。

**目录选择器只留浏览式后端。** 服务端挂 `host-directory-picker-browse`，自适应的 `host-directory-picker-auto` 保持停用：容器里没有原生选择器，业务客户端通过 API 浏览目录。

**一套容器接口、两个 provider、一份配置面。** `container-docker`（本地开发）与 `container-k8s`（生产）满足同一个运行时接口，`tenant-app` 只向各 provider 传它自己声明的字段：k8s 后端要求 claim、宿主根目录与 Python 环境描述（`workspaceClaim`、`claimRoot`、`systemRoot`、`pythonRoot`、`toolsRoot`、`pythonEnv`），而只属于 docker 的资源上限或只属于 k8s 的字段会被配置读取器带着具名诊断拒绝，而不是被丢弃。`container-k8s` 声明 `static Config`，其 schema 因此真正被 cordis 校验。

## 考虑过的其他方案

- **保留 bundle，在其之上加一个 bin。** 否决：租户部署仍要通过单租户产品的 profile 机制配置，租户专有的设置（命名空间、claim、按租户的根目录）就得放在 harness 产品同样拥有并会演进的文件里。
- **让 k8s provider 接受 docker 的字段名并忽略自己用不到的字段。** 否决：静默忽略一个已配置的值正是本次改动要消除的失败模式；配置读取器要指出具体是哪个键，provider 自己的 schema 才是权威。
- **把 `api-http` 与 `tenant-demo` 留作租户面的说明。** 否决：管理面与业务面 HTTP 载体及其测试已经演示了这一面，第二套演示装配只会与真实启动路径漂移。

## 后果

**收益：** 启动一个租户只需一条命令、来自一个拥有自身配置的包；沙箱后端是同一份配置里表达的部署选择，所选后端无法兑现的值会在启动时以具名的键失败。k8s schema 被真正校验；`tenant-app` 自己的组合测试把整张清单的每一行都禁用后挂载，并断言业务路由返回 404，因此缺失载体是失败即关的默认行为，而不是一扇敞开的门。

**代价与后续工作：** 清单表需要手工与组合保持一致——新增一个核心插件意味着加一行并补一条 `SPINE_MODULES`，而不是从 bundle 里被发现。构造时读一次可选提供者的模块就是顺序敏感的，尽管组合本身不表达行序：`tenant-admin` 原先在构造时读一次 `tenantRecordStore`，于是晚挂载的 store 让在线注册表停在空表，重启后已持久化的租户不见了；现在水合在服务 key 出现时执行。k8s 后端要求 Python 环境描述，尽管 provider 视其为可选，因为本包所服务的部署形态里租户栈的 Python 层不是可选项。`packages/workflow/workflow-container/src/transport.ts` 里一处非相对 `.ts` 子路径导入，为了任何按源码编译核心层的消费者改成了从包根导入。

**验证：** `pnpm exec vitest run packages/tenant` → 26 个文件 / 265 条测试通过；`pnpm exec tsc -b packages/tenant/{tenant-app,container-k8s}/tsconfig.json` → 退出码 0。Kubernetes 部署（命名空间 `dsh`，PostgreSQL 与 tool-exec 镜像都是独立工作负载）上的实测跑通了整条路径：没有 Loader、profile 或 bundle 也能启动服务；`POST /admin/tenants.create` 写入租户，Pod 重启后 `tenants.get` 仍能取回；`POST /api/session.create` 与 `session.prompt` 跑完一个回合并让 `bash` 工具在按配置镜像创建的按租户沙箱 Pod 里执行，会话日志落在 PostgreSQL。正式镜像走的是同一条路径：从 `Dockerfile.tenant` 构建、用 `ctr -n k8s.io images import` 导入、以 `dsh-tenant:latest` 滚动上线后，服务从构建产物 `packages/tenant/tenant-app/lib/bin.js` 启动（不经 tsx、不走源码启动），并端到端跑完同一个回合，`dsh-tenant` Service 也能在集群内到达接口。
