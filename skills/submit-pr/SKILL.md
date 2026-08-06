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
Phase 1.5 预扫自清洗（haiku diff-scanner 只报可疑点 → lead 核实修机械类 → 有改动则重跑 Phase 1）
Phase 2  三审（push 之前，SHA 绑定 + 盲审；R1 走加固清单穷举）
Phase 2b 共识 → SC 提炼（自动，无需 owner 授权）
Phase 2c 修复 worker（模型见 Phase 2c 修复席表；按类套形状，goal --until-sc）→ delta 复核 → 收敛即收口
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
4. **意图契约校验**（PR-B1，2026-08-06）:
   ```
   node scripts/intent-check.mjs --pr-body <body文件> [--intent-file .pr-intent.md]
   ```
   双载体：worktree 根 `.pr-intent.md`（工作副本）+ PR body 的 `<!-- pr-intent:start/end -->` marker
   区块（**权威副本**——经 `bundle.pr_body` 自动参与 `review_input_hash`，改意图必然换 hash 重审）。
   - exit 0（OK/REBUILT）→ 继续；REBUILT = 本机缺文件，CLI 已**无条件**从 marker 重建落盘（换机场景，无开关）。
   - exit 1（MISMATCH）→ **Phase 1 FAIL**：两副本 digest 不一致，先对齐（改哪边由 owner 意图为准）再重跑。
   - exit 2（MARKER_MISSING/FALLBACK）→ 权威副本未就位：把 stdout 的 marker 区块写进 PR body
     （已有 draft PR 用 `gh pr edit --body-file`；未建 PR 写进 body 草稿文件），然后重跑至 exit 0。
     FALLBACK 生成的意图带 `[auto-generated]` 标注（存量 worktree 兼容）——**同样必须先落 body
     再算 bundle**，fallback 结果一样入锅，不存在「无意图也能进三审」的路径。
5. **规模入口闸**（PR-B2，2026-08-06）:
   ```
   node scripts/size-gate.mjs --repo-dir . --base origin/main [--exemption <豁免json>]
   ```
   统计对 merge-base 的非测试 diff 行数（add+delete；内置排除 ∪ 目标仓 `sizeGate.excludePaths`；
   配置从 **merge-base 树**读取——读候选树会让被测 PR 自带宽配置绕闸（审 B2-F1 实测复现），
   候选侧配置修改合并后才生效；配置缺失默认 800/0.75，**存在但 malformed 则 fail-closed**）。
   - `PASS`（<75% 预算）→ 继续。
   - `WARN`（≥75%）→ 继续，但 lead 必须当场给出拆分规划或写明「为何不拆」进台账——这是 75% 即规划拆分纪律的机器化。
   - `STOP`（≥100%，exit 1）→ **不得进入 Phase 2**：先拆分（拆分列车 playbook），或取得 owner
     **当次**显式豁免——豁免为结构化记录 `{repo, branch, base_sha, head_sha, lineCount, at, reason}`
     落盘并记入 PR body，**绑定 head_sha，改一行即失效**；push-guard 终闸同口径复验（膨胀绕不过）。
   实测依据：规模与 review 轮数是断崖关系（54 行一轮合并 / 292 行 4 轮 / 450 行振荡 8 轮报废；
   本仓 #297 P1a 5662 行事后拆 13 节）。
6. **PR 标题/正文模板合规闸**（D2，2026-08-06）:
   ```
   node scripts/pr-format-gate.mjs --repo-dir . --base origin/main \
     --title "<PR 标题>" --body-file <PR 正文文件>
   ```
   - `PASS` → 继续。`FAIL`（exit 1）→ **Phase 1 FAIL**：按输出的 `missing_sections` / 标题原因
     改正文或标题，重跑至 PASS。`SKIP`（exit 0）→ 目标仓 merge-base 树未声明格式契约，本门
     **无判据**；台账如实记 `format-gate: skipped(无配置)`，**不得**记成"格式检查通过"。
   - 配置源与失败语义同第 5 步（merge-base 树读 `agent-use/docs/pr-rules.json`；缺失 → SKIP；
     存在但 malformed → fail-closed exit 3）。口径刻意对齐 review-pr 的 `context.mjs`
     （第三席的职责就是预演 review-pr 的裁决，口径一致才是正确性判据）。
   > **为什么这道门在 Phase 1，不在审查席**（D2 死锁修复，2026-08-06 实测代价一整轮三席）：
   > 「正文缺一个必填段落」此前只能由第三席判 `format-gate=fail` → conjunct④ 要求全部
   > gate_checks ∈ {pass,n_a} → 共识永不 PASS → **不写 artifact**（实测：fail 时 CLI 根本不
   > 落盘）→ Phase 2b 的 `sc-coverage-gate --artifact` 与 2c 的 `fix-run init --source-artifact`
   > 是硬依赖，参数层就跑不起来 → 唯一出路是改正文 → `pr_body` 在 `review-input-hash` 的必填
   > 字段里 → hash 变 → 三份 verdict 全作废 → 三席穷举重审。**Phase 2「Round 2+ 只审 delta」
   > 在这条路径上够不着**。它是纯字符串匹配、机读真相源已存在、Phase 1 本就有查正文的步骤
   > （第 4 步 marker），放这里代价是零轮审查。**本门不动 conjunct④、不动 `format-gate` 这个
   > gate_id**：第三席照旧填报它，只是"缺必填段落"这个成因在 Phase 1 之后已不可能存在，
   > 该 gate 回到它该管的语义判断上。任何「给 gate fail 开补救口」的方案都要削弱 fail-closed，
   > 本仓禁止。

## Phase 1.5 — 预扫自清洗（haiku，定格 candidate 之前）

目的：把机械类问题拦在三审之前，砍掉整轮「三席全量重读」（2026-08-05 实证：多轮 REQUIRES_CHANGES 相当比例是陈旧注释/漏改引用/测试 import 类，haiku 档即可捕获）。

1. **派扫描员**：`git diff --name-only origin/main...HEAD` 取改动文件，按文件并行派 `diff-scanner` 原生子代理（`~/.claude/agents/diff-scanner.md`，model 钉死 haiku，职责「只报可疑点不做判断」）。每个扫描员输入 = 该文件的完整 diff hunk；输出 = 可疑点 JSON 数组（`{file, line, category, note}`），**禁止 verdict/严重度字段**。
2. **lead 核实并自清洗**：只处理机械类类别（陈旧注释、漏改引用、术语残留、测试 import 缺失、文档声明与实现不符、明显笔误）——lead 逐条核实为真后当场修掉，落**独立 commit**（message 前缀 `chore(prescan):`）。非机械类可疑点只留 lead 台账，**不投喂任何审查席**（v1 边界：预扫清单不进 bundle、不进 review_input_hash、不改派工包结构——座位输入与无预扫时同构）。
2b. **自清洗改了树 → Phase 1 确定性预检必须对新树重跑**：只要 Phase 1.5 产生了任何 commit，进入 Phase 2 之前必须重跑 Phase 1 的 typecheck-merged 与 UI 判定脚本（touches_ui/matched_paths 与 bundle 字段 `ui_registry_config_hash`——即 UI 脚本输出的 config_hash——取重跑结果进 bundle）——candidate SHA 携带的预检证据必须绑定最终树，禁止拿自清洗前旧 SHA 的预检结果进三审。预扫零改动（无 commit）则无需重跑。重跑失败按 Phase 1 失败语义处理（修复后从 Phase 1 重新走），不得带病进 Phase 2。
3. **fail-open**：扫描员超时/报错/输出不合形 → 记台账 `prescan: skipped(<原因>)`，直接进 Phase 2 三审。预扫是增强不是门，任何情况下不阻塞、不构成放行条件。
4. **覆盖义务不缩水**：预扫存在与否不改变三席的 coverage 契约（首轮穷举 + 加固清单十类照旧），扫描员漏报不构成任何席位少看的理由。

