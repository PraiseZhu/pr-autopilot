# 部署指南（macmini = 红线载体）

> 计划依据: docs/plan.md §4 P0 清单 / §5 阶段出口 / W-2 / W-7 / §1.3a。
> **部署前提: P0 清单 ①〜⑫ 全部有确定答案**（首件事 = 修 mini gh token）。
> 本仓是台本容器；mini 上跑的是它的 clone。台账数据留 mini 本地与各业务仓，不回推本仓。

## 0. 前置（P0，不做完不许开调度）

1. mini `gh auth status` 有效（token 失效是当前第一阻塞）。
2. mini clone cindy（base = `makecindy/cindy`；fork 流程 push 目标 = `PraiseZhu/cindy-fork`）与 mivo 各一份 checkout。
3. 飞书: owner 先私聊一次 Mivo bot；W-7 三前提实测（launchd 环境凭证可读 / bot API 可达 / 真实试发成功，凭证不落库不打日志）。
4. `sessions.dispatch` 端到端: 从 script 调度起 GLM 会话，session meta 落盘核对四元组
   `agentKind=claude-code + provider + claude-sonnet-5 + xhigh`（不是只看 dispatch 成功）。
5. goal skill 在 mini 可用，且已含 `--until-sc` 模式。
6. deepseek effort=max 可用性（不支持 → 降 xhigh + 首张卡片脚注告知 + ledger 审计）。
7. ~~preRunHook 失败语义实测~~（2026-08-08 已确认：Cindy host preRunHook 为 **fail-open**，部署必须用仓内 `deploy/wrappers/probe.mjs` 包装为 fail-closed，见 §2.1 ③；不再作为实测项）/ missed-fire 补跑语义实测；调度会话调 cindy_feishu_bot 是否 NO_CHAT_CONTEXT。

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
    "estimate": 3
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
- `estimate` 是**行为参数**（`reserveBudget()`（`scripts/pr-watch/budget.mjs` 导出，engine 的
  dispatch 路径调用它预留，当前约 `engine.mjs:295`——以符号为准，行号会漂移），不是注释）——
  mivo 示例取 `3`：外部部署实测单样本 $1.41，保守取整为 3。
- **完工结算（机械，人工只作兜底）**：`complete.mjs` 成功路径在 **ack 之前**把该 dispatch 的
  reserve 机械结算为 actual（`settleDispatchBudget()`，`scripts/pr-watch/budget.mjs`）：
  - 调用方可传 `--actual <usd>` 用**真实成本**结算（settlement=`actual`）；
  - 调用链拿不到真实成本时，缺省以 **state 固化的 `pending_dispatch.budget.estimate`** 结算
    （settlement=`estimate`，显式标记**估算结算**，后续同 id 真实成本入账可覆盖该值，
    见 `foldDispatchStates`）——**权威账本与估算值只认 pending，不信任 manifest.budget**
    （manifest 是投递给修复会话的可变文件，会话可把 ledger 指向坏账本、把 estimate 改成 0
    洗账，信任它等于把结算权交给被修复方；旧版本派发的 manifest 无 budget 字段时同样从
    pending 自动收口，2026-08-08 GPT R2）；
  - **结算与 ack 同一 state-lock 临界区**（`settleAndAckDispatch()`，
    `scripts/pr-watch/ack.mjs`）：结算落账与 pending 清空之间无窗口——结算抛错即整个收口
    失败，pending 原样保留，不产生「已结算但 pending 未清」的半状态；
  - **结算失败 fail-closed**：不 ack、不清 pending、游标不动——引擎按 at-least-once 重派，
    重跑 complete 幂等（同 id 已结算则跳过，不追加台账行；`isDispatchSettled` 扫**全账本**
    按 dispatch_id 折叠，跨日重试不会重复结算；`spentToday` 仍只聚合当日）；
  - 成功 ack 后**绝不保留 reserve**；人工 `budget.mjs --record --dispatch-id <id> --cost <实际>`
    只是**纠偏兜底**（真实成本补记 / 非引擎标准派发的遗留 pending 人工核账），不是常规结算路径。
