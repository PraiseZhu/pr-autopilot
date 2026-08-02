---
name: submit-pr
description: 提交 PR v2 — push 前三审收口（对抗双审 + 上游预演）+ 共识后自动修复 + push + 注册盯梢。触发词「提交 PR」。
---

# 提交 PR v2（三审收口版）

> 计划依据: pr-autopilot docs/plan.md §0 / SP-1〜SP-6 / §1.1b ①〜⑫。
> 取代 v1 的十维度自审版本。v1 的 `--merge`、Phase 4a 合并确认、Phase 4c 全部
> merge/ready 路径**已删除且不得恢复**（§0.3-F4）——本 skill 没有任何合并能力。

## 总流程

```
Phase 1  预检 + typecheck-merged + 版本 bump（确定性脚本，继承 v1）
Phase 2  三审（push 之前，SHA 绑定 + 盲审；R1 走加固清单穷举）
Phase 2b 共识 → SC 提炼（自动，无需 owner 授权）
Phase 2c glm-5.2/max worker 修复（按类套形状，goal --until-sc）→ delta 复核 → 收敛即收口
Phase 3  同一 worker: push-guard → push → gh pr create/edit → ssh mini 注册盯梢（回执四要素）
```

> **退出判据（2026-08-01 反猫捉老鼠修正）**：对抗审查席结构上**不会**主动给 APPROVED——它的职责
> 就是挑毛病，新代码总有窄面可挑（九轮零 APPROVED 是本质）。收口**仍走** consensus PASS（硬约束，
> 脚本不给旁路），但把 finding 分 `[MUST-FIX]`（改代码）/ `[ARCHIVE]`（写进 README 残余登记即解决）
> 两类——ARCHIVE 类靠**文档化接受**让审查席正当 close，循环因此终止（文档不产生新代码 = 不长新
> finding）。判据见 Phase 2c 收尾。「等一个不会来的批准」的破法是给审查席正当的 close 理由，不是绕闸。

## Phase 1 — 预检（保留 v1 确定性部分）

两仓的具体命令与失败语义见 `references/phase1-checks.md`（审②-I6：不再「继承 v1」一句带过）。

1. 工作区必须在 feature 分支；`git fetch origin` 后 typecheck-merged（与 main 合并模拟后类型检查）。
2. 版本 bump 按各仓 VERSIONING.md。
3. **UI 判定唯一源**（⑫）: 
   ```
   git diff --name-only origin/main...HEAD | node scripts/ui-paths/match.mjs --registry scripts/ui-paths/registry.<repo>.json --files -
   ```
   产出 `{touches_ui, matched_paths, config_hash}` 写入 review bundle。**B 面 n_a 权在脚本不在 reviewer**。
   `touches_ui=true` → demo 证据预检必须过；`--skip-demo-gate` 需 owner 显式理由 + ledger 留痕，用后不得声称"证据完整"。

## Phase 2 — 三审（push 之前）

**定格 candidate**：本地 commit → 工作区 clean → 记 `candidate SHA`。任何后续修改都产生新 SHA 新一轮。

**算输入 hash**：
```
node scripts/review-input-hash.mjs --input bundle.json   # ⑩ 第一段
```
bundle = base_sha + candidate_sha + PR 标题/正文 + touches_ui + matched_paths + ui_registry_config_hash + pr_context_digest（第三席读过的 draft PR 上下文快照；无 draft PR 时为空串的 sha256）。

**一次 create_workers 开三席**（模型为 owner 点名，第 0 优先；派发说明带 `(model/effort)`，SP-5）：

| 席 | 模型/档位 | lens | 边界 |
|---|---|---|---|
| ① claude-adversarial | claude-opus-5 / xhigh | 正确性 / 回归 / 影响面 | 盲审：不见其他席 finding |
| ② codex-adversarial | gpt-5.6-sol / xhigh | 安全 / 边界 / 规范 | 盲审：同上 |
| ③ upstream-preview | claude-opus-5 / high | review-pr skill 口径预演（规则遵从/安全隐私门/格式门/产品·架构门语义预判） | **严格只读**：禁止发 GitHub review/评论/合并/标签等一切对外写动作，只产内部报告 |

