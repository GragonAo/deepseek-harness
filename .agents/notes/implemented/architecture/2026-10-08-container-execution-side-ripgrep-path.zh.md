# Agent Note: 容器执行侧才认得 ripgrep 二进制

Status: implemented

[English](2026-10-08-container-execution-side-ripgrep-path.md) | 中文

> [glob/grep 走打包的 ripgrep spawn](2026-08-01-packaged-ripgrep-search.md) 里的打包二进制与 argv 向量 spawn，仍是共置部署的机制；那份记录否决掉的「可注入的二进制路径」现在以部署 `Config` 字段的形式回归，服务的是执行侧在容器里的场景。

## 问题

`glob` 与 `grep` spawn 的是它们所在进程解析出的那个 ripgrep 二进制：本工作区 `node_modules` 里的 `@vscode/ripgrep` 平台包，或单文件运行时里可执行程序旁的 `-rg` 伴随文件。租户栈把执行侧放进容器——`ctx.subprocess` 是 `packages/tenant/subprocess-container`，它把 argv 向量转发进沙箱——于是这个假设的两半都不成立。租户宿主镜像跑的是打包产物（`Dockerfile.tenant` 打包 `packages/tenant/tenant-app/lib/bin.js`），那里的 `import('@vscode/ripgrep')` 是包内的一句动态 import：打包器不会内联可选的平台包，pnpm 也不会把依赖提升到根 `node_modules`，所以镜像里根本没有这个包，解析直接失败。即使解析成功，得到的也是**宿主**文件系统里的绝对路径，而 spawn 发生在容器里，容器的文件系统没有那个路径。两种情形都以同一条错误到达模型：`Error: glob could not start its search command (ripgrep launch failed)`，码为 `SEARCH_FAILED`；而在本进程里做的任何解析，都不可能对一份它看不见的文件系统成立。

## 决策

`@deepseek-ai/dsh-tool-fs-search` 新增可选配置字段 `ripgrepPath`：执行侧那个 ripgrep 二进制的绝对路径。配置了就原样交给 `resolveRgPath()`——不解析打包包、不探测存在性——并成为 spawn 的 `argv[0]`。不配置时打包解析照旧：惰性、按进程 memoize，共置部署的行为与报错因此一字不变。

字段本身就是全部机制：执行侧带哪个二进制是该侧镜像的事实，而[插件配置规则](../../../../AGENTS.md#conventions)正是把随部署而变的值放进经校验的 `Config`。加载期只检查「空白」这一项——不看另一份文件系统就能判定的误配；一个路径是否可用只有执行侧能回答，所以不可用时每次调用都以 `SEARCH_FAILED` 失败，消息里给出配置的那个路径。这个失败之所以留在调用期，理由与打包解析本就留在调用期相同：部署故障不该把整个组合拖垮。

租户栈两侧都接上了。`packages/tenant/tenant-app/src/spine.ts` 设 `ripgrepPath: '/usr/local/bin/rg'`，而 tool-exec 镜像在构建阶段把 npm 平台包 `@vscode/ripgrep-linux-x64` 的 `bin/rg` 装到该路径，并以 `test -x /usr/local/bin/rg && /usr/local/bin/rg --version` 自检，过不了就构建失败。这次安装不访问任何 GitHub release——只走构建为 `esbuild` 已经在用的那个 npm registry。

## 备选方案

- **把两份文件系统对齐，让打包路径在容器里也存在。** 否决：它只修掉两个失败里的一个，另一个仍然是宿主的绝对路径被交给容器里的 spawn。它还会让两个各自独立构建的镜像逐字符依赖同一套布局，而没有任何东西在保证这一点，于是基座镜像或依赖一改，失败就回来。
- **在 `subprocess-container` 里把宿主路径改写成容器路径。** 否决：那个适配器为所有工具转发通用的 argv 向量，改写就只能靠参数位置去辨认 ripgrep——把一个搜索工具的部署细节塞进所有工具共用的 seam，而且这条规则会在「看起来像路径的参数」上误判。
- **回落到容器 `PATH` 上的 `rg`。** 否决：搜索于是取决于镜像恰好带了哪个二进制，而它缺失时表现为一条没有来由的 `ENOENT`；显式路径是同一个决定，只是把依赖写明了。
- **把二进制内嵌进 harness 核心。** 否决：二进制必须落到执行侧的文件系统上才能在那里执行，所以核心里的那份仍然要靠镜像持有、或每次 spawn 传一次，而核心为一个工具包的需要背上一个平台相关的产物。

## 后果

- 共置部署不变：不配 `ripgrepPath`，还是那条惰性的打包解析、同一个 memoize 的失败、同一段 `SEARCH_FAILED` 文案。
- 租户沙箱里的 `glob`/`grep` spawn 的是 `/usr/local/bin/rg`，该部署中宿主侧的 `@vscode/ripgrep` 副本从不被执行。真正运行的只有执行侧的那个二进制，所以镜像里钉住的版本与宿主依赖范围不必一致。
- `ripgrepPath` 配错是运行期的搜索失败，而不是加载失败，部署从第一次工具调用就能发现；消息里带着那个路径，正因如此它才可操作。
- tool-exec 镜像多了一次 ripgrep 安装，走的是 `esbuild` 步骤已经在用的同一个 `NPM_REGISTRY` 构建参数；构建宁可失败，也不放出一个没有搜索二进制的沙箱。

### 验证

- `packages/fs/tool-fs-search/tests/tools.spec.ts` 断言：两个工具都以配置的路径作为 `argv[0]` spawn；不配置时仍 spawn 打包的 `rgPath`；启动失败时报告 `SEARCH_FAILED` 并在消息里给出配置的路径，而未配置时的消息不含路径；空白的 `ripgrepPath` 让插件加载失败。
- `packages/fs/tool-fs-search/tests/rg-path.spec.ts` 在 `@vscode/ripgrep` 被 mock 成求值即抛的前提下解析配置的路径，证明配置分支从不触碰打包模块。
- `pnpm exec tsc -b tsconfig.host.json` 无输出，本包测试通过（`pnpm exec vitest run packages/fs/tool-fs-search/tests`）。
- tool-exec 的 Dockerfile 在构建期断言 `/usr/local/bin/rg --version`，缺二进制的镜像构建不出来；确认 `glob`/`grep` 在沙箱里真的给出结果、而不是以 `SEARCH_FAILED` 失败，靠的是在已部署租户栈上跑一轮会话。
