# pr-autopilot

**把「提一个 PR」之后的所有等待、盯梢、返工，从人的日程表里拿掉。**

> 权威计划: `docs/plan.md`（九轮对抗审查定稿）；实现经 12 轮 gpt-5.6-sol/xhigh 对抗复审 APPROVED，
> 5 路并行 e2e 全绿，fixtures 201/201。运行时台账数据**不入本仓**（台本与数据分离）。

---

## 它解决什么问题

没有这套系统之前，一个 PR 的生命周期里"人"要干这些事：

1. **push 之前**自己反复检查代码有没有问题——检查得再认真，一个人也只有一双眼睛；
2. push 之后**惦记着**：CI 红了没？reviewer 说话了没？Greptile 挑刺了没？——于是每隔一会儿去刷一次 GitHub；
3. 看到反馈后**放下手头的事**去改，改完再 push、再回帖、再等下一轮；
4. 与此同时还要记得今天有哪些 issue @ 了我、哪些 PR 等我拍板——收件箱越堆越厚。

每一条单独看都是小事，加在一起就是：**你的注意力被 PR 的异步节奏绑架了**。写代码十分钟，等反馈两小时，而且不敢真的走开。

pr-autopilot 把这四件事全部接走。你只保留两个动作：**说一声"提交 PR"，以及在真正需要人拍板的时刻拍板**。其余时间该干嘛干嘛，系统出了事会来找你，而不是你去找它。

## 全链路怎么运转

```
你: "提交 PR"
 │
 ├─ Phase 1  确定性预检（typecheck-merged / lint / 版本 bump / UI 判定脚本说了算）
 ├─ Phase 2  三审收口 —— push 之前，三个互相不通气的 AI 审查员同时上：
 │            ① sonnet-5/xhigh 盲审: 正确性/回归/影响面
 │            ② 骨折 terra/xhigh 盲审: 安全/边界/规范（核心路径 PR 升 ultra）
 │            ③ sonnet-5/xhigh 只读预演上游 review-pr 的口径（提前踩雷）
 │            共识不由任何 AI 宣布——由脚本判四个硬条件（consensus-gate）
 ├─ Phase 2b/2c  共识确认的问题 → 提炼成可验证 SC → glm-5.2/max 修到每条有证据
 ├─ Phase 3  push-guard 守卫放行才 push（SHA 钉死/禁 force/禁碰 CI/hash 链三方绑定）
 │            → gh pr create → ssh 到 mini 把这个 PR 登记进盯梢名单（回执四要素）
 │
 ▼ 此后你不用再看这个 PR ──────────────────────────────
 │
 ├─ mini 盯梢班车（休眠式）: 零成本探针定期查岗，无动静连 AI 会话都不起
 ├─ 有新反馈（新评论/新 review/CI 变红）→ 自动拉起 glm-5.2/max 修复会话:
 │     修到位 → finalize 守卫链再过一遍 → push → 带签名回帖 → complete 核验收口
 │     修不动/挂死 → 重派，三次仍死 → 告警找你（这才轮到人出场）
 ├─ $30/天预算闸: 花超了自动暂停等你确认，绝不静默烧钱
 │
 ├─ PR 合并/关闭 → 自动结算预算、回收 worktree、销单 → 系统回到休眠
 │
 └─ 旁路兜底: 每日待办卡片顺手补扫"open 但没在册"的 PR（24h SLO 保险丝）
```

配套的两条独立链：

- **每日待办卡片**（§3）：收件箱通知 → 确定性分桶排序 → DeepSeek 改写成人话 → 机器验证（防幻觉/防重排/防丢条）→ 推送。杂音（D 桶）自动标已读，你看到的每一条都值得看。
- **自进化周会**（§1.3）：审查员漏掉的、守卫误伤的，全部进防篡改台账（hash 链 + head 侧车）；同类问题攒够两例 → 周会自动起草改进提案 PR。**系统自己变强，但改进只能走 PR、只能动白名单文件、红线 R1–R10 机器可查。**

## 为什么值得信（设计立场）

这套系统拥有"替你 push 代码、替你在 PR 里说话"的权力，所以它的第一设计原则不是聪明，是**不越权**：