三席各产两份输出：人读 markdown + **机器 JSON**（`schemas/review-verdict.schema.json` **v2**）。
**v2 必填 `anchor_paths`**：每条 finding 除人读 `anchor` 外，必须给 `anchor_paths: string[]`——
仓库相对**精确文件路径**（POSIX，非目录，去重，≤ config/orchestration.json 的
`anchor_paths_max_per_finding`）。这是修复分组的**唯一机器输入**：填宽了会制造假冲突把本可并行的
修复串行化，填成目录/不存在路径直接 degraded。影响范围说明写 `scope_note`（不进冲突图）。
**`anchor_paths` 只是证据锚点，绝不是写入许可**（2026-08-02 anchor_paths 三用途拆分，源:
mivo-canvas PR #419 实战反馈）：证据可能落在只读症状文件，真正要改的文件可能根本不在证据里——
写入许可另见 Phase 2c 的 `write_paths`（脚本按 SC kind 推导，reviewer/lead 不得填写，
verdict-validate/sc-coverage-gate 对该字段一律拒收）。
- 两对抗席：七面（A 正确性/B UI+无障碍/C 测试/D 文档/E 安全/F 范围/G 声称核实）逐面 `pass/fail/n_a`+证据；B 面仅当脚本判非 UI 才许 n_a。
- 第三席：只填相关 faces（F/G/E/D 为主）+ `gate_checks[]`（产品/架构过程门专用通道，不得用无类型 finding 绕过归属规则）。
- 首轮穷举（④）+ **加固清单覆盖率契约**：R1 两对抗席**必须逐条扫** `references/hardening-checklist.md`
  的九类核对点（不是「看到什么报什么」），并在 verdict 里对每一类标 `covered/n_a`——目的是把
  「既有代码的洞」在**一轮**里挖净，而不是分轮细水长流（R3 的 11 条本可更多提前到 R1）。
  后续轮冒出"首轮就能看到但没报"的 → 该席本轮 `degraded`。
- finding 归属（⑪）：恰好一个 `primary_face`；白名单内映射不进任何面 → `taxonomy_gap` + degraded 停轮，禁止丢弃。
- Blocker 白名单（③）：仅 active path 失败 / SC 未达成 / 状态污染 / 安全风险 / 核心验证缺失 / 范围违规可阻塞；风格偏好等只进 Residual Risk 附录，不计入共识。

**lead 职责**：只做争议仲裁（质询 ≤3 轮），**不改代码、不代关 finding、不宣布共识**。
Round 2+ 只对账修复情况 + 审 delta（含 SC/标题/正文/验证声称的元数据 diff，G 面不豁免）；禁止重审未改代码。**收口/螺旋/卡死的判据统一见 Phase 2c 收尾「收敛判据与收口」**（收口仍走 consensus PASS，靠 ARCHIVE 类文档化接受终止循环）。

**共识 = 脚本判**：
```
node scripts/consensus-gate.mjs v1.json v2.json v3.json --bundle bundle.json --repo-dir . --out consensus.json
```
`--repo-dir` 必填（R4-P1）：共识入口自算 `base..candidate` 实改集并校验每条 finding 的
`anchor_paths` ⊆ 实改集——tracked-but-unchanged 的 hub 路径在入口就被拦，不依赖调用方自觉。
四 conjunct 缺一不可（同 input hash / union 每条被 origin close / 三 verdict APPROVED / 全部 gate_checks∈{pass,n_a}）。任何席 degraded 或 schema 不合 → fail-closed。

## Phase 2b — SC 提炼 + 覆盖门（共识后，自动衔接）

