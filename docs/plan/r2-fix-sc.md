# R2 修正 SC 清单（修复编排 v2 → v3）

> 来源: gpt-5.6-sol/xhigh R2 对抗审查 verdict=REQUIRES_CHANGES，七条 P1。
> owner 指令（2026-08-01）: 按修改意见优先级提炼 SC，用 goal skill 执行全部修正。
> 执行纪律: 每条 SC 必须有 PASS 证据（fixture 实测，不接受"读代码觉得对了"）。

## 优先级排序依据

P0 = 安全（能误删用户数据）→ 立即修，与方向决策无关
P1 = 直接破 owner 验收口径（"该并行必须并行"有合法绕过路径）
P2 = 结构性（不修则继续在 seam 里长新洞）
P3 = 契约一致性（不修则 live 上线即全 degraded）

---

## SC-1 [P0] cleanupRun 的 rmSync fallback 不得删除未登记目录

- **改什么**: `scripts/fix-orchestrate.mjs:123-128` 删除 raw `rmSync(recursive,force)` 兜底；
  改为只回收「本 run allocation 登记过 且 出现在 `git worktree list --porcelain` 里」的路径；
  归属不符 → fail-closed 报错，不删。
- **什么该成立**: 传入一个未登记的 worktreeRoot（如 `/tmp/无关目录`）时，cleanup 不删除该目录内容，
  并返回归属校验失败；正常 run 的 worktree 仍能被回收。
- **怎么验证**: fixture 造「未登记目录含哨兵文件」→ 调 cleanupRun → 断言哨兵文件仍存在且返回错误；
  另测正常 allocate→cleanup 仍回收干净。

## SC-2 [P1] 编排闸不可省略（消除 fix_orchestration 旁路）

- **改什么**: `scripts/push-guard.mjs:56-69`。不再由 manifest 自报决定是否核验。判据改为**从 artifact 派生**:
  终版 artifact 的 `canonical_findings` 非空（即本次评审确认过 finding）→ **强制**要求 `fix_orchestration`
  四件套齐备并全部核验；缺失 → fail-closed。仅「首轮零 finding 直接 APPROVED」允许无编排链。
  同时删除 `sc_hash`/`sc_list` legacy 协议（feature/evolution 一律用 schema 化 `sc_manifest`）。
- **什么该成立**: 有 finding 的 PR 省略 `fix_orchestration` → push 被拒；零 finding 的 PR 无需编排链照常放行。
- **怎么验证**: fixture「有 finding + 省略声明 → 必拒」（**替换**当前把"未声明照常放行"写成正向断言的
  fixture:2718-2720，该断言把缺口固化为预期，必须删）；「零 finding + 无声明 → 放行」。

## SC-3 [P1] 源 artifact 必须 exact parent 绑定（不止同 base）

- **改什么**: consensus-gate 产出的 artifact 增 `parent_artifact_hash`（delta 轮时 = 上一轮 artifact hash；
  首轮 = null），纳入 `consensus_artifact_hash` 计算。push-guard `:224-227` 改为校验
  `sourceArtifact.consensus_artifact_hash === finalArtifact.parent_artifact_hash`（exact），
  删除仅比 base_sha 的检查与其误导性注释。
- **什么该成立**: 拿同一 base 的**另一份**源 artifact 冒充 → 拒。
- **怎么验证**: fixture 造两份同 base 不同 candidate 的源 artifact，用错的那份 → 必拒；用对的 → 过。

## SC-4 [P1] SC 与 actionable finding 一对一双射（消 mega-SC 退化）

- **改什么**: `scripts/sc-coverage-gate.mjs:34-54`。非 global SC 必须**恰好引用 1 条** finding；
  每条 blocker/major finding 必须**恰好被 1 条** SC 引用（无重复覆盖）。多步骤修复写在 SC 的
  change/holds 文本里，不得借 finding_ids 合并。同时把 schema 的 id 格式/kind 枚举/必填字段
  在 validator 里真正执行（当前 schema 未被任何代码校验）。
- **什么该成立**: 一条 SC 引用 3 个不相交 finding → 拒；同一 finding 被两条 SC 引用 → 拒；
  一对一 → 过且 fix-plan 算出 3 组并行。
- **怎么验证**: fixture 三个不相交 major finding：mega-SC 必拒、重复覆盖必拒、一对一 → groups=3。

## SC-5 [P1] canonical severity 取 origins 最高（消降级绕过）

- **改什么**: `scripts/consensus-gate.mjs:109-116` 当前取首个 origin 的 severity。改为取同簇所有 origin
  的**最高**严重度（blocker > major > suggestion）。
