# @deepseek-ai/dsh-mcp-client

[English](README.md) | 中文

MCP 客户端桥接插件：连接外部 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器，把它们的工具注册到 `ctx.tools`，使模型能够通过服务器限定名称（`mcp__<serverName>__<rawName>`）将其作为原生工具使用。

## 用法

`cordis.yml` 中每个 MCP 服务器使用一个插件实例：

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'

- id: mcp-mining
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: mining
    transport: streamable-http
    url: http://127.0.0.1:8080/mcp
    toolConcurrency:
      policy: parallel
      mode: adaptive
      maxConcurrentCalls: 20
      recoveryQuietMs: 5000
      retryAttempts: 2
      retryTools: [explain_query, list_indexes]
      exclusiveTools: [create_index, drop_index, write_rows, update_rows, delete_rows]
```

第三个配置项是第三方服务器的形态：注解既改不了也信不过，于是所有工具都声明为可并发，让二十个查询同时在途，而那五个写数据的工具在客户端侧保持串行。它的 `mode: adaptive` 还让客户端自己摸清对方能承受多少：从二十起步，每次被拒就把上限减半，最低到一次一个调用，然后每五个没有拒绝的秒数加回一个槽位。`retryAttempts: 2` 会重发被拒的调用，先等带抖动的 200 毫秒、再等 400 毫秒——但只针对声明了 `readOnlyHint: true` 的工具，或列入 `retryTools` 的工具，此处即那两个注解有误的只读工具。那五个写数据的工具绝不会被重发。

模型会看到 `mcp__github__create_issue`、`mcp__web__search` 等工具，这与 Claude Code 和 Codex 使用的服务器限定形状相同。HMR（热模块替换）支持热替换：编辑配置项会触发断开 + 重新连接，无需重启进程；`serverName` 不变时会生成完全相同的工具名称。

## 配置

| 字段 | 传输 | 必填 | 描述 |
|---|---|---|---|
| `transport` | 两者 | 是 | `"stdio"` 或 `"streamable-http"` |
| `serverName` | 两者 | 是 | 该服务器面向模型工具名称的 namespace；`[A-Za-z0-9_-]{1,32}`，在存活实例中唯一 |
| `command` | stdio | 是 | 要 spawn 的可执行文件 |
| `args` | stdio | 否 | 传给命令的参数 |
| `env` | stdio | 否 | 合并到已清理环境中的额外环境变量 |
| `cwd` | stdio | 否 | 子进程工作目录 |
| `url` | http | 是 | MCP 服务器 URL |
| `headers` | http | 否 | 额外标头（例如认证 token） |
| `toolCallTimeoutMs` | 两者 | 否 | 每次 `callTool` 调用的超时（默认 60000） |
| `failOnStartupError` | 两者 | 否 | 初始连接或工具同步失败时拒绝插件激活（默认 `false`） |
| `reconnect.enabled` | 两者 | 否 | 连接丢失后自动重新连接（默认 `true`） |
| `reconnect.initialDelayMs` | 两者 | 否 | 首次重连延迟（毫秒）；每次连续失败尝试翻倍（默认 500） |
| `reconnect.maxDelayMs` | 两者 | 否 | 退避上限（毫秒）；同时也是重置尝试预算所需的正常运行时长（默认 30000） |
| `reconnect.maxAttempts` | 两者 | 否 | 每次中断期间连续失败尝试次数上限，超出后彻底放弃（默认 10） |
| `toolConcurrency.policy` | 两者 | 否 | 该服务器工具的并发调用判定规则：`"annotations"`、`"parallel"` 或 `"exclusive"`（默认 `"annotations"`） |
| `toolConcurrency.mode` | 两者 | 否 | 上限是配置的固定数字（`"fixed"`），还是从该服务器被拒情况学到的数字（`"adaptive"`）（默认 `"adaptive"`） |
| `toolConcurrency.maxConcurrentCalls` | 两者 | 否 | 该服务器同一时刻允许在处理中的调用数；自适应模式下的起始上限与最高上限（默认 10） |
| `toolConcurrency.exclusiveTools` | 两者 | 否 | 该服务器中绝不与其它调用重叠的原始工具名称，不受 `policy` 对其余工具的判定影响（默认：无） |
| `toolConcurrency.retryTools` | 两者 | 否 | 该服务器中允许在被拒后重发的原始工具名称，与声明 `readOnlyHint: true` 的工具并列（默认：无，即只重发只读工具） |
| `toolConcurrency.decreaseFactor` | 两者 | 否 | 自适应模式下每次被拒时施加于上限的乘数，大于 0 且小于 1（默认 0.5） |
| `toolConcurrency.recoveryStep` | 两者 | 否 | 自适应模式下每个静默窗口向上限加回的槽位数（默认 1） |
| `toolConcurrency.recoveryQuietMs` | 两者 | 否 | 多久没有拒绝才回升一步，单位毫秒（默认 2000） |
| `toolConcurrency.countTimeouts` | 两者 | 否 | 触及 `toolCallTimeoutMs` 的调用是否算作被拒（默认 `true`） |
| `toolConcurrency.retryAttempts` | 两者 | 否 | 被拒调用的额外尝试次数，最多 5 次，且仅对只读或列入 `retryTools` 的工具生效（默认 0） |
| `toolConcurrency.retryBaseDelayMs` | 两者 | 否 | 首次重发前的延迟（毫秒）；之后每次尝试翻倍（默认 200） |
| `toolConcurrency.retryJitterRatio` | 两者 | 否 | 每次重发延迟中被随机化的比例，取值 0 到 1（默认 0.2） |

## 工具命名

每个 MCP 工具都有两个名称：通过 `tools/call` 在协议上传送的原始 MCP 名称，以及公开名称 `mcp__<serverName>__<rawName>`，后者注册到 `ctx.tools`。公开名称会规范化为 DeepSeek 函数名称约定（64 个字符、`[A-Za-z0-9_-]`）；如果替换或截断改变名称，就会追加 `(serverName, rawName)` 的确定性 12 位十六进制 hash，确保不同工具绝不会折叠为同一个名称。名称是 `(serverName, rawName)` 的纯函数：连接顺序、重新同步和其他服务器永远不会重命名工具。

- 发布相同原始名称（例如 `search`）的两个服务器会在各自 namespace 下共存。
- 存活实例中的重复 `serverName` 会使后加载的插件实例失败。
- 服务器在工具列表中两次列出同一工具名称时，该列表会作为无效工具列表被拒绝。
- 外部注册抢占该服务器 namespace 时，会回滚整个世代（绝不保留部分集合），并明确报错。

## 行为

- 连接时：插件激活会等待 `listTools()`，并在组合开始首个轮次前通过 `ctx.tools.register()` 以公开名称注册每个工具。初始连接、发现或注册失败始终会记录日志；`failOnStartupError` 为 true 时拒绝激活，否则插件仍会激活但不注册工具。
- 监听 `notifications/tools/list_changed` → 重新同步；获取阶段失败时保留上一世代的注册，注册冲突则会回滚本次尝试的世代，并且不保留该服务器的任何工具。
- 工具执行：`client.callTool({ name: rawName, arguments }, { signal })`，支持超时 + 中止；公开名称绝不会发给服务器。
- 并发取决于每个工具自身的 MCP 注解：声明 `readOnlyHint: true` 或 `idempotentHint: true` 的工具被声明为可与其他工具调用并行执行，其余工具独占执行（一次一个调用，整个 harness 生效）。`toolConcurrency.policy` 可按服务器覆盖该判定——`"parallel"` 声明该服务器的所有工具都可并发，`"exclusive"` 声明全都不并发——用于注解缺失或有误的服务器。判定按工具进行，与参数无关。
- `toolConcurrency.exclusiveTools` 给出该服务器中绝不与其它调用重叠的原始工具名称，独立于 `policy` 与 `maxConcurrentCalls`：即使该工具声明了 `readOnlyHint`，列入名单后仍判定为独占，因此一个服务器可以同时接受 20 个调用，而那五个写数据的工具保持串行。名单在发现阶段按服务器自己的 `tools/list` 判定——服务器没有列出的名称会让该次同步失败并报出它实际列出的名称，而不是静默地什么都没串行化。被列入名单的调用在整个助手步骤内独占运行，因为循环的独占屏障就是这样生效的；同一步骤中发往其它服务器的只读调用也要等它，而 `maxConcurrentCalls` 只约束其余调用。
- `toolConcurrency.retryTools` 回答的是另一个问题——哪些调用允许发第二次，两份名单互不蕴含：`exclusiveTools` 管提交顺序，`retryTools` 管重复执行，`policy` 管能否并发。一个顺序重要的只读工具应同时出现在两份名单里；一个写工具则两份都不该出现。名称同样按服务器自己的 `tools/list` 判定，因此 `retryTools` 写错名字会让该次同步失败，而不是悄悄让该工具永不重发。
- 发往同一服务器的每个 `tools/call` 都会经过该服务器 `toolConcurrency.maxConcurrentCalls` 个在途请求的上限。超出上限的调用按 FIFO 顺序等待而非直接失败：这些调用都是模型主动发起的，而且每次调用的超时从请求发出时才开始计时，因此排队等待不计入 `toolCallTimeoutMs`。该上限按插件实例计算，第二个服务器保有各自的预算。dispose（资源释放）会使仍在等待的调用失败，而不是让它一直挂起。
- `toolConcurrency.mode` 决定这个数字从哪来。`"fixed"` 在整条连接的生命周期内保持 `maxConcurrentCalls`，适用于已经实测过的服务器。`"adaptive"`（默认）改为把这个数字学出来，针对的正是通常情形——第三方服务器的容量未知也无从询问：它从 `maxConcurrentCalls` 起步，每次被拒就按 `decreaseFactor` 减半，最低到一次一个调用（永不为零，因此拒绝不会让调用停止发出），并在已有 `recoveryQuietMs` 没有拒绝后加回 `recoveryStep`。对一个没人实测过的服务器，写死的数字不可能恰好正确：偏高就产生随后被学习吸收的拒绝，偏低就白白浪费调用方要的并发，而学到的上限始终落在配置的边界内。已经授予的槽位绝不会被收回，因此下调只改变接下来哪些等待中的调用获准进入。学到的上限只存在于插件实例内，不做持久化：重启或 HMR 重载会从 `maxConcurrentCalls` 重新开始，同一部署的每个副本也各自学习自己的预算。
- 判定“被拒”依据的是客户端自己观察到的失败：HTTP 429 或任何 5xx 状态、连接关闭、TCP 连接被拒绝或重置，以及 `countTimeouts` 为 true 时触及 `toolCallTimeoutMs` 的调用。服务器为工具选择的 JSON-RPC 错误、工具层的 `isError` 结果、调用方取消，以及命令缺失一类的错误配置都不算被拒，也绝不会改变上限。
- `toolConcurrency.retryAttempts` 会把被拒的调用最多额外重发该次数，每次先等 `retryBaseDelayMs` 并逐次翻倍，每个延迟再按 `retryJitterRatio` 缩放，以打散同时发起的批次。该预算只适用于自身注解声明 `readOnlyHint: true` 的工具，或列入 `retryTools` 的工具：`retryTools` 为空时只重发只读工具，因此写入被重发的原因只能是部署方明确说过重发它安全，绝不会是因为它没被列进某份名单。不在允许名单内的工具在首次被拒时即失败，且如实失败。每次尝试各自占用队列槽位、各自拥有 `toolCallTimeoutMs` 时限，因此排队与退避都不计入该次调用的超时，而每次被拒的尝试同样会下调自适应上限。等待重发期间被取消的调用会报告该取消。重发尝试是模型不会看到的服务器侧请求：被重发的调用仍然只产生一个结果。
- 规范成功值是 `{ content: JsonValue[], structuredContent? }`；完整的 JSON MCP 块会保留给编程调用方。受支持且已声明的 `outputSchema` 会验证 `structuredContent`；不受支持的 schema 词汇会回退为不受约束的 `JsonValue`。
- Native／模型渲染会保留 MCP 块顺序。文本类连续块以换行连接；资源链接以文本保留名称和 URI；只有挂载 `ctx.attachments` 且确切调用模型路由明确声明支持图片输入时，受支持的图片才会成为持久核心图片块。整个图片批次会先完成解码与准入，再保存任一成员。格式错误或被拒绝的图片批次、音频、嵌入资源和不受支持的块会成为明确诊断文本，而不会消失。
- 同时带有 `structuredContent` 的结果，会把它的紧凑 JSON 序列化追加到新的一行，因此以数据作答的服务器会以数据形式抵达模型，而不是它 `content` 块里那句占位文本。文本中已经含有该序列化时不追加；`content` 为空数组时只渲染该序列化。规范值不受影响：程序化调用方和 Code Mode 仍分别收到 `content` 与 `structuredContent`。
- 只要部署注册了 `ctx.mcpCallMeta`，每次 `tools/call` 都会带上 `params._meta`：该服务的 `entries()` 在调用时读取并合并进这一次请求，需要按调用方鉴权、或需要调用方案件上下文的服务器正是靠这条通道拿到信息。这些条目不会进入模型、工具参数或结果；没有注册服务的部署一个 `_meta` 都不发，因此不需要这条通道的集成完全不变。
- 断开／崩溃时：supervisor 以指数退避（`reconnect.initialDelayMs` 逐次翻倍，上限 `reconnect.maxDelayMs`）重启原始服务器配置，成功后重新执行发现——恢复的世代会替换前一个，因此工具既不会重复也不会泄漏。中断期间最后一个正常世代保持注册；针对它的调用在恢复前会失败。
- 重连按中断预算控制：连续失败达到 `reconnect.maxAttempts` 次后，该服务器的工具会被注销，重连停止，直到 HMR 重载或重启 Host。连接存活超过 `maxDelayMs` 会重置预算，因此偶尔崩溃的服务器可以无限恢复，而崩溃循环的服务器——即使短暂连接成功——仍会耗尽上限而非永远重启。
- 重连状态在日志中对用户可见：reconnecting（warn，含尝试次数和延迟）、recovered（info）、最终失败和 disabled-loss（error）。dispose（资源释放）会取消任何待执行的重连。设置 `reconnect.enabled: false` 时，连接丢失后工具保持注册但调用失败，直到重载——即手动恢复行为。

## 消费的服务

| 服务 | 用途 |
|---|---|
| `ctx.tools` | 注册／注销 MCP 工具 |
| `ctx.attachments` | 可选；在模型投影前校验并持久保存图片结果批次 |
| `ctx.llm` | 可选；证明确切调用路由明确支持图片输入 |
| `ctx.mcpCallMeta` | 可选；为每次工具调用提供 `params._meta` |

## 模型体验

### 已发现的 MCP 工具

#### 模型看到的内容

初始发现成功后，每个已声明的 MCP 工具都会显示为名为 `mcp__<serverName>__<rawName>`（或其确定性规范化形式）的原生工具，并携带服务器提供的描述和输入 schema。成功的重新同步——包括自动重连后的同步——会替换整个世代；对插件执行 dispose（资源释放）或重连预算耗尽会移除该世代。

#### Token 影响

工具注册期间，每次请求都会承担数据相关的 schema 成本。重新同步会替换而非累积 schema，服务器限定名称也会为每个工具定义和调用增加 token。

#### KV Cache 影响

只要已发现工具集合及其 schema 不变，前缀就保持稳定。增加、移除、重命名或更改工具的重新同步会替换定义，并可能使从第一个变化的 schema token 起的复用失效；恢复了未变列表的重连会生成完全相同的定义，前缀保持稳定。

### 工具调用历史与结果

#### 模型看到的内容

公开工具名称和 JSON 参数会保留在 assistant 历史中。执行局部的规范值始终为程序化调用方和 Code Mode 保留完整 JSON MCP 块及可选结构化内容。在 Native 上下文中，结果文本是投影后的 `content` 块，服务器报告了 `structuredContent` 时再接上它在新行上的序列化——文本中已含该序列化时省略，`content` 为空时单独使用。随后，受支持的图片块会在确切路由能力得到证明后，按原始顺序与文本一起持久投影；Code Mode 还会经外层 `run_code` 结果转运这份已经结算的丰富投影，而不改变规范绑定值。被拒绝的图片、音频、嵌入资源、资源链接和未知块会继续以有界文本诊断可见；MCP `isError` 会在持久化图片前拒绝调用。

#### Token 影响

参数、映射后的文本和持久图片引用会保留到压缩（compaction）发生时。`structuredContent` 的序列化与它所并入的文本一样被保留。内联 MCP base64 只存在于执行局部的规范值中，绝不会复制进会话事件；提供方会从附件存储读取经过校验的字节。音频和嵌入资源载荷仍不会进入模型上下文。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 并发的 MCP 工具调用

#### 模型看到的内容

并发判定对模型不可见：没有任何 schema 字段、提示词文本或结果文本携带它。模型能观察到的是时序与顺序。被判为可并发的工具会与同一 assistant 轮次中的其他工具调用重叠执行，而不是排在它们后面，因此一个轮次内向同一服务器提出的多个只读问题会一起返回，而不必相隔一次往返。被判为独占的工具单独执行；超出该服务器上限的调用会等待空位而不是失败，因此大批量调用分批完成，任何调用都不会被报告为错误。列入 `toolConcurrency.exclusiveTools` 的工具始终属于独占情形：同一轮次的其它调用都要等它，包括发往其它服务器的调用。无论服务器以何种顺序应答，结果都按模型请求的顺序到达。学到的上限只改变同时在途的调用数和其余调用的等待时长：面向一个会拒绝调用的服务器，随着上限下调批次耗时变长，随上限回升又会变快。被允许名单覆盖的被拒调用会被重发，于是服务器拒了一次请求、模型却只看到一个结果，完全没有错误；不在允许名单内的被拒调用会在首次尝试时就报告服务器的拒绝。

#### Token 影响

直接为零：判定所读取的注解和上限都不出现在工具定义、参数或结果中。间接影响：相同的调用产生相同的 token，顺序也相同；并发只缩短这些结果可用之前的实际耗时。

#### KV Cache 影响

仅追加，且与判定无关。重叠调用按模型顺序而非完成顺序提交结果，因此下一轮的请求前缀与串行情形产生的序列相同，复用不受影响。更改 `toolConcurrency.policy`、`maxConcurrentCalls`、`exclusiveTools`、`retryTools`、`mode` 或任何自适应与重发参数只会重新判定调用，不改变任何工具定义 token，因此绝不会使可复用前缀失效。被重发的调用不会增加自己的提供方请求：它的单个结果仍落在模型请求的位置上。

## 已知限制与暂缓事项

- **只桥接 MCP 的工具能力**：资源和提示词没有 harness 消费接口，暂缓实现。
- **启动超时继承自 MCP SDK**：DSH 尚未公开连接／发现超时。每次 initialize 请求或分页 `tools/list` 请求都使用 SDK 默认的 60 秒，因此在初始同步完成期间，无响应的 server 或 cursor chain 可能同时延迟激活与 teardown。
- **重连在传输关闭时触发**：崩溃的 stdio 子进程会触发重连；Streamable HTTP 失败通过每次请求以及 SDK 传输自身的 SSE（Server-Sent Events）流恢复机制暴露，因此不可达的 HTTP 服务器会按调用重试，而非由 supervisor 重新 spawn。
- **图片是唯一的持久丰富结果桥接**：PNG、JPEG、WebP 和 GIF 可以在确切能力得到证明后进入 Native 上下文。音频和嵌入资源载荷仍只存在于执行局部，并配有明确诊断；资源链接只以文本保留名称和 URI。
- **不强制执行不受支持的 MCP 输出 schema**：已声明 schema 使用 harness 子集之外的词汇时，`structuredContent` 会回退到 `JsonValue`。
- **`structuredContent` 整体追加、没有上限**：序列化本身没有大小上限，因此以大体量结构化载荷作答的服务器会让这些 token 在会话之后的每次请求中都被支付。需要上限的部署只能降低服务器返回的内容；投影本身没有截断设置。
- **自适应模式按插件实例学习**：学到的上限是内存状态，不持久化、不记日志，也不在同一部署的副本之间或访问同一服务器的两台主机之间共享，因此若干独立实例叠加起来仍可能超过服务器能承受的量。跨副本的协同限流不在范围内；替代做法是调低 `maxConcurrentCalls` 或使用 `mode: "fixed"`。
- **超时默认算作被拒**：`countTimeouts: true` 时，真正缓慢的服务器会被当作过载而下调，因此面向它的批次可能被毫无收益地串行化。对延迟本就可预期的服务器，可调大 `toolCallTimeoutMs`、调小 `recoveryQuietMs`，或设置 `countTimeouts: false`。
- **重发允许名单信任服务器给出的 `readOnlyHint`**：该注解是服务器提供的线上数据，一个把写工具误标为只读的服务器，其被拒调用会被重发。这个判定没有反向开关：对某个服务器的这类注解信不过时，只能把该服务器的 `retryAttempts` 设为 0，而这同时也会关掉其列入 `retryTools` 的工具的重发预算。
