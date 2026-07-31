# pr-autopilot

提交 PR 三审收口 + PR 定点盯梢自动修复 + 每日待办卡片 + 自进化周会 —— 全链路自动化的**功能容器与自进化台本容器**。

> 权威计划: `docs/plan.md`（九轮对抗审查 APPROVED 定稿，2026-07-31）。
> 运行时台账数据**不入本仓**（台本与数据分离，计划 §1.3a）。

## 仓库结构

```
docs/plan.md                     定稿实施计划（唯一权威）
schemas/                         review-verdict v1 / consensus-artifact v1
scripts/
  lib/common.mjs                 canonical JSON / sha256 / 原子写
  review-input-hash.mjs          ⑩ 第一段 hash（派审前可算）
  verdict-validate.mjs           ⑨ 机器契约校验（schema 失败一律 degraded）
  consensus-gate.mjs             ⑥ 四 conjunct 共识门（lead 不得宣布共识）
  push-guard.mjs                 SP-3 SHA 绑定 / 禁 force / CI 路径 / 宪法层黑白名单
  ci-readiness.mjs               W-3 判绿契约（required contexts，fail-closed）
  ui-paths/                      ⑫ UI 判定唯一源（registry.mivo / registry.cindy / match）
  pr-watch/                      W-1〜W-5 盯梢（register / unregister / gate / engine）
  inbox-digest/                  §3 每日卡片（collect 分桶排序 / render-validate 机器门）
  evolution/                     §1.3 台账 append / 聚类达阈 / secret-lint / 周会模板 / 宪法路径表
  health/                        W-7 独立健康告警（launchd + lease-check + 飞书直连）
skills/submit-pr/                提交 PR skill v2（三审收口版）+ R7 白名单 references + Phase1 逐仓命令
fixtures/                        回归 fixture（run-all.sh 一键跑；末尾附「仓内验不了」的诚实 SKIPPED 清单）
deploy/README.md                 mini 部署与接入步骤
deploy/wrappers/                 真机适配层: gh-snapshot（快照归一化）+ cindy-dispatch（传输层注入 + 四元组核验）
```

> 声称边界（G 面口径）: fixtures 全绿 = 仓内确定性逻辑全绿；P0①〜⑫ 真机验证、
> 传输层配置、飞书续聊分拣等只能在 §5 P0-P2 出口验收，SKIPPED 清单如实列在 fixture 输出末尾。

## 核心不变量（宪法层，改动只能 owner 亲自动手）

1. **永不自动合并**（R1）——全仓无任何 merge 路径。
2. **共识由脚本判**：三 verdict 同 `review_input_hash` ∧ union 每条被 origin close ∧ 三 APPROVED ∧ 全部 gate_checks∈{pass,n_a}。
3. **两段式 hash 门禁链**（⑩）：review_input_hash → consensus_artifact_hash → 修复 manifest → push manifest，一致才放行。
4. **fail-closed**：schema 不合 = degraded；CI 快照读不到 = 非绿；注册回执缺任一要素 = 注册失败显式报错。
5. **自进化红线 R1–R10 机器可查**（`push-guard --evolution` + constitution-paths.json）。
6. S2 弱保证口径：守卫是「可检测」而非「不可能」，服务端分支保护/ruleset 兜底。

## 快速验证

```bash
bash fixtures/run-all.sh
```

## 模型点名（owner 第 0 优先，压过 routing 表）

三审: opus-5/xhigh + gpt-5.6-sol/xhigh + opus-5/high（上游预演）；修复+push: glm-5.2/max（goal --until-sc）；
mini 盯梢修复: glm-5.2/最高（继承引擎 schedule）；卡片: deepseek-v4-pro/max（唯一允许降级 xhigh，留审计）；
周会: glm-5.2/max。