- **reserve 幂等判定扫全账本（2026-08-08 GPT R3）**：`reserveBudget()` 的 already 判定（
  `budget.mjs:145`）用**全历史 fold** 按 dispatch_id 折叠，**当日 cutoff 只属于 cap 计算**
  （`spentToday` 内部按当日 fold）。跨日语义：
  - 昨日已结算（reserve+actual）→ 今日同 id `reserveBudget` 返回 `already-settled`，
    不追加行、不占今日额度——避免昨日结算过的 dispatch 今日被重复 reserve 重复占额；
  - 昨日未结算在途 reserve → 今日同 id 返回 `already-reserved`，不追加行；返回的 `spent`
    为**当日口径**，昨日在途不计入今日 spent；今日 cap 按日重置，昨日占额不滚入今日
    （cap 30/天的「天」是自然日，不是滚动窗口）；
  - **在途 reserve 不会悄然释放**：昨日在途今日同 id 仍被认作占额幂等放行；其收口结算
    （`settleDispatchBudget`）时以 actual 计入**结算当天**的 spent，与 SC-B4 语义一致。
  - 反向变异（改回当日 fold）恰好红 SC-D1/D2 断言（`fixtures/run-fixtures.mjs`），锁定该口径。
- **敞口算式**：cap 30 ÷ estimate 3 = 单日最多 **10 个**并发未结算 reserve（若沿用旧值 9.2 则仅
  3 个）。风险：并发未结算 reserve 上限 3 → 10，最坏坏账放大约 **3.3 倍**；收益：正常日不再因
  3 个在途 reserve 顶闸停派。完工即结算后，**陈旧 reserve 只存在于「派发到 complete 收口」的
  在途窗口**——连续完工不会因未结算残留顶闸（fixture: cap=30/estimate=3 下 12 次完工不暂停）。
- **`pendingStuckHours`（超时告警阈值，默认 6 小时）**：引擎启动时仅接受**有穷 number 且 > 0**；
  字符串 / `NaN` / `Infinity` / 负数 / `0` 一律**启动即拒（fail-closed）**，在扫描与通知之前抛错，
  零副作用——本任务明确**不支持用 0 禁用**告警。年龄基准 = `first_dispatched_at`（重派不更新），
  去重标记持久化在 `pending_dispatch.pending_stuck_notified`（通知失败也置位，宁丢一次不刷屏）。
- **cindy 引擎各有 config**（engine-cindy.json 等），estimate 取值由部署者按同口径自行判断调整，
  本示例只校准 mivo 侧，不代改其他引擎的 config。
- `repoDirs` 缺某仓时该仓终态清理 fail-closed（cleanup-pending 不销单，审③-I2-R）——两仓都必须配。
- 注册命令（审⑤-F4: `--branch` 与 `--push-remote` **必填**，引擎不猜 remote 名）:
  - mivo: `node scripts/pr-watch/register.mjs --state-dir … --owner xindong --repo mivo-canvas --pr <N> --branch <feature> --push-remote origin`
  - cindy: 同上，另加 `--push-remote fork --push-repo PraiseZhu/cindy-fork`
    （finalize 会把该 remote 的 push URL 与 push-repo 仓名绑定，upstream 冒充被拦）。
    **前置**: cindy checkout 的 origin/base = `makecindy/cindy`（canonical），checkout 里必须存在
    名为 `fork` 的 remote 指向 PraiseZhu/cindy-fork
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

### 2.1 环境变量与接线（不配齐会以误导性症状失败，不是直接报错）

> 每条「后果」都逐跳落到 `文件:行号`（已核实）；落不到行号的写「成因未定」——空白比推测有用。
> 症状名（如「budget cap 撞顶」）可能误导你对根因的判断，务必读因果链本身。
> **本节按后果导向重写过**：原先「每个变量映射一个症状」的组织方式没有经验证的引擎反应模型支撑，那三条症状映射已被证伪或无法验证，故整节重构。**下表是重写后的结果——每条后果都逐跳落到已核实的 `文件:行号`**；落不到行号的在正文里明写「成因未定」或「需 mini 实测」。判断依据可直接引：
> - `docs/plan.md:163-164` W-2 首扫空目录立即退出；W-3 按类游标、exact-head、评论 node-id、CI 状态跃迁、at-least-once/副作用幂等；
> - `docs/plan.md:31,42,83-84` 空清单零 GitHub 请求 / 零 LLM / 零 token；引擎每仓一条 schedule、空 state 目录秒退；
> - `scripts/pr-watch/gate.mjs:3-10,16,61-75` 按类游标、同 head 的 `ci_red_sha` 去重（`:61`）、ack 后推进（nextCursors 在 `:70-75`）；
> - `scripts/pr-watch/engine.mjs:188-262` pending 单飞、租约到期同 id 重派（`:238-262`；重派失败持久化 `redispatch_count` 在 `:256` 且计入 stuck 判据 `:240`）、每轮记 `waiting` 事件（`:217-221`，`waiting_for` 仅 `'ack'`）、超 `pendingStuckHours`（默认 **6h**，`:71`，可经 config 覆盖）记 `pending-stuck` 告警（`:225-234`，年龄基准 = `first_dispatched_at`——首派写入 `:349`、旧 state 缺字段先原子回填 `:191-196`）；reserve 仅新 actionable dispatch（`:295`）；首派失败记 `dispatch-failed`（`:361`）；
> - `deploy/wrappers/probe.mjs:2-6` preRunHook 的 exit 2 / 不启动会话协议。

