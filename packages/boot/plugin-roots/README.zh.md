# `@deepseek-ai/dsh-plugin-roots`

[English](README.md) | 中文

Loader 解析挂载式插件代码所用的目录。cordis 里用 `local:` 前缀声明一个挂载插件 —— `local:report-sync` —— 本插件把这个引用解析成 Loader 要导入的入口文件绝对路径。这些根目录属于具体部署，所以它们是配置；默认是空列表，运维没有点名的目录，一个字节的代码都不会被加载。

## 配置

```yaml
- id: plugin-roots
  name: '@deepseek-ai/dsh-plugin-roots'
  config:
    roots:
      - /opt/.dsh/profiles/multi-tenant/plugins
- id: report-sync
  name: 'local:report-sync'
  config: {}
```

`roots` 有顺序：先提供该引用的根目录胜出。`plugin-roots` 那一行必须挂在所有用到它的 `local:` 行**之上**；没有配置根目录就写 `local:` 行，启动会失败并给出这条提示。

## 解析一个引用

`local:` 之后的部分是相对于某个根目录的路径，不允许是绝对路径，也不允许包含 `..`。目录内的入口文件取 `package.json` 声明的那一个 —— `exports["."]`（字符串，或它的 `import` 再 `default` 条件）然后是 `main` —— 都没有时依次尝试 `index.ts`、`index.js`、`index.mjs`。

## 信任边界

挂载插件就是可执行代码，所以「默认为空」是安全姿态而不是便利取舍：部署方点名它信任哪些目录，就只有那些目录会被搜索。这里没有目录扫描、没有按约定的自动发现、也不会退回按包名找 —— 裸标识符永远不会被当成挂载引用，因此挂载插件可以和已安装包同名而不会产生歧义。

## 失败

每一种配置错误都会中止启动并指出错在哪：配置的根目录不存在或不是目录（在挂载时）、没有任何根目录能提供该引用（会列出搜索过的每个目录）、清单不是 JSON 或声明的入口不存在、引用是绝对路径或越出根目录。不会有任何一项被静默跳过。

## 模型体验

无：本插件不注册任何工具、提示词段落或会话事件。它只通过自己解析出的插件触达模型，那些插件各自的契约拥有它们面向模型的行为。

## 已知限制与后续工作

- 若插件导入了 harness 的包，则位于 profile 目录之外的根目录需要自备 `node_modules`。位于 `$DSH_HOME/profiles/<name>/` 下的根目录会通过启动器维护的 `$DSH_HOME/profiles/node_modules` 兜底目录解析到它们。
- 解析器在加载时读取目录；替换挂载插件的文件需要重启或 HMR 重载，而不是改配置。
- `package.json` 的 `exports` 条件按固定的 `import` 再 `default` 顺序读取。需要其他条件的插件无法在这里表达。
