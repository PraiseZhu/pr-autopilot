# 部署指南（macmini = 红线载体）

> 计划依据: docs/plan.md §4 P0 清单 / §5 阶段出口 / W-2 / W-7 / §1.3a。
> **部署前提: P0 清单 ①〜⑫ 全部有确定答案**（首件事 = 修 mini gh token）。
> 本仓是台本容器；mini 上跑的是它的 clone。台账数据留 mini 本地与各业务仓，不回推本仓。

## 0. 前置（P0，不做完不许开调度）

1. mini `gh auth status` 有效（token 失效是当前第一阻塞）。
2. mini clone cindy（fork 流程，push 目标 = PraiseZhu/cindy-fork）与 mivo 各一份 checkout。
3. 飞书: owner 先私聊一次 Mivo bot；W-7 三前提实测（launchd 环境凭证可读 / bot API 可达 / 真实试发成功，凭证不落库不打日志）。
4. `sessions.dispatch` 端到端: 从 script 调度起 GLM 会话，session meta 落盘核对四元组
   `agentKind=claude-code + provider + claude-sonnet-5 + xhigh`（不是只看 dispatch 成功）。
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
- 两条 schedule 自身设 `agentKind=claude-code + claude-sonnet-5 + xhigh`（修复会话经继承获得）。
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
claude-sonnet-5 + xhigh`，workingDir = 对应仓 checkout，intervalMs 建议 900000=15min，静默运行）。
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

### ⚠ 换模型必须同时改三处（owner 2026-08-06）

同一个模型/档位值在这条链上出现三次，**必须逐字一致**，否则四元组校验判投递失败：

| # | 位置 | 改法 |
|---|---|---|
| ① | Cindy schedule 的 `model` / `effort` 字段 | mini 的 Cindy 界面上改（决定**实际**用什么模型） |
| ② | 同一 schedule 的 **prompt 正文**里那段 receipt 模板 | 同一界面改（决定回执**写**什么） |
| ③ | `~/pr-autopilot-runtime/env.sh` 的 `EXPECT_*` 四个变量 | ssh 改（决定校验**期望**什么） |

`cindy-dispatch.mjs` **已去掉硬编码默认值**：四个 `EXPECT_AGENT_KIND` / `EXPECT_PROVIDER` /
`EXPECT_MODEL` / `EXPECT_EFFORT` 缺任一即 fail-closed 退出，不再回落到旧默认值。理由：初版把
期望值写死在 wrapper 里，换模型时只改 ①②、③ 静默继续用旧期望 → 本门拿旧期望比新回执 →
投递被判失败；反过来只改 ③ 则回执与实际不符却能过。现在 ③ 只能来自 env.sh，没有可被抄旧的默认值。

env.sh 需含（值随 schedule 同步改）：
```bash
export EXPECT_AGENT_KIND='claude-code'
export EXPECT_PROVIDER='Cindy AI'
export EXPECT_MODEL='claude-sonnet-5'
export EXPECT_EFFORT='xhigh'
```

**如实声明这道门的强度**：它校验的是「回执四元组 == env 期望」，而回执是班车会话按 prompt 模板
写出来的**字面量**，不是从运行时实测到的真实模型。所以 ①② 不一致时（如 schedule 用 sonnet
但 prompt 模板仍写 glm）本门只能发现"回执与期望不符"，**发现不了"回执与实际不符"**——真做到
后者需要宿主回报 session meta 实测值。这是 T1，别读成"模型用错了机器一定拦得住"。

（gh-snapshot/cindy-dispatch/queue-transport 均有契约 fixture 覆盖。）

### 2.1 环境变量三条（不配齐会以**误导性症状**失败，不是直接报错）

| 变量/项 | 作用 | 缺了/做错会看到什么 |
|---|---|---|
| `PR_AUTOPILOT_HMAC_KEY` | 自家评论识别密钥（gate 过滤自家回帖不当作新反馈） | **budget cap 撞顶**（见 ①） |
| `REQUIRED_CONTEXTS_FILE` | CI 判绿的 required contexts 清单（JSON 文件路径） | **CI 永远红 → 每轮都唤醒**（见 ②） |
| preRunHook | 班车调度跳过空转轮 | 不用 probe.mjs 会**每 15 分钟白起一个 agent 会话**（见 ③） |

**① `PR_AUTOPILOT_HMAC_KEY` —— 没配的症状是 budget cap 撞顶**

```bash
export PR_AUTOPILOT_HMAC_KEY=$(openssl rand -hex 32)   # 每台机器独立生成，禁止拷贝别人的
```

- **生成与形状**：`openssl rand -hex 32` 即可（HMAC key 无格式约束，任意字符串都行；64 位十六进制只是惯例）。由 `scripts/pr-watch/provenance.mjs` / `gate.mjs` / `engine.mjs` / `complete.mjs` / `probe.mjs` 全链从环境变量读取，**不落盘、不打日志**（provenance.mjs 注释原文）。
- **每台机器必须独立生成**：它是「这条评论是不是我自己发的」的识别凭证，不是共享口令。拷别人的 key = 两台机器互认对方回帖为自家，签名校验的意义归零。
- **没配会怎样（因果链，别被症状骗了）**：`verifyMarker` 在无 key 时返回 false（「无法验证 → 不声称是自家的 → 宁多唤醒」，provenance.mjs 原文语义）。于是 **gate 把机器人自己发的回帖当成新评论 → 每轮引擎都判「有反馈」→ 反复 dispatch 修复会话 → 每轮 dispatch 都 reserve 预算 → 撞 $30/天 cap → 引擎暂停等你确认**。别人部署时实际看到的「budget cap 撞顶」就是这个链条的末端——**根因是 key 没生成**，调预算参数（cap/estimate）治标不治本，症状会继续咬。这是本项最想让你记住的：budget 报错 ≠ budget 的问题。
- **强度如实声明（T1，无机器门在拦）**：引擎启动时不校验 key 是否存在（`process.env.PR_AUTOPILOT_HMAC_KEY ?? null`，没有 fail-closed 启动门）；这道门防的是「自家评论误唤醒自己」的**疏忽**，不防**伪造**——知道 key 的人可以伪造签名评论。配不配 key 全靠部署时自觉，机器不拦。

**② `REQUIRED_CONTEXTS_FILE` —— CI 判绿的权威来源**

```bash
export REQUIRED_CONTEXTS_FILE=/path/to/required-contexts.json
```

```json
{ "<owner>/<repo>": ["<用下面 gh api 命令取到的实际 context 名>"] }
```

- **格式**：`{"owner/repo": ["ctx 名"]}`（`deploy/wrappers/gh-snapshot.mjs` 读 JSON 后按 `[owner/repo] ?? []` 取值）。
- **接线位置是 `deploy/wrappers/gh-snapshot.mjs` 的运行时 env 读取，不是 `env.sh`**：gh-snapshot 是引擎的**子进程**，读的是调度/launchd 注入的进程环境；`env.sh` 是班车会话自己 source 的文件，往里面塞这个变量，引擎子进程根本看不到——别人就是这么塞的，塞了没生效。要注入到跑引擎的那层环境（与 FEISHU_* 同法：launchctl setenv 或 plist EnvironmentVariables）。
- **取值权威来源 = 分支保护 API 的实际值，不是人手抄 workflow 名**：`gh api repos/{owner}/{repo}/branches/main/protection --jq '.required_status_checks.contexts'`（或仓库 Settings → Branches → 保护规则 → Require status checks 里看到的清单）。手抄名字会漂移——分支保护里改名/增删后，清单不跟着变，CI 判绿就失真。
- **两类 check 绝对不能进这份清单（同一类陷阱的两个变种）**：
  - **`SKIPPED` 不算绿**：gh-snapshot 归一化 check-run 时只有 `conclusion == success` 才映射为绿，`skipped`/`neutral`/`cancelled` 一律非绿（`scripts/ci-readiness.mjs`：`entry.state !== 'success'` → fail-closed 非绿）。按路径过滤的 job（改动不命中就 SKIPPED）一旦进清单，该 PR 永远判不绿。
  - **只在 `pull_request` 事件上跑的 job 同样不能列**：它在 main push 上根本不产生 check，列进去 = 永远等一个不会来的绿。真实案例（mivo 仓 `.github/workflows/deploy-green-ref.yml` 注释原文，本机踩过并写死在注释里的教训）：「e2e 系列 job 都是 pull_request-only，main push 上不存在，不能列（列了 ref 永远不动）；bench / deps audit / semgrep baseline / coverage report 是设计上的非阻断，不纳入」——**设计上非阻断的 job（bench / audit / baseline / coverage 类）也不进清单**。
- **没配/文件缺失 = fail-closed 非绿**：gh-snapshot 对未配置的 required 返回 `green: false` + `['required contexts 未配置（fail-closed）']` → 引擎每轮都以为 CI 红 → 反复唤醒。这又是一个「看起来像别的问题」的症状，实际只是清单没配。

**③ preRunHook 必须用 `deploy/wrappers/probe.mjs`，别自己造一个**

班车 schedule 的 preRunHook 直接用本仓现成的 `deploy/wrappers/probe.mjs`，不要另写：

- 协议：exit 0 = 有活 → 放行班车 agent 会话（引擎 + 队列投递）；exit 2 = 无活 → 跳过本轮，**零 token**，只花几次带 ETag 的 gh API 读。
- 它的判定**复用引擎同源模块**（`gate.evaluate` / `stateFileName` 文法），信号逻辑与引擎是**同一套**——自己另写一个探针等于造第二套判定，两套迟早不一致（探针说有活、引擎说没活，或反过来），凭空多一个故障面。
- 探针自身异常 → exit 0 放行（可用性优先：让完整引擎 + 通知链去暴露问题，而不是让探针静默扼杀所有轮次）。

**④ 多实例部署（2026-08-07 从外部部署者真实踩坑回填）**

- **双机同时巡审：目前没有内建的按作者分片手段**。实测核实：review-pr 的 `--auto` 批量扫**所有**可审查的 open、非 draft PR，无作者过滤参数；pr-autopilot 引擎按 state 目录扫全部在册 PR，注册（`register.mjs`）也不含 author 维度。两台机器各自跑巡审会**抢同一批 PR**：同一 PR 被两家重复审查、重复评论（selfFixAuthors 触发还会交叉改同一 PR）。**这是 T1 之外的真实空缺**，不是设计限制——分片能力尚未建，别以为有什么参数能解决。现状下的缓解只有人工约定：错开时间窗、或让每台机器只管自己注册进盯梢的 PR（pr-autopilot 的盯梢按注册隔离，谁注册谁盯；但注册与巡审是两条独立链路，巡审侧的抢单不受注册隔离保护）。
- **`engine-mivo.json` 不能直接拷** —— ⚠️ 里面的 `feishuCmd` / `slackCmd` 是指向**本机 owner** 的告警脚本路径（bug-doctor notify.mjs 的 Slack 通道、feishu-alert.mjs 的飞书通道）：原样拷过去 = 对方机器上的巡审结果、预算告警、健康告警**发进我们的群里**，等于把我们机器的通知目标装到了别人机器上。部署者必须**本地化通知配置**（把这两个字段改成自己的告警通道）。这条没有机器门在拦——字段只是路径字符串，机器无法验证它指向谁的通知——纯靠部署时自觉，写在这里就是要让这份拷贝刺眼。

## 3. 每日卡片调度（§3）

- cron: `0 10 * * *`；agent 模式；四元组 `claude-code + Cindy AI + deepseek/deepseek-v4-pro + max`。
- 第一段 collect.mjs（确定性）→ 第二段 DeepSeek 逐项改写 → render-validate.mjs 机器门
  （失败重试 1 次 → 回退 fallbackRender，绝不发未过验输出）→ 发送通道按 §3.1 ①→②→③。

## 4. 自进化周会调度（§1.3a）

- cron: `0 0 * * 1`；四元组 `claude-code + Cindy AI + claude-sonnet-5 + xhigh`。
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