| 立场 | 落地 |
|---|---|
| 永不自动合并 | 全仓不存在任何 merge 路径（R1），合并永远是人点的 |
| AI 说了不算 | 共识、UI 判定、CI 判绿、完工认定——全部由确定性脚本裁决，AI 只提供输入 |
| fail-closed | 读不到=不放行；schema 不合=degraded；回执缺一要素=注册失败显式报错。宁可停下叫人，绝不装作没事 |
| 每一步可对账 | review_input_hash → consensus_artifact_hash → 修复 manifest → push manifest 两段式 hash 链，中途换任何一环立刻失效 |
| 撤得回、追得到 | 取消是两阶段状态机（游标不丢、预算释放、旧会话永久失权）；台账 append-only + hash 链，删一行都会被发现 |
| 花钱有闸 | 预算按 dispatch 预留/结算/释放全程记账，$30/天硬闸=暂停等确认 |

S2 口径的诚实声明：本地守卫是「可检测」而非「不可能」，服务端分支保护/ruleset 是最终兜底。

## 仓库结构

```
docs/plan.md                     定稿实施计划（唯一权威）
schemas/                         review-verdict v1 / consensus-artifact v1
scripts/
  lib/                           canonical JSON / sha256 / 原子写 / per-key 锁 / git 校验
  review-input-hash.mjs          派审前可算的输入 hash（两段链第一段）
  verdict-validate.mjs           审查产出机器契约（schema 失败一律 degraded）；含域外通道 out_of_scope_notes 形状门（D3）
  dispatch-contract.mjs          派工包机器契约段生成器 + 派工前置门（D1；字面值从 validator 常量派生，digest 防陈旧粘贴）
  pr-format-gate.mjs             PR 标题/正文模板合规确定性预检（D2；配置读 merge-base 树，缺配置 SKIP、malformed fail-closed）
  consensus-gate.mjs             四 conjunct 共识门（谁也不能口头宣布共识）
  push-guard.mjs                 push 放行守卫: SHA 绑定/禁 force/CI 路径/宪法黑白名单/fast HMAC
  ci-readiness.mjs               CI 判绿契约（required contexts，fail-closed）
  ui-paths/                      UI 判定唯一源（registry + match，B 面 n_a 权在脚本）
  pr-watch/                      盯梢状态机: register/gate/engine/finalize/complete/ack(--cancel)/budget
  inbox-digest/                  每日卡片: collect 分桶 / render-validate 机器门 / runner 全链
  evolution/                     自进化: 台账 append(hash 链)/聚类达阈/secret-lint/周会/宪法路径表
  health/                        独立健康告警（launchd + lease-check + 飞书→slack 降级链）
skills/submit-pr/                「提交 PR」skill v2（三审收口版）+ references
fixtures/                        201 条回归 fixture（run-all.sh 一键跑；末尾附诚实 SKIPPED 清单）
deploy/README.md                 mini 部署手册（含 P0-⑦ 班车握手定案）
deploy/wrappers/                 真机适配: gh-snapshot / cindy-dispatch / queue-transport / probe
```

## 快速验证

```bash
bash fixtures/run-all.sh   # 201 passed 才算数；SKIPPED 清单如实列出仓内验不了的真机项
```

## 模型点名（owner 第 0 优先，压过 routing 表）

三审（唯一权威 = `skills/submit-pr/SKILL.md` Phase 2 席位表，本行仅摘要）: sonnet-5/xhigh + 骨折 `codex/gpt-5.6-terra`/xhigh（核心路径升 ultra，降级链 gpt-5.5）+ sonnet-5/xhigh（上游预演）；
争议仲裁（按需）: 骨折 `codex/gpt-5.6-sol`/max（极端 ultra）；修复+push: glm-5.2/max（goal --until-sc）；
mini 盯梢修复: glm-5.2/max（send_to_session 克隆班车四元组）；卡片: deepseek-v4-pro/max（唯一允许降级 xhigh，留审计）；
周会: glm-5.2/max。

## 残余风险登记（R3〜R8 对抗审查后归档，如实声明不冒充）

修复编排链经**九轮**对抗复审（gpt-5.6-sol/xhigh；共收敛 5×P0 + 26×P1 + 4×P2）收敛。以下是**明知存在、判定为可接受**的面，
不是遗漏——写在这里是为了不让任何人以为这套东西比它实际的更强。

