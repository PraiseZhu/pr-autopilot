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
Phase 2  三审（push 之前，SHA 绑定 + 盲审）
Phase 2b 共识 → SC 提炼（自动，无需 owner 授权）
Phase 2c glm-5.2/max worker 修复（goal --until-sc）→ 三审 delta 复核
Phase 3  同一 worker: push-guard → push → gh pr create/edit → ssh mini 注册盯梢（回执四要素）
```

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

三席各产两份输出：人读 markdown + **机器 JSON**（schemas/review-verdict.schema.json v1）。
- 两对抗席：七面（A 正确性/B UI+无障碍/C 测试/D 文档/E 安全/F 范围/G 声称核实）逐面 `pass/fail/n_a`+证据；B 面仅当脚本判非 UI 才许 n_a。
- 第三席：只填相关 faces（F/G/E/D 为主）+ `gate_checks[]`（产品/架构过程门专用通道，不得用无类型 finding 绕过归属规则）。
- 首轮穷举（④）：后续轮冒出"首轮就能看到但没报"的 → 该席本轮 `degraded`。
- finding 归属（⑪）：恰好一个 `primary_face`；白名单内映射不进任何面 → `taxonomy_gap` + degraded 停轮，禁止丢弃。
- Blocker 白名单（③）：仅 active path 失败 / SC 未达成 / 状态污染 / 安全风险 / 核心验证缺失 / 范围违规可阻塞；风格偏好等只进 Residual Risk 附录，不计入共识。

**lead 职责**：只做争议仲裁（质询 ≤3 轮），**不改代码、不代关 finding、不宣布共识**。
Round 2+ 只对账修复情况 + 审 delta（含 SC/标题/正文/验证声称的元数据 diff，G 面不豁免）；禁止重审未改代码。unresolved 连续 2 轮不减 → 停给 owner。

**共识 = 脚本判**：
```
node scripts/consensus-gate.mjs v1.json v2.json v3.json --out consensus.json
```
四 conjunct 缺一不可（同 input hash / union 每条被 origin close / 三 verdict APPROVED / 全部 gate_checks∈{pass,n_a}）。任何席 degraded 或 schema 不合 → fail-closed。

## Phase 2b — SC 提炼（共识后，自动衔接）

**owner 定案：共识 → 修复不需要 owner 授权。**
lead 对共识确认的**每个修改项**提炼一条可验证 SC（改什么 / 什么该成立 / 怎么验证），连同 finding 清单 + bundle 打成修复 manifest，绑定 `consensus_artifact_hash + SC 清单 hash`。
SC 例句库见 `skills/submit-pr/references/sc-examples.md`（E3 自进化的迭代对象）。

## Phase 2c — 修复 + delta 复核

**修复编排由 lead 判断串并行（owner 2026-08-01 拍板：并行 worker 数量不设上限）**：

1. lead 把 SC 清单按**改动文件域**分组：两组触碰的文件互不相交 → 可并行；有依赖关系
   （B 组要在 A 组产物上改）或撞同一文件 → 并入同组串行。禁止两个 worker 碰同一文件。
2. 每组派一个 **glm-5.2** worker（点名 max，模型不支持该档时取其可用上限并留痕），
   一次 create_workers 并行开出；派发包写明：本组 SC 子集 + **允许触碰的文件域清单**
   （越域即失败）+ goal `--until-sc` 修到每条 SC 有 PASS 证据。
3. 并行 worker **只改文件不 commit**（防并发 git 操作互踩）；全量验证不用每个 worker
   各跑一遍——各 worker 只跑自己文件域的定向验证，**全量 tsc/lint/test 由 lead 在全部
   worker 交卷后统一收口跑一次**，过了再按逻辑分组 commit → 新 candidate SHA。
4. 只有一组或 SC 强耦合时退化为单 worker 串行——判断权在 lead，但「10 条 SC 一个
   worker 串行吃完」这种默认必须先给出不可并行的理由。

新 commit 新 SHA 后 → **三审 delta 复核**：
- 两对抗席只对账 findings 修没修 + delta 有无新问题，禁重审未改代码；
- 第三席对每个新 candidate 做只读 gate replay 出新 verdict（**不计对抗轮次**）；
- 重跑 consensus-gate 绑定三份新 verdict。

## Phase 3 — push + 注册（lead 指定一个修复 worker 执行；并行场景选其一即可）

worker 收**自包含 push manifest**（repo/remote/branch/**expected_sha**/`purpose=feature`/标题正文/已有 PR 号/注册 key/consensus_artifact_hash/sc_hash+sc_list）。base 不在 manifest 里——由共识 artifact 派生，manifest 无权自定（审②-F4）：

```
node scripts/push-guard.mjs --repo-dir . --manifest push-manifest.json --artifact consensus.json --bundle review-bundle.json --execute
```
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