**owner 定案：共识 → 修复不需要 owner 授权。**
lead 对共识确认的每条 finding 提炼可验证 SC，产出 **SC manifest**（`schemas/sc-manifest.schema.json` **v2**）：
每条 SC 带 `id / kind(fix|verify|global) / finding_ids[] / change / holds / verify`，manifest 头部绑
**源共识** `consensus_artifact_hash`。SC 例句库见 `references/sc-examples.md`。
**verify 是结构化 argv 配方，不是命令行文本**（SC-R3-4，owner 决策 D2）：
```json
"verify": { "cmd": "npm", "args": ["test", "--", "-t", "archiveCanvas"] }
```
`cmd` 必须是裸程序名（禁路径/前导 `-`），执行走 `execFile(shell:false)` + 最小环境变量——
`a && b`、管道、重定向一律不可用；复合验证**拆成多条 SC** 或写进测试文件。
执行结果只记 exit code + stdout sha256（凭证不落库红线，原始输出不进任何档案）。

**覆盖门（脚本判，修补了「SC 可漏项/掺假」的旧洞）**：
```
node scripts/sc-coverage-gate.mjs --manifest sc-manifest.json --artifact consensus.json
```
每条 blocker/major canonical finding 必须被 ≥1 条 SC 覆盖；悬空 finding_id、漏项、
假绑定（manifest 的 artifact hash ≠ 实际重算值）全部 fail-closed。**lead 不得口头声称已覆盖。**

## Phase 2c — 修复编排（脚本裁决并行/串行）+ delta 复核

**分组不由 lead 判断——由脚本从 finding 的 `anchor_paths` 机器派生**（owner 2026-08-01：
该并行必须并行、拉满 8 个也行；该串行必须串行）：

```
node scripts/fix-plan.mjs --artifact consensus.json --manifest sc-manifest.json --out fix-plan.json
```
- 文件域相交的 SC → **强制同组**（组内串行，单 worker 承担）；互不相交 → **强制拆开并行**
- `kind=verify` 的 SC 自动进**最后一波**（base = 前波集成 tip，故能看见前波产物）
- 缺 `anchor_paths` → plan degraded，**不产出可派工计划**；恢复唯一路径 = 原 origin 席补发
  verdict 重跑 validator→consensus→coverage→plan。**lead 不得代填 anchor_paths、不得拆组也不得合组。**

**修复方设计约束（写代码之前，按类套形状——反补丁螺旋的主闸）**：
派工包必须带上 `references/hardening-checklist.md`，并要求 worker：**动手前先判本 SC 触碰的
代码种类**，命中清单左列任一类 → **上来就套右列的已知正确形状、一次写完**，禁止「先加一个 guard、
被审出来再补第二个」。这是砍掉 B 类 finding（修复引入的新洞）的主手段——R6→R9 四轮全是「删分支」
这一个不可逆操作被拆成四次补丁，若 R6 一次套上「事务 reconciliation」形状，R7/R8/R9 三轮不存在。