| 变量/项 | 作用 | 已验证的直接后果（逐跳） |
|---|---|---|
| `PR_AUTOPILOT_HMAC_KEY` | 自家评论识别密钥（complete 校验回帖落地、gate 过滤自家评论） | 无 key → 修复完工回执校验失败 → 卡 pending → 最终 stuck 通知（①） |
| `REQUIRED_CONTEXTS_FILE` | CI 判绿的 required contexts 清单（JSON 文件路径） | 无配置 → 每 head 首扫判 CI 红 → 该 head 首次唤醒；**投递失败则下轮重试（at-least-once），不保证跨轮静默**（②） |
| `SNAPSHOT_CACHE_DIR` | gh-snapshot 响应缓存/ETag（条件请求） | 不配 → 每轮探针都是**普通 API 请求**，配额被静默低估（②b） |
| preRunHook | 班车调度跳过空转轮 | 宿主 preRunHook 已确认 **fail-open**（探针失败/异常也放行会话启动）——不接 probe 则每周期必起 agent 会话，空转轮也烧 token；必须接 `deploy/wrappers/probe.mjs` 用 exit 2 协议把「无活」变成真正的跳过（包装为 fail-closed），并注意退出码边界（③） |

**① `PR_AUTOPILOT_HMAC_KEY` —— 没配会卡在 pending 并最终触发 stuck 通知（有告警，不是静默）**

```bash
export PR_AUTOPILOT_HMAC_KEY=$(openssl rand -hex 32)   # 每台机器独立生成，禁止拷贝别人的
```

- **生成与形状**：`openssl rand -hex 32` 即可（HMAC key 无格式约束，任意字符串都行；64 位十六进制只是惯例）。**谁读 env**：`deploy/wrappers/probe.mjs:60` 读 `process.env.PR_AUTOPILOT_HMAC_KEY` 后传给 `gate.evaluate`；`scripts/pr-watch/engine.mjs:73` 默认读 env，但 main() 的 `runEngine({ ...extra })` 配置合并处（`engine.mjs:380-386`，`...extra` 展开在 `:385`）可被 `engine-*.json` 里的 `hmacKey` 字段**覆盖**（`engine.mjs:73` 只是 env 默认值，覆盖发生在 `:380-386`）；`scripts/pr-watch/complete.mjs:59` 读 env 传给 `checkCompletion`；`scripts/pr-watch/provenance.mjs` 本身**不读 env**，只接收调用方传入的 key 参数。**不落盘、不打日志**。
- **每台机器必须独立生成**：它是「这条评论是不是我自己发的」的识别凭证，不是共享口令。拷别人的 key = 两台机器互认对方回帖为自家，签名校验的意义归零。
- **没配会怎样（三层，别混）**：
  - **gate 侧先说明白（login 早退）**：`gh-snapshot:117` 尝试拿 `selfLogin`（拿不到 → 宁多唤醒，`author_is_self` 为 false），`gate:54` 先跳过 `author_is_self === true` 再对剩余评论用 HMAC。所以 **login 可得时，无 key 不会因 HMAC 导致自家评论被当成新反馈**；HMAC 只在 login 不可得（拿不到 `ghGet('user')`）时才是识别自家回帖的那一层。
  - **已验证机制（前提：worker 已提交一条待核验的回帖）**：**在 worker 已提交待核验回帖的前提下**，无 key 会让 `complete.mjs:59` 取到空 key → `provenance.mjs:17`（实现：`if (!key) return false`，「无法验证 → 不声称是自家的 → 宁多唤醒」；`complete.mjs:36` 只是调用点）→ `:38` 判「回帖未落地」→ `:62` exit 1（checkCompletion 失败分支——副作用缺失即拒；预算结算失败是另一条独立失败分支 `:88`），**ack 不发生**（`settleAndAckDispatch` 只在 checkCompletion 通过**且**结算成功后的 `:71` 发生——结算与 ack 同一 state-lock 临界区，见 §2 estimate 段）→ `pending_dispatch` 保持在途 → 引擎 `engine.mjs:238-262` 只按 lease 超时（`:238`）重派**同一个 dispatch_id**（`budget.mjs:145` reserve 对同 id 幂等，`already-reserved` 直接放行不重复占额，幂等放行在 `:157`）→ 重派 ≥ `stuckThreshold` 次 → `engine.mjs:239-242` 记 `stuck` + `:243-248` routeNotify 发通知。**这是可能路径，不是无条件后果**——真实表现（在该前提下）= 卡在 pending、最终触发 stuck 通知（有告警，不是静默；通知为 best-effort——发送失败只记 `notify-error` journal `engine.mjs:248`，不重试不补发，见 §2.1 ③）。
  - **已验证的间接预算影响（代码支持的可能路径，未在真实事件中证实）**：`complete` 未 ack → `pending_dispatch` 连同**原 dispatch 的 reserve 一起长留**（`engine.mjs:346-352` pending_dispatch 固化含 `budget: {ledger, estimate}`，以符号 `pending_dispatch.budget` 为准）→ 该额度不释放，与后续真实 dispatch 竞争同一个 cap；而重派路径**不调用 reserve**（reserve 只在无 pending 且判 actionable 的新 dispatch 路径，`engine.mjs:295`，以符号 `reserveBudget` 为准）。**这条是代码支持的可能机制，不是已证实因果**——不要当成新的因果断言。成功路径的 reserve 由 `complete` 在 ack 前机械结算（见 §2 estimate 段），不依赖人工 `--record`。
  - **不可归因**：外部部署方那次「$30/天 cap 撞顶」**成因未定**——本 checkout 没有「缺 key → 每轮新 dispatch_id → 每轮 reserve」的路径（重派复用同 id + reserve 幂等），且该事件无运行时台账/序列证据。**不要归因到 HMAC key，也不猜替代解释**。