## Phase 2 — 三审（push 之前）

**定格 candidate**：本地 commit → 工作区 clean → 记 `candidate SHA`。任何后续修改都产生新 SHA 新一轮。

**算输入 hash**：
```
node scripts/review-input-hash.mjs --input bundle.json   # ⑩ 第一段
```
bundle = base_sha + candidate_sha + PR 标题/正文 + touches_ui + matched_paths + ui_registry_config_hash + pr_context_digest（第三席读过的 draft PR 上下文快照；无 draft PR 时为空串的 sha256）。

**一次 create_workers 开三席**（模型为 owner 点名，第 0 优先；派发说明带 `(model/effort)`，SP-5）。
**三席派工包首段必须原文携带 intent marker 区块**（Phase 1 第 4 步产物；PR-B1）：审查席对每条
候选 finding 先答「它解决的是不是意图目标句里的问题」，范围判断锚定意图——这也是 Phase 2c
意见三分法（修/答/推）的判据源。marker 内容已经由 `bundle.pr_body` 绑进 `review_input_hash`，
派工包里的置顶只是可读性冗余，两者不一致以 bundle 为准。

**派工包机器契约段：脚本生成 + 前置门校验，禁止手抄**（D1，2026-08-06）：
```
# 1) 为每一席生成机器契约段，原文粘进该席派工包（不要手打、不要凭记忆写字段名）
node scripts/dispatch-contract.mjs --emit <reviewer> --round <n> >> pkg-<seat>.md
# 2) 派工包组好后，create_workers **之前**逐席过前置门（缺任一必需字面值即 exit 1）
node scripts/dispatch-contract.mjs --check pkg-<seat>.md --seat <reviewer> --round <n>
```
三席全部 `DISPATCH-CONTRACT-OK` 才允许 `create_workers`。契约内容（必填 faces、第三席的
canonical `gate_checks[].gate_id` 全集、加固清单穷举的强制条件与版本、`anchor_paths` 约束、
actionable 必填字段、finding 禁用字段、**关 finding 的双条件**、域外通道字段名）**全部从
`verdict-validate.mjs` / `lib/hardening-registry.mjs` 的常量派生**——本文档刻意不复述任何一个
字面值，改常量时 emit/check 自动跟上。emit 输出携带 `contract_digest`（契约 spec 的内容 hash），
`--check` 要求它逐字在场且等于当前重算值：**粘贴陈旧契约段会被当场拦下**。

> **为什么这里换成机制、不再加一段提醒**（D1 修法理由）：这类失误已连续发生两次——2026-08-03
> 派工清单漏写 `closed_finding_ids`（代价一次往返，本文档 Phase 2 末尾已为此专门写过一段警告），
> 2026-08-06 第三席拿不到四个 canonical `gate_id` 而自创，`verdict-validate` 判 degraded、
> `consensus-gate` 连跑都跑不起来，**整轮三席作废**。第二次事故本身就是「在文档里写提醒」这个
> 修法的证伪：提醒与 validator 常量是两份数据，任何一侧漂移即复发，而漂移只在收卷时才暴露。
> 换成生成器 + 前置门后，字面值**只有一份**（validator 常量），且检查点从"收卷时"提前到
> "派工前"——两次事故的共同形态（lead 手里没有权威字面值可抄）在构造上消失。
> 保证等级如实声明 **T1（防疏忽/防漂移）**：它不保证审查席真的按契约填报（那仍由
> `verdict-validate` 在收卷时拦），也不防恶意伪造派工包文本。

> ⛔ **派工前强制现读本表（2026-08-05 两次事故后加）**：`create_workers` 调用**之前**必须用工具重新读取
> 本文件的席位表三行，把读到的字面值填进参数，并在派发说明里逐席复读 `(model/effort)`。
> **禁止凭记忆或历史习惯填模型**——`claude-opus-5` 已于 2026-08-05 从三席全部移除（现仅作 seat①
> 质量塌方时的回滚候选，见观察窗条款），但两个会话仍按旧记忆派了 opus-5。若你读到的表与本段
> 描述不一致，以**表为准**并停下向 owner 报告版本异常。

| 席 | 模型/档位 | lens | 边界 |
|---|---|---|---|
| ① claude-adversarial | claude-sonnet-5 / xhigh | 正确性 / 回归 / 影响面 | 盲审：不见其他席 finding |
| ② codex-adversarial | codex/gpt-5.6-terra（骨折）/ xhigh；**条件升档**：本次 diff 路径命中目标仓 pr-rules.json `archGate.corePaths` → 该席 effort=ultra，派发说明标注原因 | 安全 / 边界 / 规范 | 盲审：同上 |
| ③ upstream-preview | claude-sonnet-5 / xhigh | review-pr skill 口径预演（规则遵从/安全隐私门/格式门/产品·架构门语义预判） | **严格只读**：禁止发 GitHub review/评论/合并/标签等一切对外写动作，只产内部报告 |

- **seat② 降级链**：骨折路由报 `BUDGET_MODEL_REQUIRES_API_MODE` → 降 `gpt-5.5 / xhigh`（标准价），派发说明必须标注降级原因，不静默。
- **降档观察窗（2026-08-05 起，连续 5 个走三审的 PR）**：lead 在台账逐席记 **unique-major**（只有该席抓到的 major/blocker 数）。seat① 换 sonnet 后 unique 率塌方（历史基线场均 2+ → 场均 0）→ 该席单席回滚 `claude-opus-5 / xhigh`，其他席不动。回滚对照基线（08-02~05，38 份裁决）：① opus/xhigh 27 major+1 blocker；② sol/xhigh 15+1（独抓率最高）；③ opus/high 12+1。
- **争议仲裁席（L3，按需出场，不常驻）**：仅当 ①同一 finding 两轮 open/维持拉锯、②P0/P1 定性分歧、③对抗反驳终裁 三者之一发生时，lead 加派 codex / `codex/gpt-5.6-sol`（骨折），默认 effort=max，仲裁结论本身被推翻重来才升 ultra；骨折路由报 `BUDGET_MODEL_REQUIRES_API_MODE` → 降标准 `gpt-5.6-sol` 同 effort，标注不静默。**纪律**：仲裁席只产证据与分析内部报告供 origin reviewer 与 lead 参考，finding 仍由 origin reviewer close，报告不进共识判据、不改共识四 conjunct。

