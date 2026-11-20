# Agent Note: 会话上传目录每轮都对模型可见，路由可以声明图像输入

Status: implemented

[English](2026-11-19-session-uploads-visible-and-modality-declarable.md) | 中文

## Problem

业务前端把文件放进会话目录（`uploads/`，由 `tenant-fs-http` 的字节通道写入）之后，发的消息正文里没有任何文件名，于是没人告诉模型收到了什么。模型唯一的文件入口就是这个目录，所以收到 `uploads/供述材料.pdf` 的会话把那一轮当成没有附件来回答，用户在会话里的第一句指令变成了在旁路上解释自己传了什么。上传一张照片更糟：模型只能通过 `read_image` 读到它，而这条路径在路由没有声明图像输入时会在请求之前就拒绝——登记在租户模型注册表里的路由根本没法声明，因为注册表的模型记录压根没有模态字段，模型发现也把清单公开的模态丢掉了。

部署自己的补救办法——一个配了单独视觉端点的 `tool-vision` 工具——做完之后又被删掉了：它在平台已经提供给用户的注册表之外，多维护一份模型配置、多一个模型必须选对的工具，而内置路径只要路由声明了它接受什么，本来就做得到。

## Decision

**每次装配都读一遍上传目录，并作为动态运行时上下文贡献出去。** `@deepseek-ai/dsh-session-uploads` 监听 `system-prompt/assemble`，用 `ctx.fs` 列出会话的上传目录，往装配的 contexts 里追加一条名为 `context:session-uploads` 的上下文。会话日志因此记下模型看到的那份快照，下一次装配替换它——与其他运行时上下文贡献者同一套「模型可见 ⟺ 有日志」安排。

**目录按 Provider 服务的会话目录来定位。** 监听器用会话自己的 `cwd` 解析 `uploads`，`fs-container` 凭循环已经建立的 initiator 得到 `/sessions/<会话 id>/uploads`，部署不需要配置任何宿主路径。`directory` 与 `maxEntries` 是校验过的 `Config` 字段（`uploads`、`40`）；会逃出会话目录的名字，或不是正整数的上限，都在加载时失败。

**没有东西可读时跳过，而不是编一份出来。** 目录不存在、路径不是目录、装配没有会话、以及 `FsError`，一律贡献空字符串，而空字符串根本不贡献上下文小节；其他失败照常抛出，Provider 坏了要被报出来，而不是被说成「没有文件」。从没收到过文件的会话不花 token，也不动缓存。

**模型自己声明它接受的请求模态，注册表与路由两处都是。** `LlmStoredModel.inputModalities` 与 `LlmDiscoveredModel.inputModalities` 接受 `text`/`image`；取值在存储处（一条持久记录）校验，存在时脱壳写进 pi-ai 的 `Model.input`，不存在则留空，让已安装目录与路由的 `defaultInput` 继续按原样解析。发现读取 OpenRouter 的 `architecture.input_modalities` 拼法以及顶层变体，本版本服务不了的模态直接丢掉，而不是让整个条目失败。这一条扩展了 `[[2026-08-12-pi-ai-route-default-input-modalities]]`——解析链本身没变，新增的是存储的注册表行与清单公开值现在能喂进这条链。

租户应用默认把 `session-uploads` 挂进自己的清单，位置在 `tool-fs` 旁边、`agent-instructions` 之前。

## Alternatives considered

- **在用户消息里点名文件。** 业务侧知道自己传了什么。否决原因：每个调用方都得自己往提示词里拼文件列表，模型往目录里写之后那份列表就过期了，而任何人写的消息仍然无法回答「这个会话里有什么」。
- **只在第一轮列一次目录。** 每次装配省一次 `listDir`。否决原因：会话中途到达的上传——「这份也看一下，和刚才那份比一比」这类最常见的情形——会看不见，模型也没有再问一次的入口。
- **每次上传写一条会话事件。** 写入方在 harness 之外，这条事件要么变成字节通道必须自己维护的第二条写路径，要么变成这个插件从它本来就要列的目录里推断出来的东西。目录就是记录，快照说明当时里面有什么。
- **保留配置化视觉工具。** 对「部署就指一个视觉端点」的场景够用，也不需要声明模态。否决原因：它让模型多选一条行为不同的读取路径，在平台已经暴露给用户的注册表之外重复一份凭据与模型选择，而且对「路由只要声明就由内置路径处理」的普通图像场景毫无帮助。
- **把新注册的模型默认成 `[text, image]`。** 按路由层那条 Note 的理由否决：多声明会放行 Provider 在轮中途拒绝的图像，而此时消息已经持久提交，会话就被卡住了。少声明会以点名模型与补救办法的方式拒绝。

## Consequences

有上传的会话，每次装配多一次目录读与一次 `stat`；没有该目录的会话只多一次失败的 `stat`。

清单是快照，不是到达记录：两次装配之间落盘的文件出现在下一份清单里，没有事件说明它何时到的；名字里同时含 `{{` 与其后 `}}` 的文件会让那次装配失败，因为上下文文本在交给模型之前会做提示词变量插值。两件事都写进了包的 Known Limitations。

对注册表记录或清单里都没有模态的模型，声明模态现在是部署的事——包括租户宿主上那些 `dmxapi` 视觉模型。在记录声明 `image` 之前，`read_image` 仍会在请求之前以 `does not declare image input` 拒绝；这是正确的拒绝，而补救办法现在就在模型自己那行注册表记录里，且有文档。

## Testing

`packages/context/session-uploads/tests/uploads.spec.ts` 在临时工作区上组合真实的 `SessionStore`、`SystemPrompt`、`AgentRegistry` 与 `LocalFileSystem`，然后装配提示词并读回贡献的运行时上下文：有上传的会话列出它、没有该目录的会话不贡献、目录位置是普通文件时不贡献、没有 agent 的装配不贡献、配置的目录与上限生效、两次装配之间上传的文件出现在第二份里、`FsError` 得到空清单而意外错误照常抛出、销毁插件 fiber 后贡献消失。`tests/listing.spec.ts` 钉住渲染文本、二进制单位与截断计数。`packages/tenant/tenant-app/tests/app.spec.ts` 断言清单行未停用且取插件默认值。

模态字段由 `packages/llm/llm/tests/provider-store.spec.ts`（拼法与空列表拒绝）、`packages/llm/llm-pi-ai/tests/discovery.spec.ts`（两种清单拼法、未知模态丢弃）、`packages/llm/llm-pi-ai/tests/tenant-registry.spec.ts`（声明值进到 pi-ai 模型，未声明则保留目录值）覆盖。
