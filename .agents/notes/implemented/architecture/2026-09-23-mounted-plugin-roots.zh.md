# Agent Note: 挂载插件根目录不是一项能力

Status: implemented

[English](2026-09-23-mounted-plugin-roots.md) | 中文

## 问题

部署方需要在不重建 harness 镜像的前提下加一个对接自己业务系统的插件。此前每个插件都是镜像安装的 npm 包，而 cordis 行只能用裸标识符指名它，所以部署方没有办法让一行指向自己持有的代码。

有两条路能补上：新增一项能力，把短名字映射到配置好的目录；或者用 Loader 本来就有的路径标识符 —— 它已经能把 `.` 开头的行按 `baseUrl` 解析。

## 决策

挂载插件用路径标识符注册，不新增任何能力。

`mountRootInclude` 把 Loader 的 `baseUrl` 设成配置文件所在目录，`Tree.import` 据此解析 `.` 开头的标识符，所以部署方写一行相对路径即可，插件按配置文件解析而不是按进程工作目录解析：

```yaml
- insert:
    - id: tool-sync-file
      name: './plugins/tool-sync-file/index.mjs'
```

插件目录放在部署自己的 profile 下面（`$DSH_HOME/profiles/<profile>/plugins/<name>/`），因为挂载插件 `import` harness 包时走 Node 逐级向上的 `node_modules` 查找，只有从 profile 里面出发才会走到启动器维护的 `$DSH_HOME/profiles/node_modules` 兜底目录。在部署宿主上实测：入口放在 profile 的 `plugins/` 下能解析到 `@deepseek-ai/dsh-tools`；同一个文件放在 `$DSH_HOME/plugins/` 下会 `ERR_MODULE_NOT_FOUND`。

`packages/boot/app-boot/tests/mounted-plugins.spec.ts` 守住这条机制：真实组合里根配置带一行相对路径，插件被挂上且它的工具完成注册；该行按配置文件所在目录解析而不是按工作目录；行指向目录或指向不存在的文件时，启动失败并报出该路径。

## 考虑过的替代方案

**带 `local:` 前缀和可配置根列表的 `plugin-roots` 能力。** 已经做出来、有 18 个用例覆盖，随后被移除。它能用，但路径标识符在零新增面的前提下已经覆盖了同一个场景：那项能力引入了一个服务、一个标识符命名空间、一套根目录解析算法，以及一个自带 README、invariant 伴生文件和测试的包 —— 全部只是为了产出一个 `new URL(name, baseUrl)` 自己就能产出的字符串。没有消费者的机制就是维护成本，而每一项抽象都被要求有当前消费者。

它唯一实打实的好处是简短：`local:report-sync` 比 `./plugins/report-sync/index.mjs` 短，而且它不可能和已安装包名冲突，因为裸名不可能以 `local:` 开头。相对路径以另一种方式保住了同一个保证 —— 裸标识符永远不是路径 —— 代价是要把入口文件写全。

**裸名先按挂载目录解析，再走 npm 解析。** 否掉：优先级在行里看不出来，同一个名字在不同部署里含义不同。

**自动扫描一个约定目录。** 否掉：隐式扫描意味着只要把文件放进去，不可信目录就变成可执行的。

## 后果

挂载插件的部署方要把入口文件路径写全，而这一行的含义取决于配置文件自己所在的目录：配置搬到哪里，插件的解析就跟着到哪里。

`mountRootInclude` 的 `.` 分支现在就是全部机制，所以上面那个回归测试是让它保持诚实的东西。绝对路径的行还额外依赖启动器提供裸模块基准，这也是那个测试只覆盖相对形式的原因。

业务对接因此完全活在 `packages/` 之外：harness 交付 Loader 的路径解析，部署交付被解析到的代码。
