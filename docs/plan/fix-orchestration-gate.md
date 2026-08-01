# 修复编排门禁方案（Phase 2c 并行/串行机器裁决）

> 起因: 2026-08-01 首个真实 PR 跑批，三席汇总 10 条 SC 后 lead 只派了 1 个 worker 串行吃完。
> owner 目标（原话）: 「保证该并行的时候必须并行，甚至 worker 数量拉满 8 个都可以；但应该串行的时候也必须串行」。
> owner 追问: 「如何防止 lead agent 绕过并行指令？」——散文指令不算防护，必须机器裁决（与本仓
> 「AI 说了不算，脚本裁决」立场一致）。
> 本文档状态: **待对抗审查**（gpt-5.6-sol/xhigh）。未实现，未接线。

## 0. 设计立场

并行/串行不是一个判断，是**两个性质不同的子判断**，必须分开定权威：

| 子判断 | 性质 | 权威 | 理由 |
|---|---|---|---|
| **必须串行**（两组改同一文件） | 确定性事实 | **脚本** | 交给 lead 会漏判 → 并发覆盖写。机器可算，不容裁量 |
| **必须串行**（语义依赖: B 要用 A 新增的接口 / B 验证 A 的产物） | 需要理解代码意图 | **lead 声明** | 脚本算不出。真实案例: SC-5「补 SC-1~4 的联调测试」 |
| **可以并行**（相互独立） | 保守下界可算 | **脚本算下界，lead 只能加不能减** | 单调性红线，见 §2 |

**单调性红线（本方案的核心）**：lead 的自由度只朝「更并行」开放。
- 允许: 把脚本算出的一组**拆成更多组**（lead 看出组内两文件其实不相干）→ 直接放行，不需理由
- 禁止: 把脚本判定为独立的两组**合并成一组串行** → 必须逐对留 `merge_reason` 且记台账
- 这个方向性直接对应 owner 的诉求: 防的是「该并行没并行」，而「该串行必须串行」由脚本的冲突图 + worktree 隔离双重保证

## 1. 前提缺口（必须先补，已实测确认）

**`schemas/review-verdict.schema.json` 的 finding.anchor 是自由文本字符串**（`{"type":"string","minLength":1}`），
不是结构化字段。实测本次真实 verdict 数据的 anchor 形态不一致:
- `server/lib/assetStore.ts:1372` — 可解析
- `docs/decisions/api-surface.md` §4.4 — 勉强
- `migration.mjs:109/121/130` — **无目录前缀 + 多行号，正则解析必 miss**

正则解析 anchor 得到文件域 = 把机器裁决建在猜测上，miss 掉的 finding 落不进任何组，比没有门更糟。

**修法（前置任务，必须先做）**: findings 增加机器字段
```json
"anchor_paths": {
  "type": "array", "minItems": 1,
  "items": { "type": "string", "pattern": "^[^/].*" },
  "description": "该 finding 涉及的仓库相对路径（reviewer 必填，不得为空；目录用尾斜杠）"
}
```
- schema 校验非空 + 每条过路径格式；`verdict-validate.mjs` 对缺失/空数组 fail-closed（degraded）
- 三席派发包同步要求填写（`references/faces.md` 需说明）
- ⚠ `schemas/**` 在宪法黑名单内 → **只能 owner 亲手提交**，自动会话改不了

## 2. 机制清单

### M1 — 冲突图（脚本，权威）
`fix-plan.mjs` 读 SC manifest（每条 SC 绑一条 confirmed finding，携带 `anchor_paths`）:
1. 建并查集: 任两条 SC 的 `anchor_paths` 有交集（含目录前缀包含关系）→ 合并同组
2. 输出保守分组 `groups[]`，每组含 `sc_ids[]` + `paths[]` 并集
3. 无法归类（anchor_paths 缺失）→ **不静默丢弃**，归入 `unclassified` 并使整份 plan degraded（fail-closed）