三席各产两份输出：人读 markdown + **机器 JSON**（`schemas/review-verdict.schema.json` **v2**）。
**v2 必填 `anchor_paths`**：每条 finding 除人读 `anchor` 外，必须给 `anchor_paths: string[]`——
仓库相对**精确文件路径**（POSIX，非目录，去重，≤ config/orchestration.json 的
`anchor_paths_max_per_finding`）。这是修复分组的**唯一机器输入**：填宽了会制造假冲突把本可并行的
修复串行化，填成目录/不存在路径直接 degraded。影响范围说明写 `scope_note`（不进冲突图）。
**`anchor_paths` 只是证据锚点，绝不是写入许可**（2026-08-02 anchor_paths 三用途拆分，源:
mivo-canvas PR #419 实战反馈）：证据可能落在只读症状文件，真正要改的文件可能根本不在证据里——
写入许可另见 Phase 2c 的 `write_paths`（脚本按 SC kind 推导，reviewer/lead 不得填写，
verdict-validate/sc-coverage-gate 对该字段一律拒收）。
**actionable finding 必须携带 `invariant`+`family_id`**（SC-B1，owner 2026-08-02 D1）：blocker/major
级 finding 除 `anchor_paths` 外，还必须给 `invariant`（≤120 字，一句话「被破坏的不变量」）与
`family_id`（同 verdict 内归族标识，即便只有一处表现也要归——「自成一族」）。**归属发生在 finding
生成时（审查席），不是修复计划时（lead）**：lead 在 Phase 2b 提炼 SC 时只能**逐字复制**这两个
字段，不得自填/改写（sc-coverage-gate.mjs 强制逐字相等，fail-closed）。suggestion 级不强制。
同一 family_id 下的 invariant 必须逐字一致（同 verdict 内自洽，`verdict-validate.mjs` 强制）——
机器只做「格式/引用合法、逐字相等」，「这几处是不是真的同族」永远是审查席的语义判断，机器不裁决、
也不据此合并 SC（D2：family 关系通过字段流转，不通过合并 SC，SC↔finding 双射不变）。
**`family_id` 只是同 verdict 内的本地归组标签，绝不是跨 reviewer/跨 candidate 的身份**（D1，
2026-08-02 gpt 终审阻断修复）：两个不同 reviewer 完全可能各自合法地把同一个标签（比如都叫
"F1"）用来指完全不同的不变量——这在同一份 verdict 内没问题（`verdict-validate.mjs` 只校验
「同一份 verdict 里同一标签的 invariant 必须一致」），但跨 verdict 比较标签字符串毫无意义。
真正跨 reviewer/跨 candidate 可比较的身份是 **`family_key`**（`consensus-gate.mjs` 从冻结后的
`invariant` 文本派生：`fk1-` + sha256(归一化文本)，不截断），只在共识产物（canonical
finding）上出现，不是 reviewer 填写的字段。**verdict 层填 `family_id`，下游（SC manifest 的
`family_key`、`fix-orchestrate.familyContext`、`pr-body.mjs`、repair-mode watermark）一律读/绑
`family_key`**——这条界线是本轮阻断修复的直接原因（gpt 实测复现: 两席各自合法用 F1 描述不同
invariant，被旧实现按标签字符串合并成一族，PR body 只显示了先到的那个 invariant）。
- 两对抗席：七面（A 正确性/B UI+无障碍/C 测试/D 文档/E 安全/F 范围/G 声称核实）逐面 `pass/fail/n_a`+证据；B 面仅当脚本判非 UI 才许 n_a。
- 第三席：只填相关 faces（F/G/E/D 为主）+ `gate_checks[]`（产品/架构过程门专用通道，不得用无类型 finding 绕过归属规则）。
- 首轮穷举（④）+ **加固清单覆盖率契约（机器强制，不是纸面约定）**：R1 两对抗席
  （`claude-adversarial`/`codex-adversarial`）**必须逐条扫** `references/hardening-checklist.md`
  的十类核对点（不是「看到什么报什么」），并在 verdict 里用机器字段
  `checklist_version`（须等于 `scripts/lib/hardening-registry.mjs` 的当前版本）+
  `hardening_coverage: [{class_id:1..10, result:covered|n_a, evidence}]` 逐类标注——目的是把
  「既有代码的洞」在**一轮**里挖净，而不是分轮细水长流（R3 的 11 条本可更多提前到 R1）。
  `verdict-validate.mjs` 对 `round===1` 的这两席强制 `checklist_version` 等于当前值 +
  `hardening_coverage` **恰好 10 项、class_id 1〜10 各恰好一次、`evidence` 非空**——版本不符
  单独报「清单版本过期需重审」（不与「缺 N 项」的普通计数错误混淆，D5：9→10 是 exact 集合变更，
  2026-08-02 SC-B4 迁移，旧的 9 项 verdict 一律拒收要求重审，不静默放行）；缺项/漏项/重复
  class_id 同样一律 schema/跨字段校验失败 → `runConsensusGate` fail-closed（R10-A3：此前只在
  文档里写"必须标"，没有任何字段/校验落地，三份完全不带该字段的 verdict 照样能拿到
  `gate_result: pass`）。第三席与 `round>=2` 不强制（复核轮不必重扫穷举面）。后续轮冒出"首轮
  就能看到但没报"的 → 该席本轮 `degraded`。
- finding 归属（⑪）：恰好一个 `primary_face`；白名单内映射不进任何面 → `taxonomy_gap` + degraded 停轮，禁止丢弃。
- Blocker 白名单（③）：仅 active path 失败 / SC 未达成 / 状态污染 / 安全风险 / 核心验证缺失 / 范围违规可阻塞；风格偏好等只进 Residual Risk 附录，不计入共识。

**lead 职责**：只做争议仲裁（质询 ≤3 轮——这是**仲裁**轮上限，**不计**修复轮/delta 复核轮），**不改代码、不代关 finding、不宣布共识**。
Round 2+ 只对账修复情况 + 审 delta（含 SC/标题/正文/验证声称的元数据 diff，G 面不豁免）；禁止重审未改代码。**收口/螺旋/卡死的判据统一见 Phase 2c 收尾「收敛判据与收口」**（收口仍走 consensus PASS，靠 ARCHIVE 类文档化接受终止循环）。