**逐波执行（有状态 orchestrator，SC-8：base 由 run manifest CAS 派生，不接受自报）**：
```
# 0) 绑定 plan + sc manifest + 源共识（起点 = 源 artifact 的 candidate_sha，由 artifact 派生
#    而非 CLI 自报——SC-R3-10；此后所有波次 base 都由状态机派生）
node scripts/fix-run.mjs init --state-dir <st> --run-id <run> --repo-dir . \
  --plan fix-plan.json --sc-manifest sc-manifest.json --source-artifact consensus.json \
  --feature-branch <branch>
# 1) 本波分配隔离 worktree（每组一个；base 自动取 wave0=source / waveK=上一波集成 tip）
node scripts/fix-run.mjs allocate --state-dir <st> --run-id <run> --plan fix-plan.json \
  --wave <k> --worktree-root ../.fix-wt
# 2) 按输出的 allocations 一次 create_workers 并行开出（组数即 worker 数，拉满 capacity）
#    每包: 本组 SC 子集 + 自己的 worktree 路径 + anchor_paths（证据/分组输入，仅供参考，
#    不是写入许可）+ write_paths（脚本按 kind 推导的写入约束）+ goal --until-sc
#    worker 在自己 worktree 内 commit：
#      fix 类 write_paths.mode='isolated' —— 不设清单，写入边界只靠独立 worktree +
#        集成期真实 diff 重叠检测兜底（overlap → fail-closed 转串行重派，SC-R3-9）；
#        不会再因「改动不在 anchor_paths 内」被拒——anchor 是证据不是写集（2026-08-02 拆分）。
#      verify 类 write_paths.mode='anchor-test-path' —— 仍要求 changed ⊆ write_paths.paths
#        且全为测试路径（SC-R3-7 加固不变），越域在集成时被拒。
# 3) 集成 = **squash**（owner 决策 D1）: 校验 tip 归属 → 实改交集检测 → 无重叠则 merge 出
#    最终树后用 commit-tree 打成**单个 squash commit**（group tips 永不进最终祖先——
#    中间 commit 藏东西再恢复的「净 diff 洗历史」从构造上无处容身，SC-R3-8）
node scripts/fix-run.mjs integrate --state-dir <st> --run-id <run> --plan fix-plan.json --wave <k>
# 3b) 有重叠 → fail-closed 转**串行重派**（并行产物废弃；不是 cherry-pick 搬旧产物，
#     是 worker 在递进的新 base 上**真实重跑**——SC-R3-9）:
#     循环 { serial-allocate 输出下一组的新 worktree → 重派该组 worker → serial-integrate }
node scripts/fix-run.mjs serial-allocate  --state-dir <st> --run-id <run> --plan fix-plan.json --wave <k>
node scripts/fix-run.mjs serial-integrate --state-dir <st> --run-id <run> --plan fix-plan.json --wave <k>
# 4) orchestrator **自己复跑** 本波各 SC 的 verify（SC-10：不信 worker 自报）——
#    sc manifest 必须与 init 绑定的 hash 一致、本波 SC 集 exact 全覆盖（SC-R3-3），
#    verify 按结构化 argv 走 execFile(shell:false)，只记 exit + stdout sha256
node scripts/fix-run.mjs validate --state-dir <st> --run-id <run> --sc-manifest sc-manifest.json --wave <k>
# 5) 全波跑完收口: 校验每波都通过复跑 → feature branch 前推到最终 integration tip
node scripts/fix-run.mjs finalize --state-dir <st> --run-id <run>   # 输出 run_manifest_hash
```
- **组数门**（lead 派少了直接拦）：
  ```
  node scripts/fix-dispatch-gate.mjs --plan fix-plan.json --record dispatch-record.json
  ```
  每组恰一条派发记录、worker 标识互异（同会话不得兼两组冒充并行）、交卷必须是结构化
  `result{status:'PASS', sc_results[{sc_id,status,evidence}]}`（FAIL/缺结构/单条不 PASS 全拒）、
  批次必须是 **canonical partition**（批数 == ceil(N/capacity)、非末批满载——singleton 批
  全串行会被拦）。capacity 来自 `config/orchestration.json`，**lead 不得自报**。
  保证等级 **T1（防疏忽/漂移）**——如实声明：dispatch record 由 lead 提交，恶意伪造需宿主级
  签名回执，本仓做不到；实测失败模式（lead 老实但按惯性只派一个）本门 100% 拦下。
- 全波集成完 → lead 中央跑一次全量 tsc/lint/test → 新 candidate SHA（== finalize 输出的 final_candidate）
- 收尾 `fix-run.mjs cleanup --state-dir <st> --run-id <run>` 回收本 run 全部 worktree/分支——
  回收对象**只从 run manifest 的 allocation 记录枚举**（caller 不传路径/plan），每项做
  git 登记 + common-dir 归属 + 检出分支三重校验，归属不符连分支都不删（SC-R3-1）

新 candidate SHA 后 → **三审 delta 复核**：
- 两对抗席只对账 findings 修没修 + delta 有无新问题，禁重审未改代码；
- 第三席对每个新 candidate 做只读 gate replay 出新 verdict（**不计对抗轮次**）；
- 重跑 consensus-gate 绑定三份新 verdict。