### M2 — 依赖边（lead 声明，受限）
lead 可提交 `dependencies[]`，每条 `{from_sc, to_sc, kind, reason}`，`kind` 限枚举:
- `needs-api-of` — to_sc 要使用 from_sc 新增的接口/导出
- `verifies` — to_sc 是对 from_sc 产物的测试/验证

**其它 kind 一律拒收**（防「我觉得这样比较稳」式自由裁量）。
`same-file` 类冲突**不需要也不允许** lead 声明——那是 M1 的活，lead 声明它等于试图影响冲突图。

**可机器验证的收紧（待审可行性）**:
- `needs-api-of`: 脚本可检查 to_sc 的 anchor_paths 文件是否 import/require from_sc 的文件（静态 import 图）。无引用关系 → 该依赖边可疑，记台账
- `verifies`: 脚本可检查 to_sc 的 anchor_paths 是否全部命中测试文件模式（`*.test.*` / `*.spec.*` / `e2e/**` / `fixtures/**`）。不命中 → 可疑，记台账

### M3 — 拓扑分波（脚本）
合并 M1 冲突图（无向，强制同组）与 M2 依赖边（有向，跨组）→ DAG → 拓扑分层:
- Wave 1 = 无入边的组，全部**并行**
- Wave k = 依赖已完成波次的组，波内**并行**
- 环 → fail-closed（依赖声明自相矛盾）
- 每波并发上限 8（Orca 硬上限）；组数 > 8 时波内**分批**，不降并行度只排队

真实案例映射: SC-1~SC-4（四个不同模块）= Wave 1 四组并行；SC-5（补联调测试，`verifies` 依赖 SC-1~4）= Wave 2 单组。

### M4 — 派发数量门（脚本，事后校验）
`fix-dispatch-gate.mjs` 读 plan + lead 提交的 `dispatch_record`:
- 每波: `实际 distinct worker 数 >= min(该波组数, 8)`，否则 fail-closed
- 每组必须有**真实 worker 回报**（session_id + 交卷内容）才计数——伪造的 worker 不产出报告
- 合并独立组 → 必须逐对 `merge_reason`，写入 E 通道台账（重复出现 = 分组启发式不准的自进化信号）

### M5 — 隔离取代域强制（安全机制）
每个并行 worker **独立 git worktree**（从 candidate SHA 切，复用仓内既有 worktree 基建）:
- 并发写危险从构造上消失（不是靠事后检查）
- 各 worker 跑 scoped 验证不互踩 `.tsbuildinfo` / 测试库 / dist
- lead 逐个 merge 回集成分支——**git merge conflict 就是真实碰撞检测器**，不是预测
- 全量 tsc/lint/test 由 lead 在集成后**统一跑一次**（不是每 worker 各跑一遍）

**明确否决**: 上一版方案的「越域即败」作为安全机制不成立——它是 commit 前的事后检查，覆盖写已发生；且会在合法工作上误伤（修 `documentSlice.ts` 语义必然要动 `documentSlice.persist.test.ts`，锚点里未必有）。一个在正常工作上频繁 fail 的门最终会被绕过。可保留为**软告警**（越域记台账），不作阻塞。

### M6 — 挂进 hash 链（唯一真正「防」得住的钩子）
现有链: `review_input_hash → consensus_artifact_hash → 修复 manifest → push manifest`（push-guard 全程重算）。
新增两段:
- `fix_plan_hash` = hash(consensus_artifact_hash + canonical(groups) + canonical(waves) + canonical(dependencies))
- `dispatch_record_hash` = hash(fix_plan_hash + canonical(每组 worker session_id) + canonical(merge_reasons))

两者成为 **push manifest 必填**，push-guard 重算校验。效果: 绕过并行 → 拿不到合法 hash → **push 被拒，走不到 Phase 3**。
复用已被 12 轮对抗验证的机制，不新造独立门。

## 3. 保证等级（诚实声明，不得对外美化）

