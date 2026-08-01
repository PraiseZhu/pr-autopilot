# 修复编排门禁 v2（Phase 2c 并行/串行机器裁决）

> v1 经 gpt-5.6-sol/xhigh R1 对抗审查 REQUIRES_CHANGES（结论存档于本文末尾附录）。
> v2 吸收全部 R1 结论重设计。owner 目标不变：「该并行必须并行（worker 拉满 8 个都行），
> 该串行必须串行」+ 防 lead 绕过。

## 0. Threat model（owner 已知悉的明示前提）

**T1 = 防疏忽/防漂移（honest-but-fallible lead）。** 如实标注，不冒充 T2。

- T2（防恶意伪造）对仓内脚本不可达：lead 与 owner 同 UID，可伪造任何 JSON 乃至改 push-guard 本身；
  reviewer R1 已证明「宿主不给可鉴权 dispatch event 则不存在同强度的仓内机制」。且既有 verdict/consensus
  链同样是 T1——给并行门单独上 T2 是不对称投资。
- 两个目标的真实强度**不同且如实声明**：
  - 「该串行必须串行」= **构造级硬**：每组独立 worktree（并发写不可能）+ 集成前实改文件重叠检测
    （fail-closed 丢弃重排）。此保证不依赖 lead 诚实。
  - 「该并行必须并行」= **T1 硬**：组数门 fail-closed（疏忽必拦）+ 交卷材料台账（伪造可审计）。

## 1. v1 → v2 的关键改动（对照 R1）

| R1 结论 | v2 处置 |
|---|---|
| P1-4 「可拆细」自相矛盾（拆组=切冲突边） | **lead 分组裁量权归零**：冲突边不可拆、独立组不可合并，merge_reason 逃生门整个删除。例外只有 owner 亲手改 verdict 重跑全链 |
| P1-2 依赖边可用合法枚举串成链 | **砍掉依赖边机器裁决**。唯一保留的顺序规则是脚本可判的确定性规则（§3 verify-wave）；其它依赖不进机器输入——真依赖会以 worker 失败形式可见暴露 → 留痕重排（失败驱动，无撒谎面） |
| P1-1 dispatch_record 自报不可信 | 如实降级为 T1：组数门 fail-closed + 交卷材料存在性 + 台账审计。不宣称防伪造 |
| P1-3 hash 链建在残缺 SC 链上 | **先修既有洞**（§2 SC coverage gate，push-guard 真绑定）；fix_plan_hash 用「重算等价」而非自报（§5） |
| P1-5 wave base 错 + 基建夸大 | wave N+1 base = wave N 集成 tip；worktree 编排承认是新工程（integrate.mjs），不称复用 |
| 前提修法不够（路径污染面） | anchor_paths 只收**精确文件路径**（POSIX 规范化，拒目录/绝对/../反斜杠），并逐 origin 进 consensus artifact hash |
| E5 capacity 硬编码 | capacity 进配置（默认 8 = Orca 硬上限），门只用 min(组数, capacity) |

## 2. 地基（先于并行门，独立价值）

### 2a. schema v2: finding.anchor_paths（机器字段）
- `anchor_paths: string[]`（required, minItems 1）：仓库相对**精确文件路径**。
- 校验（verdict-validate v2，违者 degraded）：POSIX 规范化后拒绝 绝对路径 / `.`·`..` 段 / 反斜杠 / NUL / 尾斜杠（目录不收）；
  可选 `--repo-dir` 时逐条验 tracked（git ls-files base∪candidate）。
- 人读 `anchor` 保留；机器只认 anchor_paths。跨面 scope 走 `scope_note`（自由文本，不进冲突图）。
- 三席派发包/references 同步要求填写。

### 2b. SC coverage gate（修 R1 挖出的既有洞）
现状（已复核）：push-guard.mjs:192 对 SC 仅查 `hashObject(sc_list)==sc_hash` 自洽，**从未绑回 findings**
——lead 可持合法 consensus hash 配自编 SC 清单 push 照过，三审价值链被架空。

修法：
- 新 `schemas/sc-manifest.schema.json`：`{ consensus_artifact_hash, scs: [{id, kind, finding_ids[], change, holds, verify}] }`，
  `kind ∈ {fix, verify, global}`（global = lead 中央验证步，不派 worker，全 plan ≤1 条）。
- 新 `sc-coverage-gate.mjs`：severity ∈ {blocker, major} 的 canonical finding 必须被 ≥1 条 SC 覆盖；
  finding_ids 无悬空/无重复引用歧义；fix/verify SC 必须引用 ≥1 finding；manifest.consensus_artifact_hash
  必须等于实际 artifact 重算值。任一违 → fail-closed。
- push manifest 的 `sc_list/sc_hash` 升级为 `sc_manifest` + `sc_manifest_hash`；push-guard **在场重跑
  coverage gate**（它手里有 artifact），不再只查自洽。

### 2c. consensus artifact 携带 anchor_paths
consensus-gate 聚类时把各 origin 的 anchor_paths 并集保留进 canonical finding，随 artifact 内容进
consensus_artifact_hash——下游（SC/分组）换路径即 hash 断裂。

## 3. 分组与波次（fix-plan.mjs，纯函数）

输入：consensus artifact + sc manifest（+ capacity 配置）。**lead 无输入位。**

