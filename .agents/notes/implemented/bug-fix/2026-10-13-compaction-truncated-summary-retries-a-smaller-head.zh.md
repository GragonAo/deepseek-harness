# Agent Note: 压缩在摘要截断时改用更小的头部重试

Status: implemented

[English](2026-10-13-compaction-truncated-summary-retries-a-smaller-head.md) | 中文

## 问题

触及 `maxTokens` 的摘要会抛出带 `MAX_TOKENS` 码的错误，摘要器丢弃整份摘要，而不是落地一份不完整的检查点。表层因此保持不变，于是下一步的压力检查重新测量同一个超阈值表层，并重新选中同一个区间。`compactionRetries` 预算从未生效，因为该失败以异常形式到达，而不是以低于阈值的结果形式返回。每一步都支付一次完整的摘要调用，在同一个上限处截断，毫无进展。

130 服务器上的一次部署锁定了这个循环：会话 `session-8bf5b412-128c-4a04-8587-db274725f370` 记录了 36 个压缩区间，相邻两者之间恰好只有一个已摘要步骤、没有一个间隔两步，其中 21 个区间完全没有 `compaction/summary`，而一个 41.6 分钟窗口内有 14 次连续失败、每次约 130 秒——约占该窗口的 73%。只有在该窗口唯一一次成功之后才恢复进展，那次成功在 8,192 上限下输出了 8,066 个 token。区间只是小幅超出预算，因此截断会以同样的大小永远重复。

## 决定

`compactIfNeeded` 的压力重试会捕获截断，并在下一次尝试前增大保留尾部预算，使重试摘要一个更小的头部。`grownRetainTokens` 将该预算翻倍，并把它钳制在 `thresholdTokens` 以下，从而保持 `resolveCompactSpec` 所断言的不变量：保留尾部达到或超过阈值时，已无头部可供压缩。当已无头部可摘要，或截断在有限次尝试后仍然存在时，重试会带着原有的 `MAX_TOKENS` 码重新抛出，而不是换成通用的超阈值错误。`summarizer.ts` 中的 `isSummaryTruncation` 是截断码的唯一出处，由 `finishError` 与重试循环共用。

## 考虑过的替代方案

- **区间较大时抬高 `maxTokens`。** 该上限是部署对摘要调用所声明的预算，隐式超出它与显式配置归属相矛盾；而足够的取值取决于模型输出容量，本包无法观测。
- **用完全相同的区间与预算重试。** 相同的区间、预算与模型会复现相同的截断，重试只会放大该缺陷已经支付的代价。
- **直接切出更小的摘要区间。** 保留尾部预算本就定义了头部，增大它可复用既有的区间选择与工具调用／结果配对逻辑，而不新增第二条切分规则。
- **把截断的摘要当作可用。** 失败关闭是有意为之：不完整的检查点会静默丢失下一个模型无法恢复的上下文。

## 后果

- 发生截断的步骤只要更小的头部装得下就能落地检查点，而不是在每步耗费一次摘要调用的情况下停摆。
- 额外的调用代价仍由既有的 `compactionRetries` 封顶；本改动不新增配置。
- 截断保持可观测并带 `MAX_TOKENS` 码，而不会被通用的超阈值消息取代。
- 头部无法充分收缩的表层仍然失败，但尝试次数有界，且原因被明确指出。

### 验证

- `npx vitest run packages/compaction/compaction-basic` —— 126 项测试通过，其中四项为新增：对严格更小头部成功的重试、在尝试后仍存在并被原样重抛的截断、已无头部的低于阈值钳制，以及仍与首次尝试不同的零预算重试。
- `npx vitest run packages/compaction/compaction-basic --coverage` —— `config.ts`、`index.ts`、`region.ts`、`summarizer.ts` 逐文件语句、分支、函数与行覆盖率均为 100%。
- `npx tsx scripts/run-oxlint.ts packages/compaction/compaction-basic` —— 0 警告、0 错误；`npx tsc -b packages/compaction/compaction-basic/tsconfig.json` 干净通过。

## 相关

- [`compaction-basic` README](../../../../packages/compaction/compaction-basic/README.md)
- [摘要失败会保留最新持久表层](../../../../packages/compaction/compaction-basic/README.md#known-limitations-and-deferred-work)