**收敛判据与收口（反猫捉老鼠核心）**：
> 前提认清：对抗审查席**结构上不会主动给 APPROVED**——它的职责是挑毛病，新代码总有窄面可挑。
> 但收口**仍必须走** consensus-gate PASS（全 APPROVED + 全 finding closed）+ push-guard——这是硬约束，
> 脚本不给旁路（`consensus-gate` conjunct②③ + push-guard `gate_result==pass`）。**不存在 lead 越过审查席
> 直接发车的路径**，写「不等 APPROVED 就 push」= 文档骗自己（正是加固清单第 7 条的坑）。
>
> 真正的解法不是绕闸，是**让审查席有正当理由 close**：把 finding 分两类处置，`[ARCHIVE]` 类的
> **修复动作本身就是"写进 README 残余登记"**（文档化接受即解决，R9 已实证此路径）。

每轮 delta 复核，审查席对每条存活 finding 标 `[MUST-FIX]` 或 `[ARCHIVE-eligible]`：

1. **`[ARCHIVE-eligible]` 判据**（四条全中）：① 窄面（不改主要控制/数据流，只是并发窗口/异常路径的窄角）；
   ② 限于**本修复周期新写的代码**（git 可查，不是既有面）；③ 非数据损失、非泄密、非安全绕过、
   非 active-path 失败、非 T2 冒充；④ 审查席给出了**它自己建议的残余登记文案**。
2. **ARCHIVE 类的收口**：把该文案**逐字写进 `README.md` 残余风险登记**（这一步 = 该 finding 的修复，
   不需 owner 授权，同 Phase 2b）→ 下一轮 delta 审查席据此把它 `status=closed`（已由文档化接受解决）
   → consensus-gate 正常 PASS → push。**闸没绕，循环终止**（因为文档化不产生新代码 = 不长新 finding）。
3. **`[MUST-FIX]` 仍须改代码**：回 Phase 2c 头部，**按类套形状重做**（不是打补丁）。
4. **补丁螺旋探测（替代数字轮次上限）**：连续 **2 轮** delta 都「只有窄面 `[MUST-FIX]` 且全打在
   **上一轮新写的代码**上」= 补丁螺旋 → **强制**回「修复方设计约束」把该模块**所有异常出口一次性重写**
   （不是再加 guard）；若本轮已按类重写过仍复现同类窄面 → 该条**降级为 `[ARCHIVE-eligible]`** 走第 2 条。
5. **真·卡死兜底**：`[MUST-FIX]` 的 **blocker/major** 连续 2 轮不减（不是窄面）→ 停，报 owner。

区分：4 治「越修越窄的补丁螺旋」（收敛中，用重写或转 ARCHIVE 了结）；5 治「真修不动」（不收敛，交人）。
**绝不**混为「跑够 N 轮就停」的数字闸——数字闸要么切早漏真问题，要么切晚继续螺旋。

## Phase 3 — push + 注册（lead 指定一个修复 worker 执行；并行场景选其一即可）

worker 收**自包含 push manifest**（repo/remote/branch/**expected_sha**/`purpose=feature`/标题正文/已有 PR 号/注册 key/consensus_artifact_hash/`sc_manifest`+`sc_manifest_hash`/`fix_orchestration` 五件套）。base 不在 manifest 里——由共识 artifact 派生，manifest 无权自定（审②-F4）：

