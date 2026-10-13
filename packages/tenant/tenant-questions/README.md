# @deepseek-ai/dsh-tenant-questions

多租户问答通道（`ctx.tenantQuestions`）：它是 [`@deepseek-ai/dsh-user-questions`](../../interaction/user-questions/README.md) 这条能力缝在多租户部署下的 Provider。模型通过 `ask_user_question` 工具提问，本包把提问记成会话事件并挂起等待，业务面通过 [`agent-http`](../agent-http/README.md) 的 `/api` 作答，作答唤醒那次工具调用，模型拿到答案。

## 提问如何到达业务方

每次提问先追加一条 `user-question/asked` 会话事件（`{ id, questions }`），`id` 由本通道签发。业务方有两条读取路径：

- 既有事件流：订阅该会话后，`GET /api/events.mux` 上的 `session/event` 帧逐条推送该事件。
- 兜底查询：`tenantQuestion.list` 返回当前挂起中的提问，用于漏订阅或断线重连之后。

两条事件都是 log-only（与 `approval/*` 同类，不是 surface 事件）：它们不进入模型请求，模型从自己的工具调用知道问了什么、从工具结果知道答案。会话日志是「问过什么、如何结束」的持久记录；挂起表只是本进程的受理窗口。

## 作答

业务面方法与 `/api` 其它方法同一套鉴权：Bearer 令牌 → 解析租户 → 校验成员身份 → 进入 tenant + subject 作用域，因此作答天然被限定在「这个租户的这个主体」范围内。

`POST /api/tenantQuestion.answer` 的载荷是 `{ sessionId, questionId, answer }`，其中 `answer` 为 `{ answers: [{ id, selected, custom? }] }`。载荷只在两种情况下被受理：它指向的提问仍在为该（租户, 主体）等待，且 `sessionId` 正是提问所在会话；每个问题恰好一条答案项，`selected` 只能取该问题自己给出的选项（单选问题至多一个），每项要么选了选项、要么带非空 `custom`。载荷必须完整覆盖该次提问的所有问题——模型一次只等一个整批答案。

受理后本包追加 `user-question/decided`（`outcome: 'answered'` 并带答案）、唤醒工具调用，并返回 `{ questionId, sessionId }`；答案只有在这个事件落进日志之后才算被接受。对不上任何在等待的提问（已回答、已超时、已取消、属于别的主体或别的会话）视同非法载荷：HTTP 200 的 `bad-request` `ServerResponse`，`details.issues` 给出具体问题。日志拒绝这次追加时（例如提问与作答之间轮次已关闭，事件对不再被轮次包住），作答以该失败报错、工具调用以日志自己的失败被释放——不会为一个日志并不承载的判定回报「已接受」。未挂载本通道时业务面返回 503 及纯文本 `question channel is not mounted: <method>`。

## 超时与取消

等待不到答案时，本通道返回显式错误，不猜测、不给默认答案：

| 情况 | 事件 | 工具调用收到的错误 |
|---|---|---|
| `answerTimeoutMs` 到期 | `user-question/decided`，`outcome: 'timed-out'` | `ANSWER_TIMEOUT`，消息说明超时毫秒数并指示模型不要再问、按最佳判断继续并显式说明假设 |
| 工具调用被取消（轮次取消） | `user-question/decided`，`outcome: 'cancelled'` | `ASK_ABORTED` |
| 通道被卸载（插件 dispose） | 同 `cancelled`，尽力记录 | `ASK_ABORTED` |

此外 `ask()` 在记录提问之前拒绝四种无法作答的提问：没带提问所属会话的 agent（`ASK_MISSING_AGENT`）、没有租户/主体作用域（`NO_QUESTION_SCOPE`）、不在开放轮次内（`NO_OPEN_TURN`，审计对必须被轮次包住）、以及问题 id 重复（`DUPLICATE_QUESTION_ID`）。空问题批由能力缝自身拒绝，不会到达本 Provider。

## 方法

| 方法 | 载荷 | 返回值 | 说明 |
|---|---|---|---|
| `tenantQuestion.list` | `{}` | `{ items }` | 该（租户, 主体）仍在等待作答的提问，按提问顺序；每项含 `id`、`sessionId`、`questions`、`expiresAtMs`。 |
| `tenantQuestion.answer` | `{ sessionId, questionId, answer }` | `{ questionId, sessionId }` | 受理一次作答并唤醒工具调用。 |

方法名与载荷校验都由本包拥有（`TENANT_QUESTION_METHODS` 是本包导出的方法表），载具只负责信封与状态码：这与 `/api` 其余方法把方法表放在网关里相反，因为这两个方法只在多租户部署下存在，网关注册表是各部署共享的封闭表。

## 配置

```yaml
- id: tenant-questions
  name: '@deepseek-ai/dsh-tenant-questions'
  config:
    answerTimeoutMs: 60000
```

`answerTimeoutMs` 默认 60000（1 分钟）。它必须小于 `user-questions` 行自身的 `answerTimeoutMs`（多租户编排里默认给到 120000）：seam 更长的期限到期时以 abort 撤回提问，本通道只能记成 `cancelled`，模型看到的是 seam 的 `NO_ANSWER` 而不是本通道的超时原因。

## Model Experience

### ask_user_question waiting and outcomes

#### What the model sees

本包不注册提示词、工具 schema 或工具结果文本。问题出现在模型自己的 `ask_user_question` 调用参数里（该工具的 schema 属于 [`@deepseek-ai/dsh-tool-ask-user`](../../interaction/tool-ask-user/README.md)，见[工具目录](../../../docs/tool-catalog.md#ask_user_question)），答案或错误出现在这次调用的结果里：`ANSWER_TIMEOUT` 的文本写明超时毫秒数，并指示模型不要再问、按最佳判断继续并显式说明假设。

#### Token effect

每次提问零直接 token：`user-question/asked` 与 `user-question/decided` 都是 log-only，不进入请求。等待期间模型不再生成 token——这是设计上的暂停点——答案到达后该工具调用的结果才进入上下文。

#### KV Cache effect

不使任何已可复用的前缀失效：本包不插入、不替换也不改写请求内容，提示词前缀与工具结果文本都由别的包拥有；答案在工具调用与结果之间到达，因此问答本身不改变请求的前缀。

## Known Limitations and Deferred Work

- **挂起表是进程内的，多副本部署需要会话粘性。** 只有持有该轮次的副本能受理答案；副本切换后那次提问只能等到超时。日志仍是持久记录，业务方可以据此重建界面状态。
- **`answerTimeoutMs` 与 seam 期限的先后关系无法在运行时校验。** 两个值来自不同行的配置，配错时表现为模型收到 `NO_ANSWER` 而非 `ANSWER_TIMEOUT`，没有启动期告警。
- **`/api/openapi.json` 不含这两个方法。** 它由网关生成，而网关的方法表对各部署相同；本包的协议参考只有本文件与 `TENANT_QUESTION_METHODS`。
- **本通道不提供提问的富展示。** `ask_user_question` 的 `intent`（如 `plan-review`）原样记入事件，是否渲染由业务方决定；本包不聚合、不推送额外帧。
- **只挂载本通道不构成完整问答能力。** 模型侧还需要 `ask_user_question` 工具行（`@deepseek-ai/dsh-tool-ask-user`），多租户编排在两行都挂载时才成立。