- **强度如实声明（T1，无机器门在拦）**：引擎启动时不校验 key 是否存在（`engine.mjs:73` `?? null`，没有 fail-closed 启动门）；这道门防的是「自家评论误唤醒自己」的**疏忽**，不防**伪造**——知道 key 的人可以伪造签名评论。配不配 key 全靠部署时自觉，机器不拦。

**② `REQUIRED_CONTEXTS_FILE` —— CI 判绿的权威来源**

```bash
export REQUIRED_CONTEXTS_FILE=/path/to/required-contexts.json
```

```json
{ "<owner>/<repo>": ["<用下面 gh api 命令取到的实际 context 名>"] }
```

- **格式**：`{"owner/repo": ["ctx 名"]}`（`deploy/wrappers/gh-snapshot.mjs:144` 读 JSON 后按 `[owner/repo] ?? []` 取值）。
- **注入位置 = 启动引擎的那条命令本身**——与 `source env.sh` 并列 export，例如：
  ```bash
  source ~/pr-autopilot-runtime/env.sh && \
    export PATH=/opt/homebrew/bin:$PATH REQUIRED_CONTEXTS_FILE=/path/to/required-contexts.json && \
    node <引擎入口> …
  ```
  本机在跑的部署就是这么做（Cindy schedule 的 prompt 里写死这条命令；外部实证，本地不可复验）。
- **env.sh 是否生效（精确条件）**：
  - **生效（本仓可证）**：同一 shell / 同一调度会话里 `source env.sh` 后再启动 engine（前台、后台、或该 shell 直接 exec 子进程）→ 变量进 `process.env`，并由 engine 的 `execFileSync` 子进程继承（`deploy/README.md:123`「班车会话 source env.sh 后**后台**跑 engine」+ `engine.mjs:23-28` execFileSync 启动子命令，调用在 `:27` + `gh-snapshot.mjs:143-144` 从 `process.env` 读）。
  - **失效（两种）**：① 只在某个会话 source 了 env.sh，engine 却由**另一个已存在或独立启动的 scheduler / launchd 会话**拉起——后者不继承前者环境；② source 的那个 shell 随后退出，再由独立 scheduler 拉起 engine——同样失效。此时才需要像上面那样在启动命令上并列 export。
  - **边界（必须知道）**：本 checkout 只能证明普通 Unix 子进程继承与本仓命令链，**不能证明 Mac mini 上 Cindy scheduler 的真实会话边界**（`env.sh`、schedule 启动命令、launchd runtime 都不在 checkout 里）。所以「别人这么塞没生效」**不能写成本仓事实**，是外部实证/本地不可验。
  - **顺带：非交互 shell 的 PATH 里没有 `node`**（本机踩过，mini 的 node 在 `/opt/homebrew/bin`），部署时不显式加 PATH 会静默失败——上面命令行里的 `export PATH=…` 就是干这个的。