- **什么该成立**: 同簇一席报 suggestion、一席报 major，无论输入顺序，canonical 恒为 major（因此被
  coverage gate 强制覆盖）。
- **怎么验证**: fixture 两种输入顺序各跑一次，canonical severity 均为 major 且 coverage 强制其覆盖。

## SC-6 [P1] capacity 不得由 lead 自报；批次必须 canonical partition

- **改什么**:
  (a) capacity 来源改为 `config/orchestration.json`（新增，含 `max_parallel_workers`），planner 与
      push-guard **各自独立读取**并校验为正整数 ≥1，不从 plan/record 回灌（删 `Number(args.capacity ?? 8)`
      的自报路径与 push-guard `:234` 的 `fixPlan.capacity` 信任）。
  (b) `scripts/fix-dispatch-gate.mjs:71-84` 批次校验升级为确定性 canonical partition:
      batches 的组集合与 planned **exact 相等**、批数 == `ceil(N/capacity)`、除末批外每批 size == capacity、
      N ≤ capacity 时必须恰一批含全组。消除 singleton batches 与幽灵 id。
      同时消费 `n_min_per_wave`（当前从未使用）。
- **什么该成立**: capacity=1 + 3 独立组 + `[[g1],[g2],[g3]]` → **拒**（当前放行 = 合法全串行）；
  合法 partition → 过；幽灵 id / 缺组 / 非满载中间批 → 拒。
- **怎么验证**: fixture 复现 reviewer 的 capacity=1 全串行攻击必拒；正例 5 组 capacity=2 → 批次
  `[[a,b],[c,d],[e]]` 过而 `[[a],[b],[c],[d],[e]]` 拒。

## SC-7 [P1] verify SC 按冲突图分组（不得强制合成单 worker）

- **改什么**: `scripts/fix-plan.mjs:76-83`。verify SC 也走 union-find 冲突分组，末波内**保持多组并行**；
  仅文件域相交的 verify SC 才同组。另: `kind` 不再纯信 lead——verify 组在集成时必须
  实改仅落在测试路径（由 orchestrator 校验 actual diff，见 SC-8）。
- **什么该成立**: 两个互不相交的 verify SC → 末波 2 组并行（当前被合成 1 组，直接违反 owner 口径）。
- **怎么验证**: fixture 两个独立测试路径 finding → `waves[last].length === 2`。

## SC-8 [P2] 有状态 orchestrator: run manifest + CAS 波次基线 + tip 归属 + 自动串行重跑

- **改什么**: 重构 `scripts/fix-orchestrate.mjs` 为持有 **run manifest**（`<state>/run-<id>.json`，
  hash 链 append 事件）的单入口编排器:
  (a) run manifest 记录 `source_candidate / plan_hash / waves[].base / waves[].allocations / waves[].tips /
      waves[].integrated_tip / validation`，每次状态推进原子写 + prev-hash 链;
  (b) **CAS 波次基线**: wave0 base 必须 == plan 绑定的 source candidate；wave k+1 base 必须 == manifest
      记录的 wave k `integrated_tip`（**脚本强制，不接受 caller 传任意 SHA**——修 R2-P1-4 的"仅靠 caller 传对"）;
  (c) **tip 归属校验**: 每组 tip 必须 == 该组 allocation 分支的 HEAD、必须 ≠ base（非空交卷）、
      实改文件必须 ⊆ 该组 `allowed_paths`（verify 组额外要求全为测试路径）；组集合必须与 planned exact 相等
      （拒缺组/幽灵组/重复组）;
  (d) **专用 integration worktree/分支**（不再在主 repoDir `checkout --detach`），集成完把 integrated_tip
      回接 feature branch，使 push-guard 的 `branch ref == expected_sha` 自然成立（当前需 lead 私改 ref）;
  (e) **overlap 自动串行重跑**: 检出实改交集 → 在最新 tip 上把碰撞组依次串行重跑（不再只 return false
      让恢复路径死掉），事件写入 run manifest。
- **什么该成立**: 传错 wave2 base → 拒；tip 非分支 HEAD/空交卷/越域 → 拒；overlap → 自动串行重跑并
  在 manifest 留痕；集成后 feature branch ref 指向 integrated_tip。
- **怎么验证**: fixture 真 git repo 覆盖: 错 base 必拒、subset/ghost tips 必拒、越域 tip 必拒、
  overlap 自动重跑后集成成功、branch ref 正确前进。

## SC-9 [P2] push-guard 验最终 DAG lineage（防集成后私补代码）

