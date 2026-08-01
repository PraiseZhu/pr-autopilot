# 部署指南（macmini = 红线载体）

> 计划依据: docs/plan.md §4 P0 清单 / §5 阶段出口 / W-2 / W-7 / §1.3a。
> **部署前提: P0 清单 ①〜⑫ 全部有确定答案**（首件事 = 修 mini gh token）。
> 本仓是台本容器；mini 上跑的是它的 clone。台账数据留 mini 本地与各业务仓，不回推本仓。

## 0. 前置（P0，不做完不许开调度）

1. mini `gh auth status` 有效（token 失效是当前第一阻塞）。
2. mini clone cindy（fork 流程，push 目标 = PraiseZhu/cindy-fork）与 mivo 各一份 checkout。
3. 飞书: owner 先私聊一次 Mivo bot；W-7 三前提实测（launchd 环境凭证可读 / bot API 可达 / 真实试发成功，凭证不落库不打日志）。
4. `sessions.dispatch` 端到端: 从 script 调度起 GLM 会话，session meta 落盘核对四元组
   `agentKind=claude-code + provider + z-ai/glm-5.2 + 最高`（不是只看 dispatch 成功）。
5. goal skill 在 mini 可用，且已含 `--until-sc` 模式。
6. deepseek effort=max 可用性（不支持 → 降 xhigh + 首张卡片脚注告知 + ledger 审计）。
7. preRunHook 失败语义 / missed-fire 补跑语义实测；调度会话调 cindy_feishu_bot 是否 NO_CHAT_CONTEXT。

## 1. 落盘

```bash
# mini 上
git clone git@github.com:PraiseZhu/pr-autopilot.git ~/pr-autopilot
mkdir -p ~/pr-autopilot-runtime/{state-mivo,state-cindy,ledger,journal}
```

runtime 目录（state/lease/ledger/journal）一律在仓外 `~/pr-autopilot-runtime/`。

## 2. 盯梢引擎（每仓一条 script 模式 Cindy 调度，W-2）

- cron: `*/15 * * * *`；execution_mode=script；零 LLM。
- schedule A（mivo）: workingDir=mivo checkout；schedule B（cindy）: workingDir=cindy checkout。
- 两条 schedule 自身设 `agentKind=claude-code + z-ai/glm-5.2 + 最高`（修复会话经继承获得）。
- 入口命令（`--config` **必填**——缺 budget 配置引擎直接拒绝启动，审③-F13-R fail-closed）:

```bash
node ~/pr-autopilot/scripts/pr-watch/engine.mjs \
  --state-dir ~/pr-autopilot-runtime/state-mivo \
  --lease ~/pr-autopilot-runtime/lease-mivo.json \
  --snapshot-cmd "node ~/pr-autopilot/deploy/wrappers/gh-snapshot.mjs {owner} {repo} {pr}" \
  --dispatch-cmd "node ~/pr-autopilot/deploy/wrappers/cindy-dispatch.mjs" \
  --journal ~/pr-autopilot-runtime/journal/watch.jsonl \
  --config ~/pr-autopilot-runtime/engine-mivo.json
```

engine-mivo.json（完整必填示例；两仓 schedule **共享同一 budget.ledger**——预留在锁内原子完成，防竞态双派）:
```json
{
  "budget": {
    "ledger": "/Users/<mini-user>/pr-autopilot-runtime/ledger/cost.jsonl",
    "cap": 30,
    "estimate": 9.2
  },
  "repoDirs": {
    "xindong/mivo-canvas": "/Users/<mini-user>/mivo-ops/mivo-canvas"
  },
  "triReviewLedgerDir": "/Users/<mini-user>/pr-autopilot-runtime/tri-review",
  "escapeLedger": "/Users/<mini-user>/pr-autopilot-runtime/ledger/escape.jsonl",
  "feishuCmd": "node /Users/<mini-user>/pr-autopilot/scripts/health/feishu-alert.mjs",
  "slackCmd": "node /Users/<mini-user>/mivo-ops/mivo-canvas/agent-use/loops/bug-doctor/notify.mjs"
}
```
- `estimate` 取 review-pr 历史 exact 均价 ~$9.2/会话；修复会话完工时用
  `budget.mjs --record --dispatch-id <id> --cost <实际>` reconcile（reserve 被同 id actual 取代）。
- `repoDirs` 缺某仓时该仓终态清理 fail-closed（cleanup-pending 不销单，审③-I2-R）——两仓都必须配。
- 注册命令（审⑤-F4: `--branch` 与 `--push-remote` **必填**，引擎不猜 remote 名）:
  - mivo: `node scripts/pr-watch/register.mjs --state-dir … --owner xindong --repo mivo-canvas --pr <N> --branch <feature> --push-remote origin`
  - cindy: 同上，另加 `--push-remote fork --push-repo PraiseZhu/cindy-fork`
    （finalize 会把该 remote 的 push URL 与 push-repo 仓名绑定，upstream 冒充被拦）。
    **前置**: cindy checkout 里必须存在名为 `fork` 的 remote 指向 PraiseZhu/cindy-fork
    （`git remote add fork git@github.com:PraiseZhu/cindy-fork.git`）；若你的 checkout 是
    「origin=fork / upstream=上游」布局，则注册时传 `--push-remote origin` 即可——remote
    名以**注册时显式声明**为准，不是约定死的。