- 备选（**未实测**）：launchctl setenv 或 plist EnvironmentVariables 注入调度进程环境，理论同效。
- **取值权威来源 = 分支保护 API 的实际值，不是人手抄 workflow 名**：`gh api repos/{owner}/{repo}/branches/main/protection --jq '.required_status_checks.contexts'`（或仓库 Settings → Branches → 保护规则 → Require status checks 里看到的清单）。手抄名字会漂移——分支保护里改名/增删后，清单不跟着变，CI 判绿就失真。
- **两类 check 绝对不能进这份清单（同一类陷阱的两个变种）**：
  - **`SKIPPED` 不算绿**：gh-snapshot 归一化 check-run 时只有 `conclusion == success` 才映射为绿，`skipped`/`neutral`/`cancelled` 一律非绿（`gh-snapshot.mjs:135`；`scripts/ci-readiness.mjs:33` `entry.state !== 'success'` → fail-closed 非绿）。按路径过滤的 job（改动不命中就 SKIPPED）一旦进清单，该 PR 永远判不绿。
  - **只在 `pull_request` 事件上跑的 job 同样不能列**：它在 main push 上根本不产生 check，列进去 = 永远等一个不会来的绿。真实案例：mivo 仓（`xindong/mivo-canvas`）`.github/workflows/deploy-green-ref.yml` 的 `REQUIRED_ON_MAIN` 数组上方注释（本机踩过并写死在注释里的教训，措辞以该文件当前内容为准）——e2e 系列 job 是 pull_request-only，main push 上不存在，不能列（列了 ref 永远不动）；bench / deps audit / semgrep baseline / coverage report 是设计上的非阻断，不纳入。**设计上非阻断的 job（bench / audit / baseline / coverage 类）也不进清单**。
- **没配/文件缺失 = fail-closed 非绿，同一 head 的 ci-red 在本轮之内判一次并去重**：gh-snapshot 对未配置的 required 返回 `green: false` + `['required contexts 未配置（fail-closed）']`（`gh-snapshot.mjs:147`）→ gate 对**同一 head** 的 ci-red 用 `cursors.ci_red_sha !== head` 去重（`gate.mjs:61-62`）——**前提是状态真的落盘了（投递成功、pending/ack 已持久化）**；若投递失败，`engine.mjs:356-363` 释放预留（`:358`）且**游标不推进**（「下轮重试 = at-least-once」，失败记 `dispatch-failed` journal 事件 `:361`），`engine.mjs:364` 落盘的状态里没有 pending/cursor 推进，下一轮 gate 仍见 `ci_red_sha != head` → 仍 actionable → **可能每轮重新启动 agent**（`fixtures/run-fixtures.mjs:1194-1246` 已覆盖首派/重派连续失败重试；重派失败同样持久化 `redispatch_count`（`engine.mjs:256`）并计入 stuck 判据（`engine.mjs:240`））。**不保证低唤醒/低 token**——别据此估预算。（早期版本写「CI 永远红 → 每轮都唤醒」不成立，已更正；本段也不构成跨轮静默保证。）

**②b `SNAPSHOT_CACHE_DIR` —— 不配 = 每轮探针都是普通 API 请求，配额被静默低估**

```bash
export SNAPSHOT_CACHE_DIR=/path/to/snapshot-cache   # 与 REQUIRED_CONTEXTS_FILE 同法注入启动命令
```

