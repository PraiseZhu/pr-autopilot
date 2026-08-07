#!/usr/bin/env node
// Cindy 修复会话投递适配器 — 计划依据: W-2/W-4（审②-F8）
// stdin = 引擎产出的 pr-fix manifest。职责:
//   1. 把 manifest 变成修复会话投递文本（含 goal --until-sc / finalize / ack 指令与授权声明）
//   2. 经 CINDY_DISPATCH_CMD 注入的传输层投递（P0-⑦ 定案 sessions.dispatch 具体形态后填 deploy 配置；
//      契约: 命令收 stdin 文本，成功输出含 session id 的 JSON）
//   3. 校验传输层回执四元组（agentKind/provider/model/effort）——与期望不符 = 投递失败（I5 session meta 验收）
// 本 adapter 自身不猜 Cindy 内部 API——传输层是唯一环境耦合点，用录制 fixture 验证契约。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// 审③-F8-R: 四元组全量必填 exact match（provider 在内），回执缺任一字段 = 派发失败
//
// 期望值**只有一个来源** = `env.sh` 的 EXPECT_* 四个变量（owner 2026-08-06）。
// 初版这里写了硬编码默认值（`z-ai/glm-5.2` / `max`），于是同一个模型值散在三处：
//   ① Cindy schedule 的 model/effort 列（决定实际用什么模型）
//   ② schedule prompt 里那段 receipt 模板（决定回执写什么）
//   ③ 本文件的默认值（决定校验期望什么）
// 三处必须逐字一致，而 ③ 的默认值会在 ①② 换模型后静默继续用旧值 —— 换模型时只改 ①②，
// 本门会拿旧期望去比新回执，投递被判失败；反过来只改 ③ 则回执与实际不符却能过。
// 改为**缺 env 即 fail-closed**：期望值必须显式来自 env.sh，没有可被抄旧的默认值。
const EXPECT_ENV = {
  agentKind: 'EXPECT_AGENT_KIND',
  provider: 'EXPECT_PROVIDER',
  model: 'EXPECT_MODEL',
  effort: 'EXPECT_EFFORT'
};
const EXPECT = {};
for (const [field, envVar] of Object.entries(EXPECT_ENV)) {
  const v = process.env[envVar];
  if (!v) {
    process.stderr.write(`[DISPATCH] ${envVar} 未设置（四元组期望值只能来自 env.sh，不设默认值以免换模型后静默用旧期望）——fail-closed\n`);
    process.exit(1);
  }
  EXPECT[field] = v;
}

const manifest = JSON.parse(readFileSync(0, 'utf8'));
// 审④-F5: 修复会话必须能直接执行 finalize/complete——缺任一接线字段 = 派发失败
// 审⑤-F4: branch/remote 加入必填——缺任一 = finalize 注定失败的空转派发，投递前拦下
for (const k of ['dispatch_id', 'owner', 'repo', 'pr_number', 'worktree_name', 'state_dir', 'snapshot_cmd', 'manifest_path', 'finalize_cmd', 'complete_cmd', 'original_head', 'branch', 'remote']) {
  if (!manifest[k]) { process.stderr.write(`[DISPATCH] manifest 缺字段 ${k}（会话无法收口，fail-closed）\n`); process.exit(1); }
}

const prKey = `${manifest.owner}/${manifest.repo}#${manifest.pr_number}`;
const text = [
  `【pr-autopilot 修复任务 ${manifest.dispatch_id}】${prKey} 有新反馈: ${manifest.signals?.join('/')}`,
  '',
  '硬规则（逐条执行，缺一即失败）:',
  ...(manifest.rules ?? []).map((r, i) => `${i + 1}. ${r}`),
  '',
  `完整任务参数（自包含 manifest）: ${manifest.manifest_path}`,
  `新信号明细: ${JSON.stringify(manifest.new_items ?? {})}`,
  `worktree 固定名: ${manifest.worktree_name}（重复投递幂等）`,
  `原始 head: ${manifest.original_head}`,
  `push 收口命令（把 <修复worktree路径> 换成你的 worktree）: ${manifest.finalize_cmd}`,
  `完工回执命令（必须执行，否则视为挂死重派）: ${manifest.complete_cmd}`,
  `预算结算: complete 成功路径会在 ack 前自动把本 dispatch（${manifest.dispatch_id}）的 reserve 结算为 actual（缺省按 ${manifest.budget?.estimate ?? 'manifest.budget.estimate'}；你能拿到真实成本时给 complete 加 --actual <usd> 用实值）——不要手工跑 budget.mjs --record（那是纠偏兜底，不是结算路径）`,
  '',
  'OWNER_STANDING_AUTH: PR_PUSH_AND_REPLY',
  'owner 常设授权声明: 本 PR 分支的 push 与 PR 内回帖为已授权动作，不触发对外发消息硬停。'
].join('\n');
if (text.includes('undefined')) { process.stderr.write('[DISPATCH] 投递文本含 undefined（接线缺口，fail-closed）\n'); process.exit(1); }

const transport = process.env.CINDY_DISPATCH_CMD;
if (!transport) {
  process.stderr.write('[DISPATCH] CINDY_DISPATCH_CMD 未配置（P0-⑦ 完成后按 deploy/README 填写）——fail-closed\n');
  process.exit(1);
}
try {
  const parts = transport.split(' ');
  const out = execFileSync(parts[0], parts.slice(1), { encoding: 'utf8', input: text });
  const receipt = JSON.parse(out);
  if (!receipt.session_id) throw new Error('传输层回执缺 session_id（无 durable ack 不算派发成功）');
  // F8-R: 四元组必须**全部到场且逐字匹配**——缺字段=fail-closed（不带元数据的回执不算成功）
  for (const [k, want] of Object.entries(EXPECT)) {
    if (receipt[k] === undefined) throw new Error(`session meta 回执缺字段 ${k}（fail-closed: 四元组必须全量回报实际落盘值）`);
    if (receipt[k] !== want) throw new Error(`session meta 四元组漂移: ${k}=${receipt[k]} ≠ 期望 ${want}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, session_id: receipt.session_id }) + '\n');
} catch (e) {
  process.stderr.write(`[DISPATCH] ${e.message}\n`);
  process.exit(1); // 引擎收非零 → 游标不推进 → 下轮重试（at-least-once）
}