**共识 = 脚本判**：
```
node scripts/consensus-gate.mjs v1.json v2.json v3.json --bundle bundle.json --repo-dir . --out consensus.json
```
`--repo-dir` 必填（R4-P1）：共识入口自算 `base..candidate` 实改集并校验每条 finding 的
`anchor_paths` ⊆ 实改集——tracked-but-unchanged 的 hub 路径在入口就被拦，不依赖调用方自觉。
四 conjunct 缺一不可（同 input hash / union 每条被 origin close / 三 verdict APPROVED / 全部 gate_checks∈{pass,n_a}）。任何席 degraded 或 schema 不合 → fail-closed。

**delta 轮（verdict `round>=2`）必须加 `--parent <上一轮 consensus.json>`**（SC-3/D8-3）：
```
node scripts/consensus-gate.mjs v1.json v2.json v3.json --bundle bundle.json --repo-dir . --parent prev-consensus.json --out consensus.json
```
漏传即 fail（不是静默记 `parent_artifact_hash: null` 放行——D8-3 之前正是如此，
CLI 用法串写了这条要求但无人执行）。三席 `round` 不一致时按最大值判（fail-closed 方向）。
真首轮（round 1）不传 `--parent` 正常放行，这是刻意保留的——首轮没有上一轮可绑。

> **这道门只覆盖一个方向**：`round>=2` 缺 parent 必拒；反方向「round 1 **带** parent」
> **不拦**。按 Phase 2b/2c 的流程，终版共识的 verdict 本应是 `round>=2`（它审的是 delta），
> 但 `fixtures/run-fixtures.mjs` 里的终版用例用的是默认 `round: 1` 并带 parent。
> 那属于**当时无人校验故未指定**，不是「round 1 带 parent」被认可为合法——真要收紧得先把
> 终版 verdict 的 round 语义定死，属另一条不变量，本轮不扩。同理「三席 round 必须一致」也未实现。

**不检查**（写出来是因为「局部背书」最容易被当成「完整背书」，同 push-guard 如实声明 T1 上限的做法）：
① **不检查代码是否真的修好** —— conjunct② 的 `closed` 只表示「origin 席裁决该 finding 为真实、
同意进 SC 台账」（见上方 `closed` 语义定义），共识 PASS 不代表任何代码已改；
② **不校验下游产物** —— SC manifest 与共识产物的逐字一致由 `sc-coverage-gate` 管、分组与 hub
判定由 `fix-plan` 管、终版 artifact 的 parent 链与 CI 路径由 `push-guard` 管。共识 PASS 只说明
这三份 verdict 之间自洽，**不预示下游任一道门会过**。

> **`closed` 的语义（易误读，显式定义）**：conjunct② 的 `status=closed` 意思是「该 finding 已被其
> origin 席**裁决为真实、且同意进入 SC 修复台账**」，**不是「代码已经修好」**。所以修复**前**的源共识
> artifact 在构造上是存在的（Phase 2b/2c 正是拿它当输入）。误读成「已修好」会推出「源共识不可能存在」
> 的假结论——另一会话 2026-08-02 就这么栽过一次。「共识确认的每条 finding 提炼 SC」这句话本身也蕴含
> 该语义：若 closed = 已修好，这句话就没有对象。
>
> **关 finding 是双条件，改 `status` 一个字段不够**（`consensus-gate.mjs` → `runConsensusGate` 的
> **conjunct②** 那一段；此处一律用符号锚点不写行号——D8-3 插了 12 行后，初版写的 `:115`
> 当场漂成 `:127`，被 gpt 复审逮到，正是本文档反复在讲的「坐标失真」）：
> ```js
> const closed = fd.status === 'closed' && v.closed_finding_ids.includes(fd.id);
> ```
> 该 finding 的 **`status` 必须是 `'closed'`**，**且**它的 `id` 必须出现在**同一份 verdict** 的
> **`closed_finding_ids` 数组**里。缺任一条，conjunct② 即拒——每条漏的 finding 各拒一次。
>
> **`verdict-validate` 不检查这个双向一致**：它的 `closed_finding_ids` 那行只校验它**是个数组**
> （类型），既不检查「`status='closed'` 的 finding 是否在数组里」，也不检查「数组里的 id 是否
> 真实存在」。所以一份只改了 `status` 的 verdict 能拿到 `exit=0 ok`，却在共识处必被拒。
> 顺带：`verdict-validate` 也**不重算** `review_input_hash`（它那行只验是 64 位 hex），重算是
> `consensus-gate` 的 **conjunct①**（源码注释原话「共识脚本必须重算 input hash，不信
> opaque 值」）。**它是单份 verdict 的形状校验器，不做跨席一致性。**
>
> 实测代价（2026-08-03，另一会话）：审查席按指令把 4 条 finding 的 `status` 改成 `closed`、
> 自跑 `verdict-validate` 得 `exit=0 ok`、据此如实报告成功——那份 verdict 跑共识时在 conjunct②
> 上被拒 4 次，白跑一次往返。**审查席没做错任何事**：错在派工清单漏写 `closed_finding_ids`，
> 而自检工具的口径覆盖不到它。所以派工给审查席时，这个双条件必须逐字写进收口清单。

## Phase 2b — SC 提炼 + 覆盖门（共识后，自动衔接）

**owner 定案：共识 → 修复不需要 owner 授权。**
lead 对共识确认的每条 finding 提炼可验证 SC，产出 **SC manifest**（`schemas/sc-manifest.schema.json` **v2**）：
每条 SC 带 `id / kind(fix|verify|global|archive) / finding_ids[] / change / holds / verify`，manifest 头部绑
**源共识** `consensus_artifact_hash`。SC 例句库见 `references/sc-examples.md`。`archive` 的机器契约见
Phase 2c 收尾「ARCHIVE 类的收口」。
**先归因，再写 SC**（SC-B1）：finding 是 actionable（blocker/major）时，提炼 SC 前先看共识产物
（canonical finding）里的 `invariant`/`family_key`——**即便这条 finding 在本轮只有一处表现
（family 里只有它自己），也要把这两个字段逐字复制进对应 SC**，不是「只有多处表现才需要归因」。
**复制的是 `family_key`，不是原始 verdict 里的 `family_id`**（D1）——`family_id` 是 reviewer
席内的本地标签，`family_key` 才是 `consensus-gate.mjs` 从冻结后 `invariant` 派生的跨
reviewer/跨 candidate 身份，SC manifest 的对应字段就叫 `family_key`（`schemas/sc-manifest.schema.json`）。
lead 不得改写这两个字段的文本，也不得借「合并同 family 的多条 finding」把它们塞进一条 SC
（SC↔finding 双射不变，D2）——`sc-coverage-gate.mjs` 会拿 SC 的值与共识产物里冻结的值逐字
比对，任何字段错配/归因漂移一律 fail-closed（D5：机器只验逐字相等，不做恶意检测声称）。
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
- **`parallelism_notes` 非空时 lead 必须读**（D2，fable 裁决 2026-08-03）：hub 命中不再
  degraded（并行度不是正确性属性；机器分辨不出合法同模块耦合与锚点污染），改落
  `plan.parallelism_notes`——每条含联合度量的真实并行度损失（所有命中路径一起移除后分组数
  X→Y）。**动作**：非空 → lead 逐条读，在编排记录（派工说明/PR 正文任一）里写一句确认
  「已读 N 条 parallelism_notes，判定为 <真同模块耦合 / 锚点写宽了需 origin 席拆 finding>」
  后照常派工。它**不改分组、不进 degraded、不阻断**——把它当阻断绕，或当不存在跳过，
  都是错读：前者回到 D2 之前的死锁，后者让「由人看一眼」变成没人看（机器降级为记录的
  前提正是有人读记录）。notes 参与 `fix_plan_hash`：正常链路下删改会被重算检出（T1）。

