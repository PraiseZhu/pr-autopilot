#!/usr/bin/env node
// 班车 preRunHook 探针 — 空转轮零 token（owner 质询「为什么每 15 分钟白起会话」的答案）
// 协议（Cindy scheduler preRunHook 约定）:
//   exit 0 = 有活 → 放行班车 agent 会话（引擎 + 队列投递）
//   exit 2 = 无活 → 跳过本轮（不起会话，零 token；只花几次带 ETag 的 gh API 读）
// 判定完全复用引擎同源模块（gate.evaluate / stateFileName 文法），不另造第二套信号逻辑。
// 探针自身异常 → exit 0 放行（可用性优先: 让完整引擎 + 通知链去暴露问题，
// 而不是让探针静默扼杀所有轮次）。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, fail, isMain } from '../../scripts/lib/common.mjs';
import { evaluate, emptyCursors } from '../../scripts/pr-watch/gate.mjs';
import { stateFileName, migrateAllLegacyStateFiles, STATE_FILE_NAME_RE } from '../../scripts/pr-watch/register.mjs';

export function probe({ stateDir, queueDir, snapshotCmd, leaseTtlMinutes = 40, hmacKey = null, nowMs = Date.now() }) {
  // 队列有未消费任务（上一班车没送完/晚到回执）→ 有活
  if (queueDir && existsSync(queueDir) && readdirSync(queueDir).some((f) => f.endsWith('.task.txt'))) {
    return { work: true, why: 'dispatch-queue 有滞留任务' };
  }
  if (!existsSync(stateDir)) return { work: false, why: 'state 目录不存在' };
  // R3 修复: 与引擎同源——扫描前先迁移旧命名状态文件（mame/_ 等折叠碰撞旧名），
  // 拒绝（垃圾/冲突）跳过不算有活（引擎会 journal 留痕，不重复触发班车空转）
  migrateAllLegacyStateFiles(stateDir, null);
  const files = readdirSync(stateDir).filter((f) =>
    STATE_FILE_NAME_RE.test(f) && !f.startsWith('manifest-') && !f.startsWith('receipt-'));
  if (files.length === 0) return { work: false, why: '无在册 PR' };
  for (const f of files) {
    let state;
    try { state = JSON.parse(readFileSync(join(stateDir, f), 'utf8')); } catch { continue; }
    if (stateFileName(state.owner, state.repo, state.pr_number) !== f) continue;
    if (state.pending_dispatch?.canceling) return { work: true, why: `${f}: canceling 待引擎收敛` };
    if (state.pending_dispatch) {
      const age = (nowMs - Date.parse(state.pending_dispatch.dispatched_at)) / 60000;
      if (age > leaseTtlMinutes) return { work: true, why: `${f}: 修复租约过期（${age.toFixed(0)}min），需重派` };
      continue; // 在途且未过期 → 本 PR 无新动作
    }
    const parts = snapshotCmd.split(' ').map((p) =>
      p.replace('{owner}', state.owner).replace('{repo}', state.repo).replace('{pr}', String(state.pr_number)));
    const snapshot = JSON.parse(execFileSync(parts[0], parts.slice(1), { encoding: 'utf8' }));
    if (snapshot.state === 'merged' || snapshot.state === 'closed') return { work: true, why: `${f}: 终态待结算/清理` };
    if (state.status === 'cleanup-pending') return { work: true, why: `${f}: cleanup-pending 待重试` };
    const res = evaluate(state.cursors ?? emptyCursors(), snapshot, { hmacKey });
    if (res.decision === 'actionable') return { work: true, why: `${f}: 新信号 ${res.signals.join('/')}` };
  }
  return { work: false, why: '全部在册 PR 无新信号' };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args['state-dir'] || !args['snapshot-cmd']) {
    fail('用法: probe.mjs --state-dir <dir> --snapshot-cmd "<cmd>" [--queue-dir <dir>] [--lease-ttl-minutes 40]', 1);
  }
  let r;
  try {
    r = probe({
      stateDir: args['state-dir'], queueDir: args['queue-dir'] ?? null,
      snapshotCmd: args['snapshot-cmd'],
      leaseTtlMinutes: Number(args['lease-ttl-minutes'] ?? 40),
      hmacKey: process.env.PR_AUTOPILOT_HMAC_KEY ?? null
    });
  } catch (e) {
    process.stderr.write(`[PROBE] 探针异常（放行班车，让引擎/通知链暴露问题）: ${e.message}\n`);
    process.exit(0);
  }
  process.stderr.write(`[PROBE] ${r.work ? 'RUN' : 'SKIP'}: ${r.why}\n`);
  process.exit(r.work ? 0 : 2);
}