1. 每条 SC 的文件域 = 其 finding_ids 对应 canonical findings 的 anchor_paths 并集（机器派生，不可自报）。
2. **冲突图**：任两条 fix-SC 文件域相交 → union-find 同组（该串行的部分：组内串行由单 worker 承担）。
3. **verify-wave 规则（唯一顺序规则，脚本可判）**：`kind=verify` 的 SC 全部进最后一波
   （wave_final），其 base = 前波集成 tip。判定材料：kind 字段 + 该 SC anchor_paths 全部命中测试路径
   模式（`*.test.*`/`*.spec.*`/`e2e/`/`fixtures/`）；kind=verify 但路径不像测试 → fail-closed（防用
   verify 位藏实改）。
4. 输出：`{ groups: [{id, sc_ids, paths}], waves: [[groupId…]], n_min_per_wave }`。
   确定性排序（组内 sc_ids 字典序、组按最小 sc_id），同输入必同输出 → **fix_plan_hash 可由任何人重算**。
5. 无法归类（SC 引用的 finding 缺 anchor_paths）→ plan degraded，**不产出可派工的 plan**；
   恢复唯一路径 = 原 origin 席补发 v2 verdict 重跑 validator→consensus→coverage→plan。lead 不得代填。

## 4. 派发与隔离

### 4a. 组数门（fix-dispatch-gate.mjs，T1）
- 每波：distinct worker 数 == min(该波组数, capacity)；组数 > capacity 分批，**每组恰好一次派发记录**，
  批间不重用组；任何组缺派发记录/缺交卷材料 → fail-closed。
- 派发记录（group_id ↔ worker session_id/label ↔ 交卷摘要路径）进台账（append-only hash 链，复用 evolution 基建）。
- 不校验「同时活跃」（T1 边界，如实声明：串行开 8 个 session 满足 distinct 计数是可伪造面，见 §0）。

### 4b. worktree 隔离 + 集成（integrate.mjs，构造级）
- 派工前按 plan 建 `fix/<run>/g<N>` worktree+分支，base = 本波 wave_base（wave1 = candidate；
  wave k+1 = wave k 集成 tip）。worker 只在自己 worktree 内工作、只 commit 不 push。
- 集成：逐组 merge 进集成分支；merge 前先比**实改文件集**（`git diff --name-only base..tip` 两两交集），
  非空交集 → fail-closed：两组产物全弃、标记 replan-serial（重新按单组派发，事件进台账——重复出现
  = 分组启发式不准的自进化信号）。
- 集成后 lead **中央跑一次**全量 tsc/lint/test + 各 SC verify 命令；过 → 新 candidate SHA → 三审 delta 复核（既有流程）。
- 产出 execution record：`{wave_base, group_tips, integration_tip, overlap: [], validation}`，进台账。

## 5. 与 push-guard 的绑定（重算等价，非自报）

push manifest 新增必填（purpose=feature 且 sc 数 ≥2 时）：
- `sc_manifest` + `sc_manifest_hash` —— push-guard 重跑 coverage gate（§2b）
- `fix_plan_hash` —— push-guard 用 artifact + sc_manifest **自己重跑 fix-plan.mjs** 比对 hash
  （plan 是纯函数，重算即验证——lead 改 plan = hash 对不上 = push 拒）
- dispatch/execution 记录**不进** push 门（T1 边界：push-guard 无法验证 worker 真实性，放进去只会
  制造虚假安全感）；它们进台账供审计与自进化。

## 6. 交付物清单

| # | 交付物 | 备注 |
|---|---|---|
| 1 | schemas/review-verdict.schema.json v2（anchor_paths） | 全链 schema_version 升 v2 |
| 2 | schemas/sc-manifest.schema.json（新） | |
| 3 | verdict-validate.mjs v2 | anchor_paths 校验，违者 degraded |
| 4 | consensus-gate.mjs：canonical finding 携带 anchor_paths | artifact hash 语义变更 |
| 5 | sc-coverage-gate.mjs（新） | 修既有洞 |
| 6 | fix-plan.mjs（新，纯函数） | 分组+波次+确定性 hash |
| 7 | fix-dispatch-gate.mjs（新） | 组数门 T1 |
| 8 | integrate.mjs（新） | worktree 编排+重叠检测+集成 |
| 9 | push-guard：sc_manifest 真绑定 + fix_plan_hash 重算 | 替换 sc_list 自洽检查 |
| 10 | skills/submit-pr Phase 2b/2c 重写 + references | |
| 11 | fixtures 全套 + 既有 fixture 适配（artifact 含 anchor_paths 后 hash 变） | |

实施后过 gpt-5.6-sol/xhigh 对抗复审（R2），APPROVED 才接入 live skill。

## 附录 A. R1 审查结论存档（v1 方案，2026-08-01）

<details>
v1 verdict = REQUIRES_CHANGES。五条 P1：P1-1 dispatch_record 自报不可信（无宿主鉴权 receipt 则仅
audit 级）；P1-2 依赖边可合法串链且软告警无效；P1-3 hash 链建在残缺 SC 链上（push-guard 从未绑
sc_list→findings，既有洞）；P1-4 「可拆细」与冲突图自相矛盾；P1-5 wave base 错 + 基建复用不属实。
§5 八题：挡不住×5、部分×2、方向错×1。已承认硬错 E1-E5。reviewer 明确：更小更强 = 砍 lead 自由度
+ 重算等价，而非加自报 hash。v2 全部吸收。
</details>