**修复席表（owner 2026-08-06 定案；派工前强制现读本表，同 Phase 2 席位表纪律）**：

| 席 | 模型/档位 | 边界 |
|---|---|---|
| 修复 worker（Phase 2c 全部并行组 + Phase 2c/3 由 lead 指定其一执行 push） | **取 `orca-fanout/routing.json` 的 `execute` 档三元组**（agent 必须是 `claude-code`——`goal --until-sc` 在 `~/.claude/skills`，换 agent 家族就没有这个 skill） | 只在自己的 worktree 内改动；写入边界见 `write_paths`；不得代关 finding、不得改共识/SC 产物 |

- **本表刻意不写具体模型值**——`routing.json` 是唯一真相源，`node -e` 或 Read 现读即得。复述模型值已出过事故：commit `c57ea43` 专门清掉 `plan.md` 的具体模型值，就是因为「文档复述 + 席位表改了不同步 → 照旧值填错模型」（2026-08-05 两个会话都派了已被移除的模型）。
- **与 Orca 路由表的优先关系（显式写明，防下一个会话判错）**：`~/.claude/rules/agent-dispatch.md` 的权威顺序是「skill 内明确编排 > 任务类型首选规则」。本表**不覆盖** `execute` 档的值，而是**指向**它——所以两者天然不冲突，无需裁决。若将来 owner 要让修复席脱离 `execute` 档，必须在本表写明并说明理由，不得靠某处复述的旧值默认生效。
- 换值的唯一合法路径是 `model-route set 执行 <模型> [effort]`（脚本校验模型存在性/可路由性/枚举，写入前自动备份）；**禁止手改 `routing.json`**。
- 与 mini 盯梢链的修复会话**是两回事**：那条走引擎 schedule 的四元组继承（见 `deploy/README.md`），本表不管它，改本表不改它。

**修复方设计约束（写代码之前，按类套形状——反补丁螺旋的主闸）**：
派工包必须带上 `references/hardening-checklist.md`，并要求 worker：**动手前先判本 SC 触碰的
代码种类**，命中清单左列任一类 → **上来就套右列的已知正确形状、一次写完**，禁止「先加一个 guard、
被审出来再补第二个」。这是砍掉 B 类 finding（修复引入的新洞）的主手段——R6→R9 四轮全是「删分支」
这一个不可逆操作被拆成四次补丁，若 R6 一次套上「事务 reconciliation」形状，R7/R8/R9 三轮不存在。

**接线：命中原子收敛检查点触发条件时的前置动作**——若本 SC 的修复命中
`references/convergence-checkpoint.md` 的任一触发条件（漏了对称的另一半 / 同一判据第 3 处 /
repair-mode watermark 达标，见下方「收敛判据与收口」），worker 必须先完成该文档的原子六件套，
再用 `node scripts/pr-body.mjs ... --checkpoint-json checkpoint.json` 把产出贴进 PR body
**独立的** checkpoint marker 段（`<!-- pr-autopilot:checkpoint:start/end -->`，D4——与
MUST-FIX/ARCHIVE 的不变量锚点段是两对不同 marker，各自独立 upsert、互不覆盖），之后才继续
上面「动手前先判代码种类、上来就套形状」的流程——六件套不豁免套形状，是套形状在触发条件命中
时的前置步骤。

**逐波执行（有状态 orchestrator，SC-8：base 由 run manifest CAS 派生，不接受自报）**：
```
# 0) 绑定 plan + sc manifest + 源共识（起点 = 源 artifact 的 candidate_sha，由 artifact 派生
#    而非 CLI 自报——SC-R3-10；此后所有波次 base 都由状态机派生）
node scripts/fix-run.mjs init --state-dir <st> --run-id <run> --repo-dir . \
  --plan fix-plan.json --sc-manifest sc-manifest.json --source-artifact consensus.json \
  --feature-branch <branch>
# 1) 本波分配隔离 worktree（每组一个；base 自动取 wave0=source / waveK=上一波集成 tip）
#    --artifact/--sc-manifest 改为**必填**（D3，gpt 终审阻断修复）：省略或传真旧版
#    manifest（actionable finding 缺 family_key）一律 fail-closed 抛错，不再静默产出
#    family_context=null——「强制覆盖全部路径」不许有静默退化的口子。
node scripts/fix-run.mjs allocate --state-dir <st> --run-id <run> --plan fix-plan.json \
  --wave <k> --worktree-root ../.fix-wt --artifact consensus.json --sc-manifest sc-manifest.json
# 2) 按输出的 allocations 一次 create_workers 并行开出（组数即 worker 数，拉满 capacity）
#    每包: 本组 SC 子集 + 自己的 worktree 路径 + anchor_paths（证据/分组输入，仅供参考，
#    不是写入许可）+ write_paths（脚本按 kind 推导的写入约束）+ family_context（SC-B1/D3，
#    allocate 现在恰好覆盖全部路径）：本 SC 所属 family（以 family_key 为准）的全部已知
#    manifestation——含各自 finding_id/已分到的 sc_id/anchor_paths + 一段审计指令文本，要求
#    worker 除已点名路径外还要审计该不变量的未点名处，不得只按分给自己的窄路径打补丁）+
#    goal --until-sc
#    worker 在自己 worktree 内 commit：
#      fix 类 write_paths.mode='isolated' —— 不设清单，写入边界只靠独立 worktree +
#        集成期真实 diff 重叠检测兜底（overlap → fail-closed 转串行重派，SC-R3-9）；
#        不会再因「改动不在 anchor_paths 内」被拒——anchor 是证据不是写集（2026-08-02 拆分）。
#      verify 类 write_paths.mode='anchor-test-path' —— 仍要求 changed ⊆ write_paths.paths
#        且全为测试路径（SC-R3-7 加固不变），越域在集成时被拒。
#      archive 类 write_paths.mode='fixed-list' —— changed ⊆ write_paths.paths，值固定为
#        ARCHIVE_PATH（README.md，fix-plan.mjs 脚本给定常量，不从 anchor_paths 派生，
#        全链唯一诚实拥有正向写入清单的场景），改了非 README.md 的文件同样越域被拒（SC-M2）。
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

**PR body 不变量锚点先生成，delta review 才能开始**（SC-B2，时序硬约束）：
`scripts/review-input-hash.mjs` 早就把 `pr_body` 纳入了 `review_input_hash`——这意味着三审审的不
只是代码 diff，也审 PR body 本身。所以在算 delta 轮的新 `bundle`/`review_input_hash` **之前**，
lead 必须先跑：
```
node scripts/pr-body.mjs --artifact consensus.json --sc-manifest sc-manifest.json \
  [--existing-body <当前 PR body 文件>] > new-body.txt