- gh-snapshot 只在 `SNAPSHOT_CACHE_DIR` 非空时启用响应缓存 + ETag 条件请求（`gh-snapshot.mjs:16` `CACHE_DIR = process.env.SNAPSHOT_CACHE_DIR ?? null`；判非空分支 `:27-31`、写缓存 `:62`，均在 `CACHE_DIR` 非空分支内）。
- **不配的后果**：每轮探针/引擎的 gh API 请求都是普通请求，不发 `If-None-Match`、拿不到 304——**没有报错，唯一信号是 GitHub API 配额被静默低估**（探针每班车周期一次 × 在册 PR 数 × 多接口，长期累积可观）。
- **配置了也有运维前提（不是无副作用）**：正常可读写时**不改变判定协议**——ETag 命中（304）只省 API 调用，非绿判据不变（`gh-snapshot.mjs:27-31` 判非空、`:62` `mkdirSync(CACHE_DIR,{recursive:true}) + writeFileSync(cacheFile,…)` 真实文件系统写入）。但**缓存目录不可写或既有缓存内容损坏会抛错**（`:28` 解析既有 cache、`:62` 写 cache）→ wrapper 自身 `:178-180` **exit 1**。注意 **exit 1 不等于「CI 判非绿」**——快照没产出，走不到绿/非绿判定：`engine.mjs:115-119` 捕获快照失败后只写 stderr（「保持状态，下轮重试」）并 `continue`，**跳过该 PR 本轮、不进 gate**；`probe.mjs:59-61` 对运行期异常是 **exit 0 = fail-open**（注释原文「放行班车，让引擎/通知链暴露问题」），班车照常起。所以缓存故障的真实表现是**本轮静默跳过 + 班车仍被放行**（可能反复耗 token），**不是 fail-closed 拦停**——必须修好缓存目录/文件才会恢复正常判定。这是一条运维前提（目录权限 / 磁盘可写 / 缓存文件可解析），不能当成「无副作用」。
- 这条是**配置项**，不是可选优化——部署时必须显式配，配了才算用了 ETag；并确保缓存目录可写、缓存可解析。

**③ preRunHook 必须用 `deploy/wrappers/probe.mjs`，别自己造一个**

班车 schedule 的 preRunHook 直接用本仓现成的 `deploy/wrappers/probe.mjs`，不要另写：

- **三条退出路径（都要接对）**：
  - `exit 0` = 有活 → 放行班车 agent 会话（引擎 + 队列投递）；**或运行期异常放行**（`probe.mjs:59-61` catch → exit 0，可用性优先：让完整引擎 + 通知链去暴露问题，而不是让探针静默扼杀所有轮次）；
  - `exit 2` = 无活 → 跳过本轮，**零 token**，只花几次带 ETag 的 gh API 读（`probe.mjs:64`）；
  - `exit 1` = **参数/初始化错误**（`probe.mjs:47-50` 在 try 外 `fail(...,1)`，模块导入/初始化异常也不在 catch 内），**不受 fail-open 保护，且本仓未定义调度侧如何处理 exit 1**——这是调用姿势错了，不是「探针异常」。（本仓只有 exit 0/2 协议。）
