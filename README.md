# pr-autopilot

**把「提一个 PR」之后的所有等待、盯梢、返工，从人的日程表里拿掉。**

> 权威计划: `docs/plan.md`（九轮对抗审查定稿）；实现经 12 轮 gpt-5.6-sol/xhigh 对抗复审 APPROVED，
> 5 路并行 e2e 全绿，fixtures 90/90。运行时台账数据**不入本仓**（台本与数据分离）。

---

## 它解决什么问题（从人的视角）

没有这套系统之前，一个 PR 的生命周期里"人"要干这些事：

1. **push 之前**自己反复检查代码有没有问题——检查得再认真，一个人也只有一双眼睛；
2. push 之后**惦记着**：CI 红了没？reviewer 说话了没？Greptile 挑刺了没？——于是每隔一会儿去刷一次 GitHub；
3. 看到反馈后**放下手头的事**去改，改完再 push、再回帖、再等下一轮；
4. 与此同时还要记得今天有哪些 issue @ 了我、哪些 PR 等我拍板——收件箱越堆越厚。

每一条单独看都是小事，加在一起就是：**你的注意力被 PR 的异步节奏绑架了**。写代码十分钟，等反馈两小时，而且不敢真的走开。

pr-autopilot 把这四件事全部接走。你只保留两个动作：**说一声"提交 PR"，以及在真正需要人拍板的时刻拍板**。其余时间该干嘛干嘛，系统出了事会来找你，而不是你去找它。

## 全链路怎么运转（一个 PR 的一生）

```
你: "提交 PR"
 │
 ├─ Phase 1  确定性预检（typecheck-merged / lint / 版本 bump / UI 判定脚本说了算）
 ├─ Phase 2  三审收口 —— push 之前，三个互相不通气的 AI 审查员同时上：
 │            ① opus-5/xhigh   盲审: 正确性/回归/影响面
 │            ② gpt-5.6-sol/xhigh 盲审: 安全/边界/规范
 │            ③ opus-5/high    只读预演上游 review-pr 的口径（提前踩雷）
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
  verdict-validate.mjs           审查产出机器契约（schema 失败一律 degraded）
  consensus-gate.mjs             四 conjunct 共识门（谁也不能口头宣布共识）
  push-guard.mjs                 push 放行守卫: SHA 绑定/禁 force/CI 路径/宪法黑白名单/fast HMAC
  ci-readiness.mjs               CI 判绿契约（required contexts，fail-closed）
  ui-paths/                      UI 判定唯一源（registry + match，B 面 n_a 权在脚本）
  pr-watch/                      盯梢状态机: register/gate/engine/finalize/complete/ack(--cancel)/budget
  inbox-digest/                  每日卡片: collect 分桶 / render-validate 机器门 / runner 全链
  evolution/                     自进化: 台账 append(hash 链)/聚类达阈/secret-lint/周会/宪法路径表
  health/                        独立健康告警（launchd + lease-check + 飞书→slack 降级链）
skills/submit-pr/                「提交 PR」skill v2（三审收口版）+ references
fixtures/                        90 条回归 fixture（run-all.sh 一键跑；末尾附诚实 SKIPPED 清单）
deploy/README.md                 mini 部署手册（含 P0-⑦ 班车握手定案）
deploy/wrappers/                 真机适配: gh-snapshot / cindy-dispatch / queue-transport / probe
```

## 快速验证

```bash
bash fixtures/run-all.sh   # 90 passed 才算数；SKIPPED 清单如实列出仓内验不了的真机项
```

## 模型点名（owner 第 0 优先，压过 routing 表）

三审: opus-5/xhigh + gpt-5.6-sol/xhigh + opus-5/high（上游预演）；修复+push: glm-5.2/max（goal --until-sc）；
mini 盯梢修复: glm-5.2/max（send_to_session 克隆班车四元组）；卡片: deepseek-v4-pro/max（唯一允许降级 xhigh，留审计）；
周会: glm-5.2/max。