```
把输出写回 PR body（已存在 PR 时用 `gh pr edit --body-file`——`pr-body.mjs` 只做**幂等替换**:
marker 段 `<!-- pr-autopilot:invariants:start/end -->` 内是脚本生成的 MUST-FIX/ARCHIVE 清单
（按 family_key 去重列 invariant + 全部 manifestation；ARCHIVE 措辞是「已登记接受」，不是
「已修复」；不外泄 anchor_paths 之外的证据原文），marker 外的 owner 手写正文原样保留）。
**新 body 定稿后才能把它填进 delta 轮的 `bundle.pr_body` 去算新 `review_input_hash`**——
三席审的必须是含锚点段的这份 body，不是审完之后才补生成。Phase 3 `gh pr create/edit` 只能提交
**这份已审、hash 对得上的 body**；如果审完之后 body 又被改了（哪怕只改了 marker 外的 owner 手写
部分），`review_input_hash` 就变了，视为输入漂移，必须重审——不得「反正锚点段是自动生成的，随时
能重刷」。

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
> **修复动作本身就是"写进 README 残余登记"**，且这条"修复"跟 `[MUST-FIX]` 走**同一条 fix-run
> 编排链**（文档化接受即解决，R9 已实证此路径；R10 把它接成机器可执行的 `kind=archive` SC，
> 不再是「文档说了但脚本走不通」的纸面约定）。

**意见三分法（finding 处置前置定性，2026-08-06 引入；蒸馏自 cindy-git-workflow-skill，经 GPT 审核席共识）**：

每轮收到审查席 findings 后、提炼 SC 之前，lead 对每条 finding 先答一个问题：「它解决的是不是本 PR 意图目标句里的问题？」（意图目标句 = PR body 中的目标描述；intent marker 机制落地后指向 `<!-- pr-intent -->` 区块。）据此三分：

- **修**：同时满足「服务于意图目标句」+「必须留在本 PR」→ 进 `[MUST-FIX]` 链（提炼 `kind=fix` SC，走 fix-run 编排，下述机器契约不变）。
- **答**：误读 / 过时 / 与实现不符 → **不改代码**。lead 以证据（代码/测试/规范原文引用）回复请 origin 席复核；成立则该席在**新一份 verdict 里同时**把该 finding `status=closed` **并**将其 id 列入本席 `closed_finding_ids`（共识门双条件，缺一即 fail，见下方收口契约与 consensus-gate 实现——只翻 status 不列 id 是已知失败模式）。证据锚点单独留档（回复文本进 PR 评论或本轮对账记录），禁止无证据口头驳回。
- **推**：真问题，但属于加固、邻域补全、通用能力——不服务于目标句，或不必留在本 PR → **默认外推**：开独立 issue，PR body 记录 issue 链接；origin 席据此在**同一份 verdict 里** `status=closed` **且**列入 `closed_finding_ids`（双条件同上），close 理由记 out-of-scope-tracked、issue 链接作为锚点单独留档。**即使是真问题也默认外推**——「每条意见单看都合理」正是 PR 在返修轮膨胀的路径；范围判断锚定意图，不锚定意见本身的对错（临场逐条判必输）。

  > **主证据落在 diff 之外的真问题（仓库既有问题等）走 `out_of_scope_notes[]`，不要写成 finding**
  > （D3，2026-08-06）：finding 的 `anchor_paths` 必须 ⊆ `base..candidate` 实改集（SC-R3-5，拦
  > 「锚点填宽制造假冲突」，**一个字不放宽**），所以这类问题**无法**合法表达成 finding——塞
  > `gate_checks` 会撞 conjunct④ 且进不了台账，丢弃则永久丢信息。审查席改填 verdict 的
  > `out_of_scope_notes[]`（字段形状见 `schemas/review-verdict.schema.json`，派工契约段已自动带上
  > 字段名与必填项）：`ref_paths` 只要求是 tracked 文件、**允许在实改集之外**，这正是该通道存在
  > 的理由。它参与 `verdict_hashes`（改了就换 hash，不可事后追加），但**不进** conjunct②③④、
  > **不进** `canonical_findings`、**不进** SC 台账与冲突图——因此不影响任何放行判定。
  > **lead 的义务**：每条 note 按本节「推」的流程开 issue（用 note 的 `suggested_issue_title`）
  > 并把链接记进 PR body 与本轮对账记录。保证等级 **T1**：机器只锁形状（字段齐全、与 finding
  > 双向不可互相伪装、id 命名空间互斥），**不校验 issue 真的开了**——漏开只能靠对账发现。

与 `[ARCHIVE-eligible]` 的关系（并列不冲突、判据不同）：ARCHIVE 是「**本修复周期新写代码**的窄面残余」的文档化接受（登记进 README，`kind=archive` SC 走同一编排链，四条判据见下）；推是「**范围外真问题**」的外推跟踪（登记进 issue）。一条 finding 若两者都够格，优先 ARCHIVE（本 PR 内闭环、成本更低）。

处置报告要求（人读验收）：每轮 delta 对账记录中，每条 finding 必须标注 修/答/推/ARCHIVE 之一并附对应产物锚点——修：SC id；答：证据回复位置；推：issue 链接；ARCHIVE：README 登记文案。**三席 verdict 里的每条 `out_of_scope_notes` 同样各占一行**（视同「推」，附 issue 链接）。缺任一即视为该轮对账不完整，不得进入收口。

每轮 delta 复核，审查席对每条存活 finding 标 `[MUST-FIX]` 或 `[ARCHIVE-eligible]`：

1. **`[ARCHIVE-eligible]` 判据**（四条全中）：① 窄面（不改主要控制/数据流，只是并发窗口/异常路径的窄角）；
   ② 限于**本修复周期新写的代码**（git 可查，不是既有面）；③ 非数据损失、非泄密、非安全绕过、
   非 active-path 失败、非 T2 冒充；④ 审查席给出了**它自己建议的残余登记文案**。
2. **ARCHIVE 类的收口（机器契约，不是自由发挥）**：lead 为该 finding 提炼一条 `kind=archive` 的 SC
   （`schemas/sc-manifest.schema.json` v2），把审查席给的文案原样填进该 SC 的 `change`/`holds`，
   `verify` 用结构化 argv 校验文案已落地，例：
   ```json
   { "id": "SC-ARCH-1", "kind": "archive", "finding_ids": ["<fid>"],
     "change": "把残余风险文案写进 README.md", "holds": "README.md 含约定文案",
     "verify": { "cmd": "grep", "args": ["-q", "<残余风险关键文案>", "README.md"] } }
   ```
   `fix-plan.mjs` 对 `archive` SC 的文件域**固定给 `README.md`**（不从 `anchor_paths` 派生——那是
   finding 本体的锚点，不是本次要改的文件），该组进**末波**、与 `verify` 组并行（两者都只需看见
   前波产物、域互不相交，该并行必须并行）；多条 archive SC 天然都落在 `README.md`。
   **hub 路径门对 archive 池没有特例豁免**（三池同查）——多条 archive SC 移除 `README.md`
   后余集为空，D1「可移除性」判据本身就会判它为真同文件耦合而放行，不需要豁免分支。
   > ⚠ 这行原文声称 archive 池被 hub 门**特例豁免**，而 D2（owner 2026-08-02）已把那个
   > 特例分支**删掉**了（理由：特例短路会掩盖测试信号——通用判据被改回旧版时，被豁免的池子
   > 测不出来，加固清单第 8 类）。文档没跟着改，2026-08-03 由跨会话作者顺带点出「文档与实现
   > 不同步」的风险时查到。这是我自己那次改动留下的第 7 类漂移，不是别人的。
   >
   > 再如实补一句边界：「三池同查」**无法从 `buildFixPlan` 的输出观测到**。archive SC 的文件域
   > 被固定为单一 `README.md`，移除它后余集为空，D1 判据必然放行——所以"查了但放行"与
   > "豁免所以没查"两种实现的输出**完全相同**。删掉特例分支的收益只是实现层卫生
   > （少一条会掩盖测试信号的短路），不是一条可被机器验证的契约。机器能锁住的只有
   > `hubViolations` 对任何 label 行为一致，见 fixture `[R10-A4]`。别把它写成可验证契约。
   coverage-gate 对 `archive` SC 与 `fix`/`verify` 同等要求：恰好引用 1 条 finding。
   worker 走**与 `[MUST-FIX]` 完全相同的 fix-run 编排**：`allocate` 分到自己的 worktree
   （`write_paths = {mode:'fixed-list', paths:['README.md']}`——2026-08-03 终审 P2: 这里原写
   `allowed_paths`,那是**已废弃**的字段名,schema 对 SC/finding 自带 `allowed_paths` 是**结构性拒绝**;
   照旧文档派工会让 worker 去找一个不存在且被 validator 拒收的字段）→ 把文案写进 `README.md`
   → commit → `integrate` →
   orchestrator 复跑 `grep` 验证通过。不需 owner 授权（同 Phase 2b）→ 下一轮 delta 审查席看到
   README 已含约定文案 + verify 通过，据此把该 finding `status=closed`（已由文档化接受解决）
   → consensus-gate 正常 PASS → push。**闸没绕，循环终止**（因为文档化不产生新代码 = 不长新 finding）。
3. **`[MUST-FIX]` 仍须改代码**：回 Phase 2c 头部，**按类套形状重做**（不是打补丁）。
4. **补丁螺旋探测（谱系判据，不是水位线——数字只切换修复模式，谱系探测仍可比水位线更早
   触发）**——触发要求**同一问题谱系**，不是「凑够 2 轮窄面」：连续 2 轮的窄面 `[MUST-FIX]`
   必须指向**同一模块 + 同一操作 + 同一失败形状**（对账依据：上一轮 finding id +
   `prev..current` 的行级 provenance；两个互不相关的窄面**不算**螺旋）→ 先完成
   `references/convergence-checkpoint.md` 的原子六件套（若本谱系尚未做过），产出后强制回
   「修复方设计约束」把该模块**所有异常出口一次性重写**（不是再加一个 guard）。
   **重写后仍复现同类窄面 → 不自动降级**：必须**重新逐项评估第 1 条的四项资格**，任一不满足
   （尤其③：数据损失/泄密/安全绕过/active-path 失败/T2 冒充）→ **继续 `[MUST-FIX]`**。
5. **检查点后同族复发 → 升级阶梯，不再打补丁**（触发 = 完成第 4 条的六件套之后，**同一
   family** 再次复发——说明模型仍是猜的，继续加条件分支没有意义）。四选项按「要不要 owner」
   分两档，**不是**无差别的「lead 自主」——同一句话不能既说自主又说要 owner：

   - **纯技术档（lead 自主，不上抛 owner）**：① 抽出显式状态机/transition reducer（命中
     一般 async 形状套 `hardening-checklist.md` 第 4 类展开）；② 把该职责移到更合适的上层
     协调者；③ 缩减实现机制、**保留产品语义**（降级设计）。这三条按 `convergence-checkpoint.md`
     D3 属于「纯技术升级路径」，不改变用户可见行为与功能范围，所以自主执行。**「保留产品语义」
     是判据，不是自称**：③做完之后若用户可见行为/功能范围实际发生了变化，即使 worker 声称
     「保留了语义」，该改动也不再属于本档，必须落 D3 走 owner 确认——不能靠自我声明豁免。
   - **需 owner 档**：④ **划定范围**（在 PR body 写明本 PR 不处理哪些场景，范围外 finding
     答复说明后 close）。划定范围**本身就是**用户可见的功能范围变更，落 D3——动手前须先获
     owner 确认，不属于「纯技术判断」，不能因为它出现在四选项列表里就默认跟①②③一样自主。

   **硬约束（即使 owner 已同意划定范围，这条线也不许越）**：划定范围**不得**把仍在 active
   path 上的安全问题改名成 residual——范围只能划在真正的产品边界外，不能拿它当 `[ARCHIVE]`
   的后门。

   拆 PR **不是标准动作**：仅当以上四选项都不可行时才考虑，同样落 D3（拆 PR / 净新增基础
   设施 / 用户可见行为/功能范围/发布策略变更），动手前须先获 owner 确认。**「升级阶梯本身
   不需要 owner」只在纯技术档内成立**——在①②③之间选哪条路径不需要 owner；一旦落到④划定
   范围或拆 PR，就必须走 owner，不能把这句话读成对四选项的全称句。升级路径若需**新增**
   并发/锁/缓存/持久化/重试类基础设施，先过 `hardening-checklist.md`「新增机制确认门」。

   同一谱系累计 3 次整块重写（含本条升级）仍无进展 → 走第 6 条报 owner，**不许自动
   ARCHIVE 掉**。
6. **真·卡死兜底**：`[MUST-FIX]` 的 **blocker/major** 连续 2 轮不减（不是窄面）→ 停，报 owner。

区分：4 治「同一问题谱系反复打补丁」（先做检查点、再整块重写了结）；5 治「做完检查点后同族
再犯」（升级路径——抽状态机/挪职责/降级/划范围，不再加 guard）；6 治「真修不动」（不收敛，
交人）。**绝不**混为「跑够 N 轮就停」的数字闸——数字闸要么切早漏真问题，要么切晚继续螺旋；
下面的 repair-mode watermark 是另一件事，只切换修复模式，不替代这三条判据。

**repair-mode watermark（补丁计数的唯一合法用途，`convergence-checkpoint.md` D2）**：计数
权威 = 本次 submit-pr run 的 run artifacts 中「完成过 delta 审查的不同 candidate SHA」数
（排除同 head 重跑、工具重试、纯 reviewer 重放）。第 5 个 candidate 仍出现**新 family**
（对照共识产物 `canonical_findings` 的 `family_key`——**不是** `family_id`：`family_id` 只是
reviewer 席内的本地标签，两个不同 reviewer 完全可能各自合法地把同一标签用来指不同的不变量，
按标签判断「是否新 family」会把不相关的 finding 错误合并，2026-08-02 gpt 终审阻断修复，D1/D2）
→ 下一次修复 commit 前强制完成 `references/convergence-checkpoint.md` 六件套；第 10 个 → 禁止
继续同形状打补丁，lead 按第 5 条升级阶梯自主选路径执行 + **红色通报 owner**（轮数/失败族清单/
选定路径）。

> ⚠ **这里的「强制」「禁止」没有任何守卫在拦**——它们约束的是 lead 的行为，不是脚本的行为。
> 没有计数器会在第 5 个 candidate 时报错，没有门会在第 10 个 candidate 时拒绝 push；漏做**只能**
> 靠 review 发现。这是 owner 2026-08-02（D2）的明确选择，理由见下方「机器锁定范围」。
> 之所以把这句话单独拎出来：段落里的「强制/禁止」字面强度高，略读的人会以为它是机器门
> （2026-08-02 gpt 复审正是据此开了一条 P1——原标题写「验收条件」，读起来像这条动作本身
> 已被验收）。**它不是。** 把它当成写在流程里的自律条款，不是安全网。
这条数字线**只**做一件事——切换「这次修复要不要先做六件套 / 要不要禁止继续同形状打补丁」，
**绝不**决定 consensus 是否 PASS、finding 的 severity、能否 `[ARCHIVE]`、能否 push——这四件
事仍分别由 consensus-gate / 审查席 / SC 覆盖门 / push-guard 独立裁决，水位线到第几个
candidate 不改变它们的判据（与本节「反猫捉老鼠」立场一致：数字从不替代形状判断，只是在形状
判断之外加一层「至少做过一次结构化止损」的兜底）。
**机器锁定范围 / 未强制部分（owner 2026-08-02 fable 拍板，D2；标题原为「验收条件」，
2026-08-02 gpt 复审 P1 指出那个标题读起来像「第 5/10 个动作本身已被验收」，故改名——
下面两条一条讲「没锁什么、为什么不锁」，一条讲「锁住了什么」）**：
- 第 5/10 个 candidate 的触发是**纯 T1 过程规则**——由 lead 对照本次 run 的 run artifacts
  与各轮 consensus 产物**手动执行**，本仓**有意不建**任何生产态计数器脚本/字段。按
  `hardening-checklist.md`「新增机制确认门」的检验标准：删掉这个计数器，本节其余判据
  （consensus-gate/审查席/SC 覆盖门/push-guard 各自独立裁决）照样成立，watermark 只是在
  这之外加的一层「至少做过一次结构化止损」的过程纪律，不是缺了它就转不动的核心机制——因此
  不建。**为了凑出一条能跑的 fixture 而专门写一个只被测试调用、生产路径永远不会触达的
  「计数器函数」= 假覆盖，同样禁止**（那种测试无论跑多少次都不能证明 lead 真的会在第 5/10
  个 candidate 时执行这条规则，只能证明这个从未被使用的函数本身语法正确）。
- 真正能且应该机器锁定的，是这条规则的**机器前提**：给定跨 candidate 的两份（或多份）
  consensus artifact，能否机器化判定「是否出现了新 family」——这是纯粹的 `family_key` 集合
  运算，不涉及「第几个 candidate」这类需要人工追踪 run 历史的状态。`fixtures/run-fixtures.mjs`
  的 `[SC-B1-WM]` 用真实 validator + consensus-gate 锁住这个前提（含 gpt 终审点名的两条反例：
  ①两个 reviewer 都合法使用同一个 `family_id` 标签但描述不同 invariant → `family_key` 不同
  → 不得合并；②同一个 invariant 被标了不同的 `family_id` 标签 → `family_key` 相同 → 必须
  正确合并）。
  **这条锁的边界要看清**：三份 artifact 是真走 validator + consensus-gate 产出的（断言里逐份
  核了 `gate_result === 'pass'`），被锁住的是**真实代码产出的 artifact 形状**——`family_key`
  确实随每条 canonical finding 落账、且集合差可判。而做集合差的那两个小函数
  （`familyKeySet` / `newFamilies`）是**测试文件内的本地辅助，生产路径没有对应实现**，
  别当成有一个生产态的「新 family 检测器」。这正是上一条不建计数器的同一立场：
  被测对象是 artifact，不是辅助函数。

> **与 plan.md 的数字上限冲突已裁决（owner 2026-08-02）**：`docs/plan.md` SP-2 及其流程图写的
> 「≤3 轮未收敛停给 owner」（plan.md:37 / 69 / 95 / 131）**本节取代之**——按形状判据收敛，不按轮数硬停；
> repair-mode watermark 的第 5/10 个 candidate 同样不是该数字上限的复活，只切换修复模式（见上）。
> plan.md 的该数字保留为历史记录，不再作为执行契约。
> 另需区分：`SKILL.md` Phase 2「lead 争议质询 ≤3 轮」是**仲裁**轮次上限（lead 与审查席就某条 finding
> 是否成立的往复），**不计**修复轮/delta 复核轮——两者互不换算。

## Phase 3 — push + 注册（lead 指定一个修复 worker 执行；并行场景选其一即可）

worker 收**自包含 push manifest**（repo/remote/branch/**expected_sha**/`purpose=feature`/标题正文/已有 PR 号/注册 key/consensus_artifact_hash/`sc_manifest`+`sc_manifest_hash`/`fix_orchestration` 五件套）。base 不在 manifest 里——由共识 artifact 派生，manifest 无权自定（审②-F4）：

```
node scripts/push-guard.mjs --repo-dir . --manifest push-manifest.json \
  --artifact consensus-final.json --bundle review-bundle.json \
  --source-artifact consensus.json --sc-manifest sc-manifest.json \
  --fix-plan fix-plan.json --dispatch-record dispatch-record.json \
  --run-manifest <st>/run-<run>.json [--size-exemption <豁免json>] --execute
```
**size 终闸**（PR-B2）：守卫对终版（expected_sha vs artifact.base_sha）重算规模——入口闸
PASS 过的 PR 在修复轮膨胀到 STOP 一样拒 push；豁免与 Phase 1 第 5 步同口径同文件（绑定
head_sha，修复轮产生新 SHA 后旧豁免自动失效）。size 结果 + 配置 hash 打进 PASS 回执行。
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
