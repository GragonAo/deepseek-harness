# @deepseek-ai/dsh-tenant-app

租户服务的**唯一启动入口**：一份自有配置加一个手写组合。它把 dsh 的核心层（会话、agent、工具、技能、能力位）与租户栈（租户/用户、认证、管理面、业务面、执行层）聚到同一个 Cordis 上下文上，但**不依赖 dsh 的 bundle、CLI 与 Loader**：没有 `cordis.yml`，没有 profile 补丁，配置格式与组合清单都归这个包自己所有。因此不打包整个 dsh 也能起一个租户服务。

## 启动

```sh
dsh-tenant --config /etc/dsh/tenant.config.yaml
```

也可以只用环境变量给出路径：`DSH_TENANT_CONFIG=/etc/dsh/tenant.config.yaml dsh-tenant`。

按 `SIGINT`/`SIGTERM` 退出时释放整个组合：HTTP 服务、容器沙箱、数据库连接池与全部注册。缺少配置文件时以退出码 `2` 结束，不启动任何东西。

`tenant.config.example.yaml` 是仓库内一份带注释的完整样例，覆盖 docker（本地开发）与 k8s（生产）两种沙箱形态；发布产物受工作区约束只含 `lib/`，所以样例只在仓库中，装包后照下面的小节自己写配置。

## 配置

配置是一个 YAML 或 JSON 文件，加上一组覆盖它的环境变量（`DSH_TENANT_*`）。**任何随部署而变的值都只在配置里**：端口、数据库连接串、认证方式、目录根、沙箱后端与它的镜像/命名空间/生命周期、权限档位、默认模型、MCP 服务器，一个都不在代码里兜底。

| 小节 | 作用 |
| --- | --- |
| `http` | 监听地址与端口（`127.0.0.1` 或 `0.0.0.0`）。 |
| `database` | 承载所有租户分区的 PostgreSQL 连接串。 |
| `auth` | 签发者、`verify`（`jwks` 或 `secret` 二选一）、受众、租户声明名、时钟偏移。 |
| `admin` | 准入管理面的作用域。 |
| `tenants` | 用户全局目录根、归档根，以及新建租户的默认目录与出网策略。 |
| `sandbox` | 沙箱后端：`docker`（本地）或 `k8s`（生产），加两侧共有的分层挂载与生命周期字段。 |
| `permissions` | 文件与命令的权限档位，以及需要确认的动作如何处理。 |
| `model` / `web` / `telemetry` | 默认模型、检索用的 API key 环境变量名、遥测端点。 |
| `surfaces` | 业务面 openapi/console 与管理面 openapi 的开关。 |
| `tools` | 工具呈现方式（`code`/`native`/`both`，默认 `both`）与 `run_code` 子调用的并发上限。 |
| `plugins` | 逐行覆盖组合清单：停用某一行，或追加它的配置。 |
| `mcpServers` | 要接入的 MCP 服务器列表：`serverName`、`transport: streamable-http`、`url`、可选的 `headers`、每条自己的工具调用并发策略与上限、必须串行的工具名单与单次调用超时，以及初次连不上时是否让这一行启动失败。 |

校验在这一层完成：缺必填项、类型不符、同一组里给了互斥的两项、写了不存在的字段名，启动前就抛 `TenantAppConfigError` 并指出是哪个字段。拼错字段名不会静默忽略——静默忽略会让部署以为某项已生效，而实际跑的是默认值。

挂载也按同一条规矩：任何一块已启用的插件加载失败，`createTenantApp` 都启动失败，并在错误里指名那一块（`组合行 <id>（<模块>）启动失败`，或静态挂载的那一块），同时把已经挂上的块释放掉——调用方拿到的是一次拒绝，而不是一个开着监听端口、连着数据库池的半成品。带 `inject` 的插件，它的 `apply` 要等注入被提供之后才执行，那时挂载调用早已返回；组合在挂完所有块之后统一核对这些被推迟的执行，所以那一类的失败同样打挂启动，而不是留下一个有缺口的服务继续对外服务——限制行没挂上、鉴权行没挂上都会话能正常开，正是必须打挂的场景。

