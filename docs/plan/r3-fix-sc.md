# R3 修正 SC 清单（对抗审查第三轮，gpt-5.6-sol/xhigh，2026-08-01）

> R3 verdict: REQUIRES_CHANGES（1×P0 + 9×P1 + 1×P2）。
> owner 决策（Fable 代判，2026-08-01）：
> **D1 集成方式 = squash**——集成时只把验证过的最终树打成 squash commit，group tips 永不进最终祖先；
> overlap 碰撞 → fail-closed + 串行重派（worker 在新 base 上**真实重跑**，不 cherry-pick 旧产物）。
> **D2 verify 执行 = 结构化 argv**——`{cmd, args[]}` 走 execFile(shell:false)，最小环境；
> 结果只存 exit code + stdout sha256，不存原始输出（凭证不落库红线）。

## SC 列表

### SC-R3-1 [P0] cleanup 只认 run manifest allocation 归属
- **改**: `cleanupRun` 不再收 caller 的 worktreeRoot/plan；回收对象只从 run manifest 的
  `waves[].allocations`（+ integration/serial worktree 记录）枚举。每项双重归属校验：
  ① 路径在 `git worktree list` 登记内（realpath 比对）；② 该 worktree 的
  `git rev-parse --git-common-dir` 归属本 repo 且检出分支 == allocation 记录的分支。
  任一不符 → 拒删且**连分支都不删**。`fix-run.mjs cleanup` CLI 只收 `--state-dir --run-id`。
- **立**: 同仓一个「合法登记但非本 run 分配」的 worktree（哪怕路径恰好同名）永不被删。
- **验**: fixture——伪造 registered-not-owned worktree（路径 == 预测名但 manifest 无此 allocation
  / 分支不符），cleanup 后目录+哨兵文件存活、返回 errors 非空。

### SC-R3-2 [P1] integrate/validate/finalize 全程绑定 canonical plan
- **改**: `integrate` 开头加 `m.fix_plan_hash === computeFixPlanHash(plan)` 校验（allocate 已有、
  integrate 漏了）；push-guard 增加逐波集合重放——run manifest 每波的 tips 组集合必须与重算
  plan 的 `waves[k]` exact 相等（subset/ghost/duplicate 全拒）。
- **立**: tampered plan（漏组/幽灵组）在 integrate 与 push-guard 两层都过不去。
- **验**: fixture——R3 反例复刻：canonical [[g1,g2]] allocate 后用 waves=[[g1]] 的 plan 调
  integrate → throw；push-guard 收到漏 g2 的 run manifest → 拒。

### SC-R3-3 [P1] validate 复跑绑定 SC manifest，空跑不算过
- **改**: `initRun` 增收 sc manifest（hash 入 run manifest）；`validateIntegration` 校验传入
  manifest hash == 绑定值，且本波 allocations 的 SC 集必须**全部**在 manifest 中找到并执行
  （缺一 → error，结果空集 → error）；`runManifestHash` 纳入每波 validation 明细
  （sc_id + verify 配方 digest + exit + status），不再只是布尔。push-guard 比对
  `runManifest.sc_manifest_hash === fo.sc_manifest_hash`。
- **立**: 换/空 sc-manifest 无法制造 vacuous PASS；事后换 manifest 会被 push-guard 抓。
- **验**: fixture——validate 传 `{"scs":[]}` → throw（不是 ok:true）；传错 hash manifest → throw。

### SC-R3-4 [P1] verify 结构化 argv：不走 shell、不落原始输出（D2）
- **改**: sc-manifest schema `verify` 从 string 改为 `{cmd: string, args: string[]}`（cmd 禁路径
  分隔符与绝对路径）；`validateIntegration` 用 `execFile(cmd, args, {shell:false, cwd:wt,
  env:{PATH,HOME}})` 执行；evidence 只存 `{exit_code, stdout_sha256, stdout_bytes}`。
  sc-coverage-gate / SKILL.md 同步新写法（复合验证拆多条 SC 或写进测试文件）。