**S2 口径: 可检测，非不可能。**
- `dispatch_record` 由 lead 自报，脚本观察不到 Orca MCP 调用 → **做不到「派发时不可能」**
- 硬化点: 每组必须有真实 worker 回报才计数（伪造 worker 无报告）+ 缺合法 hash 则 push 被拒
- 结论: 能做到「lead 串行塌缩 → 事后必被检测 + push 不出去」，做不到「lead 无法声称自己并行了」
- 与 push-guard 现有口径一致（本地守卫可检测，服务端 ruleset 兜底）

## 4. 成本（owner 已知悉「不设上限」，但需记账）

N 个 max 档 glm-5.2 worker 并发 ≠ 免费。10 条 SC 拆 5 组 = 5 个 max 档会话。
**当前 `提交 PR` 本机侧没有预算记账**（$30/天闸只管 mini 盯梢侧）。
建议: `dispatch_record` 留一笔用量字段（不设闸，只留账），便于事后审计。

## 5. 待审问题（给 reviewer 的靶子，请穷举攻击）

1. **全串行绕过**: lead 可否把所有 SC 声明成链式 `needs-api-of` 依赖，造出 N 个 wave 每波 1 组、且每步都有「合法理由」？M2 的 import 图验证能挡住多少？剩余缺口如何补（wave 数 > 模块组数时的告警阈值是否够）？
2. **anchor_paths 污染**: reviewer（或伪造 verdict）把所有 finding 的 anchor_paths 都填成 `src/`（目录前缀）→ 冲突图全连通 → 合法单组串行。schema 层能否拒？（禁止过宽的顶层目录？如何定义「过宽」而不误伤真实的跨目录 finding？）
3. **worktree 合并语义**: N 个 worktree 各自 commit 后 lead 逐个 merge，若两 worker 改了同一文件的不同区域（git 能自动合），是否会产生「语义冲突但无文本冲突」的破面？需不需要在集成后强制跑全量测试（已在 M5 要求）之外的额外门？
4. **degraded 传播**: M1 的 `unclassified` 使 plan degraded 后，是否应完全阻断修复（无法派工）还是允许 lead 补齐 anchor_paths 后重算？后者是否给了 lead 编造 anchor_paths 的口子？
5. **M4 计数可信度**: 「真实 worker 回报」如何机器验证？worker 交卷内容由 lead 转述进 dispatch_record，lead 可否编造一份看似合理的报告？是否需要 worker 直接写盘（类似 mini 侧 queue-transport 的 receipt 契约）而非经 lead 转述？
6. **wave 内分批**: 组数 > 8 时分批，第二批是否算「同波并行」？门禁判据 `>= min(组数, 8)` 在分批场景是否可被利用（只派 8 个然后声称剩下的在第二批，实际不派）？
7. **与既有机制的相互作用**: fix_plan_hash 进 push manifest 后，`--fast` 通道（跳三审）是否也要求这两段 hash？fast 场景没有 SC 清单，如何处理（豁免？还是 fast 本就不该有并行修复）？
8. **单调性红线的实现**: 「lead 可拆细不可合并」如何机器校验？给定脚本 groups 与 lead 实际分组，拆细 = lead 分组是脚本分组的细化（refinement）——这个偏序关系脚本可判；但 lead 若同时拆一组又并另一组，能否被单一 refinement 检查捕获？

## 5b. 审查结论 R1（gpt-5.6-sol/xhigh，2026-08-01）

**verdict = REQUIRES_CHANGES**。方向（机器裁决而非散文）认可，但「不能实施并宣称满足 owner 验收」。
§5 八题 reviewer 判定: 挡不住 ×5（1/2/4/5/6）、部分挡住 ×2（3/7）、算法可判但方向错 ×1（8）。

### 已承认的本方案硬错误（非威胁模型分歧，纯逻辑/事实错）

- **E1（对应 P1-4）自相矛盾**: M1 的组由冲突边连成，而 §0 允许「lead 可拆细不需理由」——拆组 = 切冲突边
  = 允许两 worker 并发改同一文件。「可拆细不可合并」这条单调性红线**必须删除**，换成: 冲突边永不可拆、
  独立组不可由 lead 合并或加边（例外只能上游修正证据后重算）。