- **宿主 preRunHook 失败语义 2026-08-08 已确认：fail-open**——preRunHook 失败/异常不会拦停班车会话，宿主照常启动；所以「不接 probe 会怎样」从「可能每周期启动会话（需实测）」升级为**确定的**「每周期必起会话、空转轮也烧 token」。fail-closed 的唯一来源是把 probe.mjs 的 `exit 2` 接进宿主 preRunHook（无活 → 真正跳过）；本仓源码自身没有「preRunHook 失败 → 拦停」的 fail-closed 路径（曾写「源码 fail-closed / 待实测」的旧说法已随 T4 更正，P0 项 ⑦ 见 `deploy/README.md:16`）。
- **通知链是 best-effort，别依赖「收到」当验收**：`pending-stuck`（`engine.mjs:225`）与 `stuck`（`engine.mjs:240`）、`budget-pause`（`engine.mjs:297`）的发送失败都只记 `notify-error` journal 事件，**不重试、不补发**；`pending_stuck_notified` 去重标记在**尝试发送后即置位（含发送失败）**——取舍是宁丢一次不刷屏（`engine.mjs:222-224` 注释原文）。判断「告警是否被发出」以 journal 的 `notify-error` 有无为准，不能假设必达。
- **`stuck` / `pending-stuck` 的路由（T3 定案，`notify-router.mjs` 的 `route()`/`isCindyRepo()`）**：以 **canonical owner/repo 判 cindy**（2026-08-08 GPT 审查修复，不再用裸 repo 名子串猜身份）——**cindy 仓（引擎传 `${owner}/${repo}` 全名，判据 = `makecindy/cindy`）→ `silent`（不产生任何通知，只记 journal）**；**其他仓（如 `xindong/mivo-canvas`、`PraiseZhu/pr-autopilot`）→ `feishu` 通道**。兼容旧调用：只传裸 repo 名（如 `cindy`）时判据为字面 `cindy`。pending-stuck 与 stuck 同通道、不落 ROUTES 表（否则 null 值会撞「未知事件类型」fail-closed）。「卡死无人知」在 cindy 仓是设计行为（W-6: cindy PR 卡死不打扰），不是漏配。
- **部署动作**：接进 schedule 前**先手动跑一次**确认拿到 0 或 2；拿到 1 说明参数/调用姿势错了，fail-open 不会救你。
- 它的判定**复用引擎同源模块**（`gate.evaluate` / `stateFileName` 文法），信号逻辑与引擎是**同一套**——自己另写一个探针等于造第二套判定，两套迟早不一致（探针说有活、引擎说没活，或反过来），凭空多一个故障面。
- **状态文件名 = v3 单射编码（2026-08-08 GPT R3 修复）**：`stateFileName(owner, repo, pr)` 段内容 = `encodeURIComponent(lower(段))` 再补转义 `_`→`%5F`——段内字符集 `{A-Za-z0-9.%!~*'()-}` 无裸 `_`，`__` 分隔无歧义，`mame/_` 与 `mame/-` 等任意已允许标点不碰撞；大小写归一（GitHub identity 大小写不敏感 + macOS APFS 大小写不敏感双保险）。**升级兼容**：无折叠字符的 ASCII 名（`o/mivo-canvas`）文件名与 v2 逐字一致、零迁移；含折叠字符的旧注册（`mame__-__7.json` 之类）由 engine/probe 扫描前与 register/ack/finalize 按身份解析时**自动原子迁移**（`migrateLegacyStateFile`）——旧命名文件迁移后照常派发，名实不符垃圾/迁移目标身份冲突则 journal 拒绝并留人工恢复提示，绝不静默漏扫或覆盖。旧 receipt 同理随 `manifest.dispatch_id` 二次校验迁移，且 **R4 起迁移并入 per-state 锁内串行**（2026-08-08 GPT R4 修复）：`receiptPathLocked` 为锁内 helper（finalize/ack 等已持锁的调用点用），`receiptPath` 为锁外公共 API（自行持同一把 state 锁后调 helper）——锁内重新检查 canonical 目标，**绝不 rename 覆盖已存在的 canonical receipt**（旧实现锁外两步「检查→rename」有 TOCTOU，窗口期被另一进程写入 canonical 会被 rename 静默覆盖）。canonical 已存在时：同 dispatch = 幂等视为已迁移（legacy 保留不删）；不同 dispatch 且 legacy 待迁移 = 显式冲突抛错（两文件保留、调用方 fail-closed，人工核对 canonical 归属）；只读核对（cancel 无 dispatch_id）不迁移不抛错、canonical 优先。

**④ 多实例部署（2026-08-07 从外部部署者真实踩坑回填）**

- **双机同时巡审：目前没有内建的按作者分片手段**。实测核实：review-pr 的 `--auto` 批量扫**所有**可审查的 open、非 draft PR，无作者过滤参数；pr-autopilot 引擎按 state 目录扫全部在册 PR，注册（`register.mjs`）也不含 author 维度。两台机器各自跑巡审会**抢同一批 PR**：同一 PR 被两家重复审查、重复评论（selfFixAuthors 触发还会交叉改同一 PR）。**这是 T1 之外的真实空缺**，不是设计限制——分片能力尚未建，别以为有什么参数能解决。现状下的缓解只有人工约定：错开时间窗、或让每台机器只管自己注册进盯梢的 PR（pr-autopilot 的盯梢按注册隔离，谁注册谁盯；但注册与巡审是两条独立链路，巡审侧的抢单不受注册隔离保护）。
- **`engine-mivo.json` 不能直接拷** —— ⚠️ 里面的 `feishuCmd` / `slackCmd` 是指向**本机 owner** 的告警脚本路径（bug-doctor notify.mjs 的 Slack 通道、feishu-alert.mjs 的飞书通道）：原样拷过去 = 对方机器上的巡审结果、预算告警、健康告警**发进我们的群里**，等于把我们机器的通知目标装到了别人机器上。部署者必须**本地化通知配置**（把这两个字段改成自己的告警通道）。这条没有机器门在拦——字段只是路径字符串，机器无法验证它指向谁的通知——纯靠部署时自觉，写在这里就是要让这份拷贝刺眼。

### 2.2 补注册接线（reconcile 班车，T1）