## 工具呈现与并发

`tools` 段决定模型看到的工具形态与 `run_code` 的重叠窗口。呈现方式默认 `both`：每个工具的原生 schema 与一份按运行时语言生成的 SDK 类型声明同时交给模型，读一个文件、问一句这类会话照原样调工具，要扇出一批并发调用时模型可以写一段程序用 `Promise.all` 跑。改成 `code`（只留 `run_code` 通道）或 `native`（只给原生 schema）都只是改这一个配置值，不用改装配。

工具数以百计时（一挂 MCP 就是上百个），逐份下发原生 schema 会把系统提示词撑到不可用，压住它的手段是**按案件限制可见工具**：案件目录里的一份 `restriction.yaml` 声明本案件能看到哪些继承来的工具，`allow` 与 `deny` 各是一份全局工具名列表，列表项可以写成末尾带 `*` 的前缀（`mcp__icac-bill__*`），整组保留一条 server 今天报出的全部工具。可见集合是提示词唯一的事实来源，所以 `both` 两种形态会一起变小——原生 schema 段与生成的 SDK 段都由它渲染。清单不进这个配置文件，落在案件自己的目录里，由 `@deepseek-ai/dsh-tools-restriction` 这一行读取，格式与语义见它的 README。

`tools.maxParallelSubCalls` 是 `run_code` 程序里重叠子调用的上限，默认 32：一次按分片/表撒开的数据挖掘扇出用 32 路在 6 个波次里跑完约 180 个工具，而同时在途的 HTTP 请求与结果缓冲停在几十条这个量级。它不改变提示词，只改变重叠窗口，而且只有被工具自身归为并发安全的调用才会重叠；`1` 等于严格串行。

`mcpServers` 是一组 Streamable HTTP 入口：每条给出 `serverName`（决定 `mcp__<serverName>__<原工具名>` 这个前缀）、`transport: streamable-http`、`url`，以及可选的 `headers` 与 `toolConcurrency`。租户面只承载这一支传输：`@deepseek-ai/dsh-mcp-client` 的 `Config` 是 `stdio` / `streamable-http` 的判别联合，租户读取器只接受它真的有的那个取值，`command`/`args`/`env` 这类 stdio 字段在这里是未知字段、响亮失败。`headers` 就是认证：客户端把它作为 `requestInit.headers` 附在每个 MCP 请求上。

每条 MCP 服务器还能带自己的 `toolConcurrency`（字段与 `@deepseek-ai/dsh-mcp-client` 的同名字段同名同义，共十二个键）：`policy` 决定这条服务器的调用凭什么判可否重叠（`annotations` 信它自己声明的注解、`parallel` 一律允许、`exclusive` 一律不许），`maxConcurrentCalls` 是它同时在途的调用上限，`exclusiveTools` 列出必须保持提交顺序的原工具名。**顺序与重发是两件事**：写进 `exclusiveTools` 只保证不与其他调用重叠，重发由 `retryTools` 或工具自己声明的 `readOnlyHint: true` 决定，所以「串行的写工具永不重发」并不成立——不写 `retryTools` 才是「只有只读工具会重发」。剩下八个键回答「这个上限怎么随时间变」与「被拒之后怎么办」：`mode`（默认 `adaptive`，从 `maxConcurrentCalls` 起步、被拒一次就往下学、静默窗口后回升；已量过容量的 server 写 `fixed` 固定住）、`decreaseFactor`、`recoveryStep`、`recoveryQuietMs`、`countTimeouts`、`retryAttempts`（最多 5）、`retryBaseDelayMs`、`retryJitterRatio`。租户栈只按原名转发并校验取值（枚举、正整数、非负整数、0..1 比例、布尔、非空名字数组），更细的边界（`decreaseFactor` 必须严格落在 0 与 1 之间、`retryAttempts` 最多 5、两个定时器的上界）由客户端自己的 resolve 步骤在挂载那一行时判定；整段省略或某个键不写，都由 MCP 客户端补自己的默认值，租户侧不给它兜数。