- **E2（对应 P1-5）wave base 错**: 方案说所有 worktree 从 candidate SHA 切 → Wave 2 的 consumer 看不见
  Wave 1 新增的 API，依赖边形同虚设。正确: 每波集成后以 integration tip 作为后继波 base，`wave_base_sha` 入执行 artifact。
- **E3（对应 P1-5）夸大既有基建**: 「复用仓内既有 worktree 基建」不属实。仓内只有「prompt 要求单个修复
  会话自建 fix-<pr> worktree」+ 单一固定 worktree 的终态清理，**没有** N-worktree allocator / 波次基线 /
  merge coordinator / lineage verifier / crash recovery。Git 原语可做，但是新工程量。
- **E4 §1 例证不准**: `migration.mjs:109/121/130` 的无目录多行写法出现在 markdown 叙述，当前机器 anchor
  实际是 `scripts/e2e/scenarios/migration.mjs:109`。总判断（anchor 不可靠解析）仍成立——反例应改用 upstream 席的
  `docs/decisions/api-surface.md:202-210 (对应 server/routes/assets.ts:321)`（两路径+散文塞进一个 anchor）。
- **E5 capacity 不该硬编码 8**: 应从 orchestrator 运行时读取（reviewer 环境实测公开值与 8 不一致）。

### 意外收获: 既有链的真实漏洞（本方案之外，已复核确认）

`push-guard.mjs:192` 对 SC 只检查 `hashObject(manifest.sc_list) === manifest.sc_hash`（自洽性），
**从未把 sc_list 绑定到 consensus artifact 的 findings**，也不读修复 manifest（`grep fix_manifest` = 无）。

后果: **lead 可以保持同一个合法 consensus_artifact_hash，同时提交一份完全自编的 sc_list（只要自洽）而 push 照过。**
即「共识确认的每条 finding 都被提炼成 SC」这个 Phase 2b 承诺目前**零机器保证**——SC 可漏项、可掺假、可 mega-SC 合并。
这架空的是三审整条价值链，优先级**高于**本并行门。修法: SC coverage gate——从 source artifact 校验所有
actionable canonical finding 被 exact 覆盖，无额外/重复/悬空引用，并把 sc_manifest_hash 纳入 push-guard 重算。

### 待 owner 决策的分水岭（reviewer 明确指出，无法由 agent 代定）

P1-1 的核心: `dispatch_record` 由 lead 自报 → hash 只能证明「这份自报数据前后一致」，不能证明
「真实并发派过这些 worker」。reviewer 结论: **若宿主不提供可鉴权的 batch/session event，不存在任何
仅靠仓内 Node 脚本 + 同权限 JSON 就能达到「防绕过」强度的机制**；此时只能诚实标为「lead 可伪造的审计提示」。

因此必须先定 threat model:
- **T1 = 防疏忽/防漂移**（honest-but-fallible lead）: lead 不撒谎但会因惯性/上下文压力做错（首跑实际就是这类）。
  此模型下 lead 自报 + 数量门是**有效**的——诚实 lead 会如实填，门发现数量不足即 fail-closed 强制回补。
- **T2 = 防恶意伪造**: 需要宿主级可鉴权 receipt。且注意——T2 下既有 verdict/consensus 链**同样不成立**
  （verdict JSON 无签名，恶意 lead 可伪造三席产物；lead 与 owner 同 UID，甚至能直接改 push-guard 本身）。
  即 T2 是全系统性问题，不是本方案的局部缺口。

## 6. 不做什么

- 不实现「最优并行划分」——脚本只算保守下界，最优是判断题
- 不把并行度当 KPI——共享文件的 fix 本就该串行，那不是绕过
- 不给 lead 任何「跳过分组直接派工」的旁路（与裸 ack CLI 已被拆除同理）