- **改什么**: push-guard 增: final candidate SHA 必须 == run manifest 的最终 `integrated_tip`；
  且 final tip 的祖先集合必须只由「已登记 group tips + 规定 merge commits」构成——lead 在集成分支
  私自追加 commit → 拒（R1 提过、R2 判为本轮必修）。需 push-guard 读 run manifest（新增
  `--run-manifest`），并把 `run_manifest_hash` 纳入 `fix_orchestration`。
- **什么该成立**: 集成后 lead 追加一个 commit 再 push → 拒；未私补 → 过。
- **怎么验证**: fixture 真 git: 正常链过；集成后 `git commit` 一笔再验 → 必拒。

## SC-10 [P2] 交卷材料结构化 + verify 复跑（消 report='FAIL' 也过）

- **改什么**: `fix-dispatch-gate.mjs:66-67` 当前只要 40hex tip + 非空 report。改为要求结构化
  `result: {status: 'PASS'|'FAIL', sc_results: [{sc_id, status, evidence}]}`；status ≠ PASS 或任一
  sc_result 非 PASS → 拒。orchestrator 在集成后**复跑**各 SC 的 verify 命令并把结果写 run manifest
  （不信 worker 自报）。
- **什么该成立**: `report='FAIL'` / 缺 sc_results / sc 状态不全 PASS → 拒；orchestrator 复跑失败 → 拒集成。
- **怎么验证**: fixture 覆盖 FAIL 交卷必拒、缺结构必拒、复跑失败必拒。

## SC-11 [P1] anchor_paths 广域污染防护

- **改什么**: `verdict-validate.mjs:121-124` 落地 plan 承诺但未实现的 tracked 校验:
  新增 `--repo-dir` 时逐条校验路径是 base∪candidate 的真实 blob（非目录——"src" 这类无尾斜杠
  真实目录当前会通过）；schema 加 `maxItems`（可信配置，默认 20）+ `uniqueItems`;
  单条 finding 的 anchor_paths 数量超 cap 或占 changed-files 比例异常 → degraded，要求 origin 席拆分补发。
- **什么该成立**: `anchor_paths: ["src"]`（真实目录）→ 拒；枚举 50 个路径 → degraded；
  正常 1-3 个精确文件 → 过。
- **怎么验证**: fixture 用真 git repo 校验目录路径必拒、超 cap 必 degraded、精确文件过。

## SC-12 [P3] live 契约一致性（否则上线即全 degraded）

- **改什么**: `skills/submit-pr/SKILL.md:53` 仍写 verdict schema **v1**，而 validator 只收 v2 →
  live reviewer 按 skill 产物会全 degraded。改 v2 并补 `anchor_paths` 填写要求（含 references/faces.md）。
  `SKILL.md:126` 仍要求旧 `sc_hash+sc_list` → 与 SC-2 的 sc_manifest 统一。
- **什么该成立**: skill 文档描述的产物形态与 validator/push-guard 实际要求逐字一致。
- **怎么验证**: 新增 contract fixture 读真实 SKILL.md + references，断言不含 `v1`/`sc_list` 旧协议残留，
  且含 `anchor_paths` 与 `sc_manifest`。

## SC-13 [P2] fixture 空转与假证据清理（G 面）

- **改什么**: 按 R2 G 面抽查逐条修:
  (a) 血统测试用不存在的 `'a'.repeat(40)`、`orphanRepo` 创建后完全没用 → 改为**真实存在但不相关**的 commit;
  (b) `before` 变量（fixture:2609）未断言 → 补 HEAD 未变断言;
  (c) push 闸「全齐」用假 tips 且无 integration record → 改为接真 run manifest;
  (d) 补齐 R2 点名缺失的回归: mega-SC、重复覆盖、severity max、广 anchor、错 wave2 base、
      subset/ghost tips、singleton batches、省略声明必拒、同 base 错源、集成后私补代码。
- **什么该成立**: 每条新 fixture 都能在**移除对应修复后失败**（不是空转）。
- **怎么验证**: 逐条自查「注掉修复 → fixture 变红」；全量 run-all.sh 两连一致。

---

## 边界（goal 执行时的禁改项）

- 不改宪法层: `schemas/**` 之外的黑名单路径、`.github/workflows/**`、`config/budget*`
  （注: 本轮 SC-2/SC-3/SC-4 需改 `schemas/`——这是 owner 授权范围内的协议升级，走本 SC 清单）
- 不动 mini runtime 数据、不改 `~/.claude/` live 配置
- 不 push、不建 PR（本轮只在本仓工作区改 + 提交到 main 由 lead 决定）
- 每条 SC 的验证必须是 fixture 实测；`bash fixtures/run-all.sh` 两连一致才算完工