同一条 server 上还能给出 `toolCallTimeoutMs`（单次调用超时，毫秒）与 `failOnStartupError`，同样只按原名转发、不给默认值：不写就是客户端的 60 秒与 `false`。`false` 值得逐条改成 `true`——那时一次连不上只留一条日志，这一行安静地挂成「这个 server 没有工具」，与「配置错误必须响亮失败」相反；写成 `true` 之后，地址写错、端口不通或对方没起来都会让启动失败，错误里指名是那一行（`组合行 mcp-<序号>-<serverName>`），两份部署示例因此逐条写明。客户端的 `reconnect` 段没有转发：当前没有用到它的场景，不写就用它自己的默认重连策略。

这里的 MCP server 全部按第三方对待：不由我们维护，所以不能指望它们声明 `readOnlyHint` / `idempotentHint`，客户端默认的 `annotations` 策略读不出并发意图。因此部署示例在每条 server 上写明 `policy: parallel`（并发的判断与责任由我们承担），写数据的工具进 `exclusiveTools`（只管顺序，是否允许重发另说），`maxConcurrentCalls` 按分配给。两层上限的关系是「天花板与分配」：每 server 的 `maxConcurrentCalls` 是一道全宿主共用的硬闸（所有会话、所有程序一起走它），全局 `maxParallelSubCalls` 是**按程序**算的天花板；一批入口共用同一个后端进程时（同 host:port、只有路径不同），各条 cap 之和就是打到那个后端的并发，所以天花板设成后端扛得住的总量，再按各组扇出把 cap 分下去。12 条入口的完整示例见 `docker/tenant.config.example.yaml`。

## 组合清单

`src/spine.ts` 是这份组合的全部内容：每行给出 `id`、模块名、由租户配置推导的默认配置，或者不挂载的中文原因。行的 `id` 就是配置里 `plugins.<id>` 的键。

清单里保留了几类停用的行，是为了让“租户栈为什么没有这一块”有据可查：本地沙箱（`sandbox`/`fs-sandbox`/`bash-sandbox`/`pwsh-sandbox`）、单机文件存储（`session-persistence-jsonl`/`storage-json`/`settings`/`credentials`）、worker 线程形态的代码执行（`code-runtime`）、自适应目录选择器（`directory-picker-auto`，服务端固定挂 `directory-picker-browse`）、以及浏览器形态的行（`message-feedback`/`session-projection-cache`/`connection`）。它们在租户服务里分别由容器世界、PostgreSQL 分区与浏览式后端取代。

需要静态类型的几块——HTTP 服务、会话存储、租户注册表、认证、租户管理服务、三个 HTTP 载体（管理面、业务面 `/api`、文件面 `/files`）、PostgreSQL 会话持久化、容器子进程与文件系统、以及按后端选择的容器运行时——在 `src/compose.ts` 里直接挂载；其余按清单动态导入。这两处**不许出现同一模块**：同一插件挂两次会让它注册的服务重复，启动直接失败。

挂载完成后 `src/compose.ts` 核对一份必在服务清单（HTTP 宿主、会话存储、租户准入与管理、业务面网关与 `/api`、文件面 `/files`、目录选择）：Cordis 对注入不满足的插件是静默跳过的，少一个提供者就会整块少一个面，而进程照常启动。缺谁就在启动时报谁。

## 执行层

