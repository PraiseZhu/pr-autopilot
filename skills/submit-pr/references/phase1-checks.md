# Phase 1 确定性预检 — 两仓具体命令与失败语义（审②-I6 落地）

> 继承自 submit-pr v1 的 Phase 1/1.5/1.6，逐仓写死，不再用「继承 v1」一句带过。
> 任何一步非零退出 = Phase 1 失败，不进三审。

## 通用（两仓一致）

1. 必须在 feature 分支：`git rev-parse --abbrev-ref HEAD` ≠ main
2. `git fetch origin main`
3. **typecheck-merged**：模拟合并后类型检查（不污染工作区）
   ```
   git worktree add /tmp/tc-merge origin/main
   cd /tmp/tc-merge && git merge --no-commit --no-ff <feature-sha>
   <该仓 typecheck 命令>
   cd - && git worktree remove --force /tmp/tc-merge
   ```
   merge 冲突 = 失败（先 rebase 再来）；typecheck 非零 = 失败。

## mivo（xindong/mivo-canvas-plugin）

> 2026-08 插件拆仓后，submit-pr / 盯梢的 mivo 跟踪仓是 `xindong/mivo-canvas-plugin`（origin 直推）。
> 旧主仓 `xindong/mivo-canvas` 不再是这两条链路的默认目标；历史 PR / 旧 registry 仍可按旧仓处理，但新提交走插件仓。

| 步骤 | 命令 | 失败语义 |
|---|---|---|
| 依赖一致 | `npm ci --dry-run` 无变更抱怨 | 锁文件漂移 = 失败 |
| typecheck | `npx tsc -b --noEmit` | 非零 = 失败 |
| lint | `npm run lint` | 非零 = 失败 |
| 日志规则守卫 | `npm run verify:logging` | 非零 = 失败（仓规则: debugLogger 全路径覆盖） |
| 版本 bump | 插件仓无 VERSIONING.md → 本步 `n_a`；changelog 按仓内 daily-changelog / 既有约定 | 不得按旧主仓 VERSIONING.md 误判漏 bump |
| UI 判定 | `git diff -z --name-only origin/main...HEAD \| node scripts/ui-paths/match.mjs --registry registry.mivo-plugin.json --files -` | touches_ui=true 且无 demo 证据 = 失败（除非 --skip-demo-gate 带理由留痕） |

## cindy（makecindy/cindy fork 流）

| 步骤 | 命令 | 失败语义 |
|---|---|---|
| verify 七步门禁 | 复刻云端 client-ci/verify（cindy-pr-preflight skill 既有脚本） | 任一步非零 = 失败 |
| typecheck | 仓内 verify 已含 | 同上 |
| UI 判定 | 同上，registry.cindy.json | 同 mivo |
| push 目标 | fork（PraiseZhu/cindy-fork），PR 提向上游 | push 到上游直接分支 = 违规，push-guard remote 白名单拦 |

## --fast 语义（SP-4 / I6，canonical v2 协议——审⑤-I2 与主 SKILL/push-guard 对齐）

- 只跳 Phase 2 三审；本页所有 Phase 1 步骤 + push-guard 全部照跑
- 机器要求（审④-F2 v2 签名，旧 `repo|branch|expected_sha` 拼串协议作废）:
  push manifest `purpose=fast` + `base_branch` + `fast_attestation{reason, ledger_file, expires_at, signature}`
  - `signature = HMAC-SHA256(PR_AUTOPILOT_FAST_KEY, canonicalJson({v:2, purpose, repo, remote, base_branch, branch, expected_sha, reason, ledger_file, expires_at}))`——任一受保护字段被改写即失效
  - `expires_at` 必须是未来时刻（守卫强制时效，过期签名不可复用）
  - `ledger_file` 必须等于 constitution 的 `fast_ledger_path` 固定路径（守卫对宪法缺该字段 fail-closed）
  - base 由守卫自算 merge-base(remote/base_branch)，manifest 无权自报；留痕由 push-guard 自己写（lstat 拒 symlink + 写后读回验证）
- 自动会话天然被拒: FAST_KEY 只存在于 owner 交互 shell 的环境里，调度/自动会话拿不到 key 即签不出合法 attestation
