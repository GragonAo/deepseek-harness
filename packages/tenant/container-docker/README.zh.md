# @deepseek-ai/dsh-container-docker

[English](README.md) | 中文

[`dsh-container`](../container) 接缝的本地 Docker/Podman provider。它按 (租户, 用户) 拉起一个 *tool-exec* 服务容器，通过 HTTP 往该容器在宿主机回环上发布的端口发请求来运行命令（ip+host），并挂载三层数据：案件的共享目录以读写挂到 `/shared`、该用户在该案件的工作目录以读写挂到 `/workspace`、该用户跨案件的全局目录以读写挂到 `/global`（配置了 `usersRoot` 时），工具以只读挂到 `/tools`。容器在该用户第一次工具调用时懒式拉起——按用户的容器在启动时没有用户可供预热——名字稳定且按 (租户, 用户) 分区。不同租户、同一租户的不同用户始终落在不同容器，进程与文件系统从不共享内核上下文；容器自身文件系统在回收时丢弃——租户或用户的持久状态只有它的挂载。

## 配置

```yaml
- name: '@deepseek-ai/dsh-container-docker'
  config:
    runtime: 'docker'               # or 'podman'
    network: 'bridge'               # used unless the tenant sets network: 'none'
    toolExecImage: 'dsh-tool-exec:latest'  # in-container /exec server image
    toolExecPort: 8642              # container port that server binds
    usersRoot: '/root/.dsh/users'   # host root of per-subject /global dirs; omit to skip /global
    # idleTimeoutMs: 300000         # optional: reap a container this long after its last exec
```

## 容器模型

当用户在某个 (租户, 用户) 作用域内第一次工具调用时，provider 为该作用域启动一个 tool-exec 容器。它先清除同名容器（`docker rm -f`，不存在时是 no-op——非优雅关机因此不会遗留孤儿容器），再以稳定、按 (租户, 用户) 分区的名字 detached 拉起 tool-exec 镜像：

```
docker rm -f dsh-<tenantPartition>-<userPartition>
docker run -d --name dsh-<tenantPartition>-<userPartition> \
  --network <network|none> -p 127.0.0.1::<toolExecPort> \
  -v <workspaceRoot>/users/<sub>:/workspace \
  -v <workspaceRoot>/shared:/shared \
  [-v <usersRoot>/<sub>:/global] [-v <toolsRoot>:/tools:ro] \
  <toolExecImage>
```

随后读取已发布宿主机端口（`docker port`），等待容器的 `/exec` 服务应答（设上限，从而没有 exec 会与容器内 Node 绑定端口的时序竞争），再把每次 exec POST 到 `http://127.0.0.1:<port>/exec`——agent 端从不执行 `docker exec`。同一作用域并发首次调用会并入那次进行中的启动，所以每个 (租户, 用户) 每进程最多付一次冷启动。运行镜像来自 `toolExecImage`；租户记录本身不携带镜像。设置 `idleTimeoutMs` 时，空闲容器会被 `docker rm -f` 回收，下次 exec 再懒式重启。

tool-exec 镜像把零依赖的 `/exec` 服务（`src/tool-exec.ts`）打包到 Debian-slim + Node 上，从而保住文件系统适配器 `stat`/`find`/`base64`/`test`/`command -v` 的 coreutils 语义。在仓库根目录构建：

```sh
docker build -f packages/tenant/container-docker/docker/Dockerfile \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t dsh-tool-exec:latest .
```

## 模型体验

### 租户与用户作用域容器执行

#### 模型看到什么

无。`ctx.containerRuntime` 服务于模型下方的文件系统与子进程适配器：不含工具、提示词或会话事件。

#### Token 效应

每次请求零直接 token。

#### KV 缓存效应

与活跃请求无关：该包从不触及请求前缀。

## 已知局限与后续工作

- **每个 Docker 宿主每 (租户, 用户) 一个容器。** 稳定名字把每个主体钉在单个具名容器上，因此同一宿主上两个相继启动的 `dsh` 进程会互相驱逐或重建同名容器（第二个 `rm -f` 停掉第一个的，再起自己的）；容器无状态，所以这只退化为一次重新预热，但要在流量中途交接的共享宿主多副本部署应改用「收养或创建」而非「清除再启动」。
- **`internal` 网络由部署方负责。** 租户要在无公网的情况下出网，依赖部署方创建的内网；该 provider 只是跳过 `none` 并用自己的配置名。
- **无镜像拉取策略。** 容器启动后会等待其 `/exec` 服务就绪，但拉取本身由部署方负责；部署方应预先拉取 tool-exec 镜像，或用 `run` 时即可解析的镜像。