### P0-⑦ 定案：CINDY_DISPATCH_CMD = 队列握手（班车形态）

```
CINDY_DISPATCH_CMD="node /Users/praise/pr-autopilot/deploy/wrappers/queue-transport.mjs"
```

链路：盯梢班车 = mini Cindy scheduler 的 **agent 模式** schedule（`claude-code + Cindy AI +
z-ai/glm-5.2 + max`，workingDir = 对应仓 checkout，intervalMs 建议 900000=15min，静默运行）。
班车会话职责（写进 schedule prompt）：
1. `source ~/pr-autopilot-runtime/env.sh` 后**后台**跑 engine（对应 engine-*.json）；
2. 轮询 `~/pr-autopilot-runtime/dispatch-queue/*.task.txt`：每个任务调 `cindy_helper`
   的 `send_to_session`（**不传 target id = create 模式**，message=任务全文）——新会话
   克隆班车自身 agent/model/effort，四元组由此保证；拿回 target_session_id 后写
   `<id>.receipt.json`（`{session_id, agentKind, provider, model, effort}`，model/effort
   照抄本 schedule 配置）；
3. engine 退出后汇报其 JSON 输出（dispatched/stuck/paused 非空才提醒）。
queue-transport 落任务文件→轮询回执（默认 240s，env 硬边界 [5s,300s]）→回执原样交
cindy-dispatch.mjs 做 session_id+四元组校验；超时 = 投递失败，引擎 at-least-once 重试。

（gh-snapshot/cindy-dispatch/queue-transport 均有契约 fixture 覆盖。）

## 3. 每日卡片调度（§3）

- cron: `0 10 * * *`；agent 模式；四元组 `claude-code + Cindy AI + deepseek/deepseek-v4-pro + max`。
- 第一段 collect.mjs（确定性）→ 第二段 DeepSeek 逐项改写 → render-validate.mjs 机器门
  （失败重试 1 次 → 回退 fallbackRender，绝不发未过验输出）→ 发送通道按 §3.1 ①→②→③。

## 4. 自进化周会调度（§1.3a）

- cron: `0 0 * * 1`；四元组 `claude-code + Cindy AI + z-ai/glm-5.2 + max`。
- 投递内容 = `scripts/evolution/weekly-evolve.md` 全文 + ledger 路径参数。

## 5. 独立健康告警（W-7，不依赖 Cindy）

```bash
sed -e "s|__AUTOPILOT_DIR__|$HOME/pr-autopilot|" \
    -e "s|__HEALTH_CONFIG__|$HOME/pr-autopilot-runtime/health.json|" \
    scripts/health/com.praise.pr-autopilot-health.plist \
  > ~/Library/LaunchAgents/com.praise.pr-autopilot-health.plist
launchctl load ~/Library/LaunchAgents/com.praise.pr-autopilot-health.plist
```

health.json（`slack_cmd` **必填**——不配则飞书凭证不可得时双通道皆哑，审③-I3-R）:
```json
{ "ttl_minutes": 45,
  "leases": [
    { "name": "engine-mivo", "file": "/Users/<mini-user>/pr-autopilot-runtime/lease-mivo.json" },
    { "name": "engine-cindy", "file": "/Users/<mini-user>/pr-autopilot-runtime/lease-cindy.json" } ],
  "feishu_cmd": "node /Users/<mini-user>/pr-autopilot/scripts/health/feishu-alert.mjs",
  "slack_cmd": "node /Users/<mini-user>/mivo-ops/mivo-canvas/agent-use/loops/bug-doctor/notify.mjs" }
```

FEISHU_* 凭证经 launchctl setenv 或 plist EnvironmentVariables 注入（不提交、不打日志）。

**安装后必做双分支 smoke test**（审③-I3-R 验收）:
1. 凭证在: 伪造过期 lease → 跑 lease-check → 必须收到飞书告警（exit 2）
2. 临时摘掉凭证: 同样跑 → 必须收到带「降级通道/凭证不可得」标记的 Slack 消息（exit 2）
3. 两条都不过 → 不许挂 launchd（fail-closed）

回滚: `launchctl unload ... && rm plist`。

## 6. 业务仓接入（Review-PR 既有模式）

- mivo 仓: `agent-use/docs/` 放 ui-paths registry 副本与 dual-review-evolution.md 台账（团队可见）；
  `securityReviewPaths` 加入 `pr-watch/` 与本自动化自身路径。
- skill 接入: 交互机 `~/.claude/skills/submit-pr` 软链到本仓 skills/submit-pr。

## 7. 验收（§5 P1/P2 出口，摘录）

- P1: 连续 3 天 10:00 合格卡片；续聊分拣实测通过（阻断出口）；四元组 session meta 核对；旁路 PR 24h SLO。
- P2: fixtures 全绿 + 真实 PR 走通「提交→三审→SC→修复→delta 复核→push→盯梢→修复→绿灯停手」全环。