```
node scripts/push-guard.mjs --repo-dir . --manifest push-manifest.json \
  --artifact consensus-final.json --bundle review-bundle.json \
  --source-artifact consensus.json --sc-manifest sc-manifest.json \
  --fix-plan fix-plan.json --dispatch-record dispatch-record.json \
  --run-manifest <st>/run-<run>.json --execute
```
**编排链绑定（SC-2：不是"声明了才验"，而是"有 finding/有 parent 就必须带"）**：
push manifest 的 `fix_orchestration` 五件套 = `{source_artifact_hash, sc_manifest_hash,
fix_plan_hash, dispatch_record_hash, run_manifest_hash}`。守卫**自己重跑** coverage gate +
fix-plan（纯函数重算等价）+ 组数门 + **最终 DAG lineage**（SC-9/SC-R3-8：expected_sha 必须
== run manifest 的 final_candidate；squash 集成下最终历史是线性 squash 链，`source..final`
的每个 commit 必须**精确等于** run manifest 登记的 squash 集合——集成后私补 commit 落在
集合外必拒）。
保证等级如实声明为 **T1（防疏忽/防漂移）**：以上各门拦的是「分组被手改、SC 漏项、派发
不足、集成后私补代码」这类真实发生过的漂移与惯性失误；编排产物由 lead 会话提交，恶意
伪造需宿主级签名回执，本仓做不到、也不冒称做到（与派发门同一口径）。
两份 artifact 不同：`--artifact` 是 delta 复核后的终版（candidate == expected_sha），
`--source-artifact` 是修复**前**的源共识（编排从它算）；两者必须是 **exact parent 关系**
（SC-3：终版 artifact 的 `parent_artifact_hash` == 源 artifact hash，同 base 的另一份冒充被拦）。
（审③-F4-R：bundle 必到场——守卫重算 review_input_hash 并绑定 bundle↔artifact↔manifest 三方 SHA。）
守卫过 → **守卫自己以固定 argv 执行普通 refspec push**（漂移即停，绝不产出待 shell 解释的命令串）→ `gh pr create/edit` → ssh mini：
```
node scripts/pr-watch/register.mjs --state-dir <mini-state> --owner <o> --repo <r> --pr <N> --branch <feature-branch> --push-remote <origin|fork> [--push-repo PraiseZhu/cindy-fork] --verify --lease <lease> --schedule-check "<cmd>"
# 审⑤-F4: --branch 与 --push-remote 必填（mivo: --push-remote origin；cindy: --push-remote fork + --push-repo）——
# 缺任一 register 直接拒绝，杜绝 state.branch=null 的注定失败注册；引擎不猜 remote 名

```
**回执四要素**任一缺失 = 注册失败**显式报 owner**（兜底靠每日卡片补扫，但不静默）。

## 参数

- `--fast`：**只跳三审**；SHA/clean/禁 merge/禁 CI/禁 force 守卫不跳。机器化约束（审④-F2 版）：push manifest `purpose=fast` + `base_branch` + `fast_attestation{reason, ledger_file, expires_at, signature}`；signature = HMAC-SHA256(PR_AUTOPILOT_FAST_KEY, canonicalJson({v:2,purpose,repo,remote,base_branch,branch,expected_sha,reason,ledger_file,expires_at}))——任一受保护字段被改写即失效；expires_at 必须是未来时刻（守卫强制时效）；ledger_file 必须等于 constitution 固定路径；base 由守卫自算 merge-base，manifest 无权自报；留痕由 push-guard 自己写。自动会话拿不到 FAST_KEY 即签不出合法 attestation。
- `--skip-demo-gate`：需 owner 显式理由 + ledger 留痕（⑫）。

## 自进化挂钩（SP-6 / §1.3）

- 远端对通过了本地三审的 PR 打出 finding → E1 漏检台账自动记账（`ledger-append.mjs`，why-class 先 pending）。
- push 后被上游证据门打回 = registry 漏路径 → E2 台账（纯收紧可自动提案补路径）。
- 台账 → 周会（`scripts/evolution/weekly-evolve.md`）→ 提案 PR。红线 R1–R10 机器可查（push-guard --evolution）。

## 明确禁止

- 本 skill 及其派生 worker **没有合并路径**：不 `gh pr merge`、不 mark ready、不设 auto-merge。
- 禁 force-push；禁改 CI 路径 / 分支保护 / ruleset（push-guard 硬拦 + 服务端 ruleset 兜底，S2「可检测非不可能」口径）。
- 第三席全程 GitHub 零写动作（P2 三件套 fixture 验收项）。