- **立**: verify 串里的 shell 语法不再被解释；run manifest 中不出现命令原始输出。
- **验**: fixture——verify.cmd 含 `;`/空格拼接的注入串按字面参数传递（注入不生效）；
  manifest 里断言无 stdout 原文字段；旧 string 形态 verify → coverage gate 拒。

### SC-R3-5 [P1] anchor 反 hub 污染：changed-set 收紧 + hub 频率门

> ⚠ **本条的 hub 门部分已被取代（历史记录，非现行契约）**：「→ degraded」的阻断后果
> 先被 D1（2026-08-02，可移除性判据）收窄，再被 D2（fable 裁决 2026-08-03）取消——
> 现行为「检测面不变，命中落 plan.parallelism_notes（联合度量）+ 进 fix_plan_hash，
> 不 degraded 不阻断」。下方「验」里的「8 SC 共享单 hub → buildFixPlan degraded」
> 对应的 fixture 已改写为断言「产出 plan + notes 如实记录 7 组损失」。
> changed-set 收紧（①）不受影响，仍是现行契约。
- **改**: ① verdict-validate 有 repoDir 时，anchor_paths 必须 ⊆ `git diff --name-only
  base..candidate` 的实改集（评审锚点必须落在被审 diff 上；影响面写 scope_note）；
  ② fix-plan 增 hub 门：fix SC 数 ≥4 时，任一路径出现在 > `hub_path_max_share`（config，0.5）
  比例的 SC 域中 → degraded，要求 origin 席拆分或移 scope_note。
- **立**: R3 反例（8 findings 共享 .gitignore hub → 1 组）两层都过不去。
- **验**: fixture——8 SC 共享单 hub → buildFixPlan degraded；anchor 指向未实改文件 → validator 拒。

### SC-R3-6 [P1] 删 legacy sc_hash/sc_list，端到端契约 fixture
- **改**: push-guard 删除 `sc_hash + sc_list` 必填与校验；fixtures 里所有 manifest 删旧字段；
  新增端到端契约 fixture：**严格按 SKILL.md 字段清单**构造 push manifest（五件套 + sc_manifest）
  跑真 `checkPushGuard` 全绿。
- **立**: 按 live skill 文档操作的 manifest 能通过守卫（文档≡实现）。
- **验**: 上述契约 fixture PASS；带旧字段的 manifest 不再是任何 fixture 的依赖。

### SC-R3-7 [P1] allowed_paths 全组强制（verify 组不再豁免）
- **改**: `validateTips` 改为：**所有组**先查 `changed ⊆ allowed_paths`，verify 组在此之上
  **叠加**全测试路径要求（修掉 else-if 互斥 bug）。
- **立**: verify 组改 allowed 之外的测试文件也被拒。
- **验**: fixture——verify 组改另一个不在 allowed 的 `.test.ts` → tips-rejected。

### SC-R3-8 [P1] squash 集成：group tips 永不进最终祖先（D1，一刀关三条）
- **改**: `integrate` 无 overlap 路径改为：temp worktree 里 merge 出最终树后，用
  `git commit-tree <tree> -p <waveBase>` 产出**单个 squash commit** 作为 integrated_tip
  （message 记录组/顶点清单）；merge 中间 commit 不被任何最终 ref 引用。
  push-guard lineage 换成**精确集合**判定：`rev-list source..final` 的每个 commit 必须
  非 merge 且 ∈ run manifest 记录的 squash 集（wave integrated_tips ∪ serial round squashes），
  集合双向相等；**删除六行子串启发式**。
- **立**: 「commit1 藏密钥 + commit2 恢复」的净 diff 洗历史在最终历史里无处容身；
  patch-id false positive 问题整体消失；私补 commit 必然落在集合外被拒。