`sandbox.backend` 决定沙箱怎么起，两个后端共享同一组语义字段：`workDir`（不带会话的 exec 与常驻终端的工作目录；必须是容器本地路径而不是挂载点，默认 `/tmp/work`；k8s 后端按同一个值在沙箱里挂 `emptyDir`，因此两处不同值时沙箱内没有这个目录，每次命令都会因为工作目录进不去而失败）、`caseReadOnly` 与 `usersReadOnly`（`/case` 案件工作目录与 `/global` 用户跨案件工作目录是否对沙箱只读，都默认只读：这两棵树由业务侧通过管理接口写入，沙箱只是读取方，可写就意味着一个用户的沙箱能改到同案件其他用户的输入）、`systemRoot`（全局技能树）、`pythonRoot`（沙箱内 Python 运行时）、`toolsRoot`（三级工具清单，租户记录自带时以记录为准）、`idleTimeoutMs`（空闲预算：provider 把它注入沙箱，由沙箱自己判定空闲并退出）、`sandboxCacheTtlMs`（句柄缓存）、`startTimeoutMs`（冷启动上限）、`toolTimeoutMs`（单次命令上限，k8s 侧对应传输期限）、`maxOutputBytes`（沙箱内每条输出流的上界，须留在宿主结果上界与 `run_code` 载荷上界之上）、`memoryLimit` 与 `cpuLimit`（沙箱容器自己的内存与 CPU 上界，两个后端同义，只是内存值的写法各按各家语法：docker 写 `2g`，k8s 写 quantity 如 `6Gi`；k8s 侧在加载期校验 quantity，写错立即报错；不配则沙箱没有内存上界，Pod 落在 BestEffort，可以一路吃到节点内存耗尽，生产必须配 `memoryLimit`）、`cliTimeoutMs`（单次容器 CLI 调用）、`readyTimeoutMs` 与 `readyPollMs`（冷启动后等待 tool-exec 答话的上限与轮询间隔）。

差异只在启动方式与各自的部署事实：docker 侧是 `runtime`/`network`/`image`/`publishHost`/`connectHost`，k8s 侧是 `namespace`/`image`/`workspaceClaim`/`claimRoot`/`pythonEnv`（沙箱内 Python 的 `binDir`/`virtualEnv`/`sitePackages`，节点目录宿主读不到）/`kubectlBinary`/`imagePullPolicy`/`toolExecPort`/`statusPollMs`/`command`（沙箱里启动的容器命令）/`env`（沙箱容器的显式环境变量，身份变量与 Python 三件套仍由 provider 在它之后写入）；k8s 的分层目录、claim 与 `pythonEnv` 是必填项，缺一项即报错。

除了 `image`/`imagePath`/`toolTimeoutMs` 这几个改过名的字段，沙箱段的每一项都对应容器 provider 的同名 Config 字段：两个 provider 的可配置字段在租户配置里都能设，取值不必落在 provider 的默认值上。

会话的工作目录不是 `workDir`，而是它在 `/sessions` 下的那一层：`src/spine.ts` 的 `containerSessionDir()` 把 `/sessions/{sessionId}` 作为业务面网关的默认 cwd 交给网关，由网关在建会话时填入真实 id。这是本部署对「会话的工作目录在哪」的唯一答案——会话的一次性命令跑在这里，文件工具的相对路径解析到这里，而 `sandbox:policy` 告诉模型的工作区同样取自它（那段说明由会话 cwd 生成）。三者同源，模型按说明用相对路径写出的成品，就是 `GET /files/session` 列得出来、前端点得开的那一个文件；换成容器本地的共享默认目录，成品会落在随沙箱销毁的 `emptyDir` 里。宿主不负责建这一层（网关的 `createProjectDirectory: false`）：宿主上没有这个容器路径，这一层由沙箱在会话第一条命令时建在挂载上。

## Model Experience

None, as the tenant boot entry resolves configuration and mounts the spine; every model-facing registration belongs to the plugin a row mounts.

#### KV Cache effect

同一份配置与同一份案件可见工具清单下这段工具前缀是稳定的：呈现方式与并发上限都只在启动时读取一次，可见工具集合按案件的 `restriction.yaml` 与层级清单在 agent 创建时解析一次，SDK 声明按可见工具的稳定顺序重算。改 `tools.mode`、改案件的可见工具清单或换一份层级清单，都会改写系统提示词里工具那一段，那一次请求的缓存前缀因此失效。

## Known Limitations and Deferred Work