自己名下没走注册流程的旁路 PR，由 `deploy/wrappers/reconcile-own-prs.mjs` 补注册进盯梢。
**生产入口 = 每仓一条 15 分钟 schedule**（`*/15 * * * *`，execution_mode=script，零 LLM）——
mivo → state-mivo、cindy → state-cindy，与盯梢引擎、每日卡片（§3）解耦独立调度：

```bash
# mivo 仓
node ~/pr-autopilot/deploy/wrappers/reconcile-own-prs.mjs \
  --repo xindong/mivo-canvas \
  --state-dir ~/pr-autopilot-runtime/state-mivo \
  --remote-map-file ~/pr-autopilot-runtime/remote-map.json
# cindy 仓（canonical base = makecindy/cindy；fork 身份 = PraiseZhu/cindy-fork）
node ~/pr-autopilot/deploy/wrappers/reconcile-own-prs.mjs \
  --repo makecindy/cindy \
  --state-dir ~/pr-autopilot-runtime/state-cindy \
  --remote-map-file ~/pr-autopilot-runtime/remote-map.json
```

remote-map.json（base 仓全名 → 该仓 checkout 里修复 push 用的 remote 名；注册时必须显式声明，
引擎不猜，同 §2 注册命令的 `--push-remote` 语义。key 一律要求严格 owner/repo 形状——
`/foo`、`foo/`、多斜杠、非法字符的 key 会在启动前被拒）:

```json
{ "xindong/mivo-canvas": "origin", "makecindy/cindy": "fork" }
```

- **fail-closed 分层**：启动前校验 remote-map（不可读 / JSON 非对象 / 缺当前 `--repo` key /
  alias 非法或空串）即非零退出；gh 失败非零；API 脏字段（缺 headRefName、
  `headRepository.nameWithOwner` 缺失或非字符串）该条 dropped + stderr 继续（合法 dropped 不判
  非零）；registerPr 异常（含在途 dispatch 接线变化——`registerPr` 的 wiringChanged 且有
  pending_dispatch 时抛「迁移拒绝」，`scripts/pr-watch/register.mjs` 该分支）记 errors 且该轮非零。
  输出 JSON 四明细 `{registered, already, dropped, errors}`；退出码：配置错 / gh 失败 / errors
  非空 → 非零，其余 → 0。
- **`--author @me` 只作用于补注册 wrapper 这一层**：reconcile 的 `gh pr list --author @me`
  只筛自己名下的 open PR 做补注册，是**注册侧的按作者收窄**。这与 §2.1 ④「多实例部署」里
  「review-pr 的 `--auto` 无作者过滤参数、双机巡审会抢同一批 PR」的声明是**两条独立事实，
  互不混淆**——巡审侧（审查）至今没有按作者分片，补注册侧（盯梢注册）用 `--author @me`
  收窄，两者不互相取消。
- **每日卡片的 ownPrsCmd 是可选辅路**（`scripts/inbox-digest/runner.mjs` 的补注册段）：配了会在
  每日卡片时顺带补注册，不配则跳过。**本期只交付 reconcile 班车这条生产入口，不声称双仓补注册
  已由每日卡片完成**——每日卡片 10:00 一次，旁路 PR 的 24h SLO 由 15 分钟班车兜底。
- **registerPr 幂等**（同 wiring 重跑返回 already、不重置游标/在途 dispatch），15 分钟高频重跑
  安全，不会重复派发或污染在途任务。
- 契约 fixture: `fixtures/own-prs.fixture.mjs`（真实三层接线 wrapper→reconcile→registerPr，
  只 stub gh 二进制）。

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

> **lease 语义（T4 澄清，勿把 lease 当进展信号）**：lease 文件只表示「引擎轮次仍活」——引擎每轮启动时刷新 `{last_success, pid}`（`engine.mjs:92`），健康检查据此判引擎是否在跑（ttl_minutes 过期 → 告警）。**lease 新鲜 ≠ PR 有进展**：引擎活着但某个 PR 的修复会话卡死/重派失败时，lease 照常刷新，健康检查不会因此告警。判断单个 PR 是否有进展要看 journal 事件：`waiting`（每轮对在途 pending 记一条，`engine.mjs:217-221`）、`pending-stuck`（超 `pendingStuckHours` 未 ack）、`dispatch-failed` / `redispatch-failed`（派发失败）；健康告警只管引擎进程本身，管不了 PR 级卡死——后者靠盯梢告警链（`stuck`/`pending-stuck` 通知）。

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