- **验**: fixture——worker 中间 commit 写入敏感串，squash 后 `git log -p source..final`
  不含该串；集成后私补 commit → push-guard 拒；R3 的同 patch 前缀伪装 commit → 拒。

### SC-R3-9 [P1] overlap = fail-closed + 串行重派（真重跑，不搬旧产物）
- **改**: 删除 cherry-pick 串行路径。overlap → integrate 返回 `replan_required` + 事件；
  新增 `serial-allocate` / `serial-integrate`：按确定性顺序每轮给**一个**碰撞组开新 worktree
  （base = 当前链上 tip），worker **重新执行**后按 SC-R3-8 squash 上链；全组完成才置
  integrated_tip。manifest 记录 rounds。
- **立**: 碰撞组的最终产物必然是在最新 base 上重跑出来的（语义不兼容风险由重跑 + SC 复验兜住）。
- **验**: fixture——两组同文件碰撞 → integrate 拒 + replan 标记；serial 两轮重跑后集成成功，
  rounds 记录 base 递进；直接对 replan 波调 integrate → 拒。

### SC-R3-10 [P1] run 起点绑定源共识
- **改**: `initRun` 增收 source artifact：校验 `sourceCandidate === sourceArtifact.candidate_sha`
  且 artifact hash 自洽，`source_artifact_hash` 入 manifest 与 runManifestHash；push-guard 断言
  `runManifest.source_artifact_hash === 源 artifact 重算值` 且 `runManifest.source_candidate ===
  sourceArtifact.candidate_sha`（wave0 base 由此闭合）。
- **立**: A..B 漂移起点后未登记 commit 逃过 lineage 的路径关闭。
- **验**: fixture——init 传非 artifact candidate 的 SHA → throw；run manifest 换起点 → push-guard 拒。

### SC-R3-11 [P2] 主 checkout 零接触 + 单入口
- **改**: integrate 全程不在主 repoDir checkout（squash 用 commit-tree + branch -f，删
  prevHead/detach 逻辑）；删除 `fix-orchestrate.mjs` 的独立 CLI 入口（保留库函数），
  fix-run 成为唯一编排入口。
- **立**: integrate 前后主 checkout 的 HEAD symbolic-ref 不变；仓内不存在绕状态机的编排 CLI。
- **验**: fixture——integrate 前后 `git symbolic-ref HEAD` 一致；`node fix-orchestrate.mjs` 直跑退非零/无 CLI。

### SC-R3-12 [P1] SKILL.md 契约同步 + T1 措辞降调
- **改**: Phase 2c 命令改为 init(--sc-manifest --source-artifact)/allocate/integrate(squash)/
  serial-allocate/serial-integrate/validate/finalize/cleanup(--state-dir --run-id) 全新流；
  verify 写法指南（argv 结构、复合拆条）；`lead 手改分组/漏 SC/派发不足/私补代码 → push 被拒`
  一句降调为 T1 漂移检测表述（与 dispatch 门同一口径）。
- **立**: 文档描述的每条命令/字段与实现一致；无任何 T2 级承诺残留。
- **验**: SC-12 契约 fixture 升级——除 grep 外，按文档命令序列真跑一遍状态机（SC-R3-6 的
  端到端 fixture 覆盖 push 侧）。

## 完工判据

`bash fixtures/run-all.sh` 两连一致全绿；每条 SC 有对应 fixture PASS 证据；
R3 全部 P0/P1/P2 可回链到某条 SC。反空转抽检：SC-R3-1/2/8 各做一次「撤修 → 变红 → 恢复」。

## 边界（与 R2 轮相同）

- 不改 `.github/workflows/**`、`config/budget*`、宪法黑名单路径（`config/orchestration.json`
  本轮授权新增 `hub_path_max_share` 字段）。
- 不动 mini runtime 数据、不改 `~/.claude/` live 配置。
- 不 push、不建 PR（共识达成后由 lead 统一 push）。