- 组合清单是**手写**的：新增一块 dsh 插件要在这个包里显式加一行，dsh 的 bundle 补丁新增一行不会自动出现在租户服务里。
- 清单之外的插件没有逐行配置之外的能力：想改某一行插件的深层配置，只能在 `plugins.<id>.config` 里写它接受的字段，配置校验不校验这些字段（它们是各插件自己的 Config）。
- 工具呈现只有一份全栈默认值：按案件或按 agent 差异化**呈现**要挂 `@deepseek-ai/dsh-agent-tool-presentation` 并给 preset 声明呈现方式，租户栈目前没有这一行；`plugins.tools.config` 也是全局覆盖，不是逐租户的。逐案件的**可见集合**已经有承载：案件目录里的 `restriction.yaml` 由 `tools-restriction` 这一行在创建 agent 时读取。
- 呈现方式按 agent 而不是按工具：`code` 模式下同一个 agent 里没有「一部分工具走原生、一部分走 code」的中间态。
- 每条 MCP server 的 cap 只按**分配**写：一条挖掘 server 上的大批量扇出不会比它那条 cap 更快，除非在那一条 server 上调高上限并先确认它扛得住——租户侧不替任何一条第三方 server 做这个判断。共用同一个后端的多条 server 之间还要一起看：各条 cap 之和就是打到那个后端的并发。
- `mcpServers` 只承载 Streamable HTTP 入口：`stdio` 那一支（`command`/`args`/`env`/`cwd`）在租户配置里是未知字段，要接一个子进程形态的 MCP server 得在 `src/spine.ts` 里加一行并给出它的配置。
- MCP 请求头的值只能来自配置文件：环境变量覆盖的清单是固定的（见 `applyEnvOverrides`），`mcpServers` 不在其中，所以 k8s 部署把整份配置装进 Secret 而不是 ConfigMap（`docker/k8s/tenant-host.yaml`，容器里那份文件是 0400）。这份 Secret 由 kubelet 挂进容器，卷挂载不走 ServiceAccount，所以命名空间的 Role 仍然不授予任何 `secrets` 权限。
- 业务面与用户全局层的写入路径仍在收敛中：用户管理目前只有一个准入方法（`users.ensure`），用户级的 skill/tool 管理还没有独立承载面。
- 终端三行的两层覆盖都在 dsh 那一侧，租户组合本身挂不了假运行时：`packages/terminal/terminal-container/tests/loader.spec.ts` 经 `@deepseek-ai/dsh-loader-smoke` 启动 `examples/acp-agent/tests/fixtures/terminal/tool-terminal/cordis.yml`（容器运行时指向夹具同目录的假实现，模型由夹具脚本化），**真跑一轮** `terminal_open → terminal_send → terminal_read` 并把写入的标记读回；快照层由 `examples/acp-agent/pty.cordis.yml` 的 `pty-tools` 场景覆盖（`dsh-terminal` + `dsh-terminal-bash` + `dsh-tool-terminal`），keyless 回放比对期望输出。租户组合要覆盖它需要 `TenantAppConfig.plugins` 之外的额外插件入口——它目前只能开关清单行（`src/types.ts`）。租户侧的终端证据来自真实部署：沙箱里四个工具跑通。
- 案件工具层的挂载点是**宿主路径**，沙箱里办案人看到的 `/case` 是另一份存储：`tools-restriction` 在创建 agent 时读宿主进程看得见的那份 `restriction.yaml`。两处都实测过：宿主侧写 `<workspaceRoot>/tools/restriction.yaml` 为 `deny: [ask_user_question]` 后该工具从模型可见工具集合消失而 `bash` 保留，写未知工具名时回合被拒（加载即 fail-loud），删除后回到基线；在沙箱内用终端写出 `/case/tools/restriction.yaml` 则宿主侧看不到该文件，新会话的可见工具集合也不受影响。因此按案件放宽/收窄由运维在**宿主侧**维护，办案人在沙箱内改这份文件不生效。
