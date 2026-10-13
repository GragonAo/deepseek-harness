# @deepseek-ai/dsh-tools-manifest

在不接受任何可执行代码的前提下，把多租户 carrier 的环境工具目录变成工具。每次 `agent/created` 事件，插件读取 `ctx.toolTiers` 提供的案件级、用户全局、系统级三个根目录，把每个 `*.yaml` / `*.yml` 解析为纯数据清单，并按该根目录的 rank 注册到已创建 agent 自身的作用域——案件级（`30`）遮蔽用户全局（`40`），后者又遮蔽系统级（`50`），异名则取并集。因为注册表带 rank 的 `register` 会遮蔽同名内置工具，而一个不注册任何环境名的作用域里不存在同名覆盖，所以系统级同样可以覆盖某个同名的内置工具。层级目录里那份保留文件名的 `restriction.yaml` 不是清单、也不会被这里解析：它属于 `@deepseek-ai/dsh-tools-restriction`，由后者把 agent 继承来的工具收窄到它允许的名字。

一份清单只映射到一种固定的执行器家族：通过 `ctx.subprocess`（在多租户 carrier 里就是租户容器）启动的子进程，其 argv 是清单 `executor.args` 模板，`$field` 占位符由校验后的字符串参数替换。文件里没有脚本宿主、没有模块导入、也没有 `execute` 函数体：声明字段是唯一输入，且命令在租户容器内运行，因此租户编写的案件级清单无法逃逸隔离。输出是有界的字符串；默认原样返回命令的 stdout，非零退出码则让工具调用失败。

## 清单格式

每个工具一份 YAML 文档，包含 kebab-case 名称、描述、扁平字符串参数和固定执行器：

```yaml
name: mytool
description: short summary the model reads for tool selection
parameters:
  query:
    type: string        # the only supported type: flat string scalars
    description: what the argument means
    required: true
timeoutMs: 30000        # optional; per-call tool timeout
executor:
  command: /usr/bin/tool
  args: ["--query", "$query"]
  cwd: /workspace       # optional; falls back to the loader's defaultCwd
  env:                  # optional; string values only
    TOOL_MODE: batch
```

`executor.args` 中的 `$field` 占位符会替换为对应的字符串参数；模型未提供的被引用参数会替换为空字符串，但 `required` 参数会在执行前先校验。

## 配置

```yaml
- name: '@deepseek-ai/dsh-tools-manifest'
  config:
    maxOutputBytes: 1000000  # optional; bounded stdout/stderr captured per call
    graceMs: 5000           # optional; process-tree termination grace per call
    defaultCwd: /workspace  # optional; cwd when a manifest omits executor.cwd
```

## Model Experience

### Registered tools

#### What the model sees

每份清单在组装的工具列表里呈现为一个工具，和其他已注册工具一样：它的 `name`、`description` 与扁平字符串 `parameters` 构成模型用于选择与调用的 schema，而 `timeoutMs` 只是部署预算、不是模型参数。三层中不同的清单名并入目录并集，跨层共享的名称按层级 rank 只解析一次为最近一层（案件级 优先于 用户全局 优先于 系统级）。

#### Token effect

每个注册的清单工具在每次请求中都有固定的 schema 成本，随当前（租户、用户）层级解析出的清单数量线性增长；改变存在哪些层级目录、或其中包含哪些清单，都会改变组装的工具列表。

#### KV Cache effect

在合并后的层级清单与请求的（租户、用户）作用域不变时前缀稳定；编辑清单、增删层级目录或在不同作用域下解析会使复用失效，失效点从第一个变化的 schema token 开始。

### Tool result

#### What the model sees

命令的 stdout 截断到加载器的 `maxOutputBytes`，经工具的 `render` 渲染为一个 `text` 块。

#### Token effect

数据相关，且在压缩前会被重复发送；字节上限约束单次调用发出的文本。

#### KV Cache effect

仅追加；结果跟在可复用的请求前缀之后，不会使已有的 KV-cache 条目失效。

### Tool failure

#### What the model sees

非零退出码会把 `Error: tool "<name>" exited <code>: <stderr-tail>` 渲染为失败调用的结果，其中 stderr 尾部为空时省略。

#### Token effect

只有保留的错误文本增加 token；失败调用的其他内容都不进入历史。

#### KV Cache effect

仅追加；失败跟在可复用的请求前缀之后。

## Known Limitations and Deferred Work

- **仅支持扁平字符串参数。** 参数值以 `$field` argv 替换的方式传给命令，因此当前版本无法表达更丰富的 ValueSchemaSpec 形式（数字、枚举、数组）。
- **每次创建 agent 都会重新读取层级目录。** 清单在 `agent/created` 钩子里同步读取；对少量文件可以接受，但异步的 `prepare()` 预热与缓存留待后续。
- **同一层级目录内重名仍然会大声失败。** 带 rank 的遮蔽解决跨层级共享名称，但同一目录里的两份清单必须保持名称不同。
- **`restriction.yaml` 这个文件名被 `@deepseek-ai/dsh-tools-restriction` 占用。** 层级目录里叫这个名字的文件不会被当作清单解析，因此一份真的想叫这个名字的清单必须改名。
- **凭据不属于清单。** 声明式文件不承载任何凭据面；命令行密钥由运营方通过 provider 预置，绝不能写进层级目录里的文件。