| 残余面 | 性质 | 为什么可接受 |
|---|---|---|
| **T1 是设计上限** | 全链保证等级 = 防疏忽/防漂移（honest-but-fallible lead），**不防恶意伪造** | 脚本与 lead 同 UID，恶意 lead 可直接改 push-guard 自身。真 T2 需宿主级签名回执，本仓做不到。任何读起来像"防恶意"的文案都是 bug，请提 issue |
| verify 可显式调用解释器（如 `sh -c` / `node -e`） | T1 信任边界内的显式作恶面 | `cmd` 仅做"裸程序名"语法约束，不是程序白名单；`args` 也不限制解释器开关。因此同 UID 的恶意 lead 可选择 PATH 中任意程序执行命令。若要把这一面纳入 T2，必须由宿主在隔离信任域中提供并签发 verifier registry/执行回执；在本仓枚举解释器黑名单不能形成安全边界 |
| anchor hub 2+2 配对 | 合法冲突图结果 | hub 门是「≥3 条 SC **且** >50% 占比 **且** 该共享路径对每个持有者都可移除（移除后各自余集非空）」——最后这个 `allRemovable` 条件是 D1（owner 2026-08-02）加的决定性条件，此前本行只写了前两条，把已被替换的纯占比规则当成了充分条件（2026-08-03 终审 P2 查出）。单文件真耦合即使超过阈值也必须放行。4 条 SC 用两个 hub 两两配对 → 4 组并 2 组，未触发门；但若 hub 是真实 changed evidence，这**就是**正确的冲突分组。hub 未实改的情形由共识入口的 changed-set 门拦住 |
| 手工伪造 owner 印记 | T2 面 | 归属判据是 worktree admin git-dir 里的 `pr-autopilot-owner`（run_id + 随机 nonce）。手工复制 admin dir / nonce 属显式伪造。已验证正常生命周期无继承误判（remove/prune/同 basename 重建都不残留） |
| cleanup 补偿恢复失败 | 显式报错，非静默 | 恢复用创建式 CAS（old = 全零），因此**永不覆盖**第三方同名新 ref；一旦恢复失败（如第三方已抢占该 ref）记 `br-restore-fail` + 完整 expected tip + 各错误交人工。不静默 |
| 外部 raw git 并发 | 有补偿事务兜底 | 一旦发起破坏性步骤（`update-ref -d`），此后任何异常都不得在补偿尝试前逃逸：删除命令抛错按**结果不确定**处理（读 ref 后 reconcile：仍在原位→安全拒 / 已消失或读不出→恢复 / 第三方 tip→不覆盖，R9）；复查命令抛错按**不安全**处理走补偿（R8）；预检查抛错在破坏前 fail-closed。窗口后到达的 `worktree add` 因分支已删自行失败 |
| `fix` 类修复组无 per-group 写入路径清单（`write_paths.mode='isolated'`，2026-08-02 anchor_paths 三用途拆分） | T1 残余——机器层不拦"改了与本 SC 无关的非 CI 文件" | `anchor_paths` 是证据锚点、不是写入意图：继续拿它当写入域会把合法改动误判"越域"拒绝（本次拆分要治的正是这个），因此 fix 类不再设清单。**仍在的控制（三层）**：①每组独立 worktree 的结构隔离（`fix-orchestrate.mjs`「隔离即安全，不是事后检查」）；②集成期真实 diff 重叠检测，防跨组互踩；③push-guard 对 `constitution.ci_paths` 的**无条件**拦截（任何 purpose 不豁免），防碰目标仓 CI 文件。**未被机器覆盖的残余**：修复 worker 在目标仓改了与本 SC 无关的非 CI 文件，本轮没有机器拦截，唯一控制是下一轮共识审查看**全量 diff** 时发现——这是人在环里的控制，不是自动门 |
| **B9**：pr-watch 跨轮状态（等的是哪个 candidate/head、当前在等什么、已 defer 几次、这次唤醒的原因）目前只有代码语义判定，零运行时可观测数据 | **deferred，非 closed**（2026-08-02 gpt 终审提出，owner 拍板暂不做） | `scripts/pr-watch/{engine,gate}.mjs` 对"这轮该不该唤醒/该不该继续等"的判断逻辑是对的（有 fixture 覆盖），但过程中间态不落任何字段——出问题时只能靠读代码逆向，不能查一条记录。**为什么现在不修**：还没攒到一个真实运行窗口的数据，不知道真正需要观测的是这四项（candidate/head、等待对象、defer 次数、唤醒原因）里的哪几项、要以什么粒度记——在没有真实数据支撑最小可观测集合之前就去加字段，容易加错字段或加了用不上。**计划**：先跑一个窗口攒实际案例，再回来决定要不要建、建成什么形状，不是不管，是先不猜 |
