#!/usr/bin/env node
// 盯梢引擎 v3 — 计划依据: W-2/W-3/W-5/W-6/§0.3-I6
// 审③修复:
//   F14  : 每 PR 状态变更全程持 per-key mkdir 锁（与 ack/complete 同一把），
//          engine 读改写不再与 ack 竞态
//   F13-R: budget 配置必填（缺失即启动失败 fail-closed）；dispatch 前原子 reserve
//          （spent+estimate>cap 即暂停），两仓 schedule 共享 ledger 防竞态双派
//   F6-R : ack 由 complete.mjs 在 push+回帖两项副作用确认后触发（引擎只认 ack）
//   F7-R : blocked-external 不消费游标（gate 已改），解除 hold 后信号仍在
//   I2-R : repoDirs 缺失 = 清理 fail-closed → cleanup-pending，不销单
import { readdirSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, writeJsonAtomic, parseArgs, fail, nowIso, sha256, canonicalJson, isMain} from '../lib/common.mjs';
import { withLock } from '../lib/state-lock.mjs';
import { evaluate, emptyCursors } from './gate.mjs';
import { unregisterPr, stateFileName, migrateAllLegacyStateFiles, STATE_FILE_NAME_RE } from './register.mjs';
import { reserveBudget, releaseReserve } from './budget.mjs';
import { cleanupRemoteBranch } from './branch-cleanup.mjs';
import { send as routeNotify } from './notify-router.mjs';
import { classifyEscapes } from '../evolution/escape-classify.mjs';

function runCmd(template, vars, stdinData) {
  const parts = template.split(' ').map((p) =>
    p.replace('{owner}', vars.owner ?? '').replace('{repo}', vars.repo ?? '').replace('{pr}', String(vars.pr ?? ''))
  );
  return execFileSync(parts[0], parts.slice(1), { encoding: 'utf8', input: stdinData });
}

function journal(journalFile, rec) {
  if (!journalFile) return;
  mkdirSync(dirname(journalFile), { recursive: true });
  appendFileSync(journalFile, JSON.stringify({ at: nowIso(), ...rec }) + '\n');
}

// I2-R: repoDir 缺失 = fail-closed（不许假装清理成功）
function cleanupTerminal(state, repoDir, journalFile) {
  const steps = [];
  if (!repoDir) {
    journal(journalFile, { kind: 'cleanup-failed', pr: `${state.owner}/${state.repo}#${state.pr_number}`, error: 'repoDirs 未配置该仓（fail-closed，不销单）' });
    return { ok: false, steps: ['repo-dir-unknown'] };
  }
  const wtName = `fix-${state.pr_number}`;
  const wtPath = join(repoDir, '..', wtName);
  try {
    if (existsSync(wtPath)) {
      execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', wtPath], { encoding: 'utf8' });
      steps.push(`worktree-removed:${wtName}`);
    } else steps.push('worktree-absent');
    execFileSync('git', ['-C', repoDir, 'worktree', 'prune'], { encoding: 'utf8' });
    try {
      execFileSync('git', ['-C', repoDir, 'branch', '-D', wtName], { encoding: 'utf8' });
      steps.push(`branch-deleted:${wtName}`);
    } catch { steps.push('branch-absent'); }
  } catch (e) {
    journal(journalFile, { kind: 'cleanup-failed', pr: `${state.owner}/${state.repo}#${state.pr_number}`, error: e.message });
    return { ok: false, steps };
  }
  journal(journalFile, { kind: 'cleanup', pr: `${state.owner}/${state.repo}#${state.pr_number}`, steps });
  return { ok: true, steps };
}

export function runEngine(cfg) {
  const {
    stateDir, leaseFile, snapshotCmd, dispatchCmd, journalFile,
    repoDirs = {},
    budget = null, // 必填: { ledger, cap, estimate }（F13-R fail-closed）
    triReviewLedgerDir = null, escapeLedger = null,
    feishuCmd = null, slackCmd = null,
    leaseTtlMinutes = 40, stuckThreshold = 3, lockTimeoutMs = 10_000,
    pendingStuckHours = 6, // T3/SC-3a: pending 等待 ack 超时告警阈值（默认 6 小时，可经 config 覆盖）
    deleteRemoteBranchOnMerge = false, // 审⑬/owner 点单: 显式 opt-in 才启用远端分支清理
    hmacKey = process.env.PR_AUTOPILOT_HMAC_KEY ?? null,
    nowMs = Date.now()
  } = cfg;

  if (!budget || !budget.ledger || !(budget.cap > 0) || !(budget.estimate > 0)) {
    throw new Error('引擎启动拒绝: budget{ledger,cap,estimate} 必填（F13-R fail-closed——没有预算闸不许开盯梢）');
  }
  // 审⑩-P2-2: lockTimeoutMs 硬边界 [100ms, 10s]——0/NaN/超大值会让单 PR 隔离守卫
  // 退化为无限等待或形同虚设，非法配置直接拒启动（fail-closed，不扫描）
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 100 || lockTimeoutMs > 10_000) {
    throw new Error(`引擎启动拒绝: lockTimeoutMs 非法（${lockTimeoutMs}）——必须是 [100, 10000] 毫秒整数（审⑩-P2-2 fail-closed）`);
  }
  // 审(2026-08-08): pendingStuckHours 仅接受有穷 number 且 > 0。字符串/NaN/Infinity/负数/0
  // 会静默失效（"6"*60 的隐式转换、NaN 比较恒假、0 令任何年龄都超时），超时告警随之消失——
  // 非法配置在扫描/通知前直接拒启动（fail-closed）。不支持用 0 禁用（禁用=告警永远不触发）。
  if (typeof pendingStuckHours !== 'number' || !Number.isFinite(pendingStuckHours) || pendingStuckHours <= 0) {
    throw new Error(`引擎启动拒绝: pendingStuckHours 非法（${pendingStuckHours}）——必须是有穷 number 且 > 0（字符串/NaN/Infinity/负数/0 均 fail-closed，不支持禁用）`);
  }

  writeJsonAtomic(leaseFile, { last_success: nowIso(), pid: process.pid });

  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  // R3 修复: 扫描前先做旧命名迁移（SC-S3）——含折叠字符的 v2 注册（mame/_、mame/- 等）
  // 先原子迁移到 v3 单射编码名；名实不符/冲突拒绝留痕（journal），绝不静默漏扫。
  // 迁移后再按 v3 文法过滤——garbage__5.json 之类（两段/杂质）不进扫描。
  const migSummary = migrateAllLegacyStateFiles(stateDir, journalFile);
  const files = readdirSync(stateDir).filter((f) =>
    STATE_FILE_NAME_RE.test(f) && !f.startsWith('manifest-') && !f.startsWith('receipt-'));
  if (files.length === 0) return { scanned: 0, migrated: migSummary.migrated, rejected: migSummary.rejected, dispatched: [], redispatched: [], terminal: [], stuck: [], paused: false, quiet: true };

  const out = { scanned: files.length, migrated: migSummary.migrated, rejected: migSummary.rejected, dispatched: [], redispatched: [], terminal: [], stuck: [], paused: false, quiet: false };

  for (const f of files) {
    const path = join(stateDir, f);
    // 快照拉取在锁外（网络慢操作不占锁）
    let preState;
    try { preState = readJson(path); } catch { continue; } // 正在被销单
    // 审⑤-I3: 内容反向一致——owner/repo/pr_number 重算的文件名必须等于实际文件名
    if (!preState || stateFileName(preState.owner, preState.repo, preState.pr_number) !== f) {
      journal(journalFile, { kind: 'state-file-rejected', file: f, error: '文件名与内容 owner/repo/pr 不一致（非法状态文件，不扫描）' });
      continue;
    }
    const prKey = `${preState.owner}/${preState.repo}#${preState.pr_number}`;
    let snapshot;
    try {
      snapshot = JSON.parse(runCmd(snapshotCmd, { owner: preState.owner, repo: preState.repo, pr: preState.pr_number }));
    } catch (e) {
      process.stderr.write(`[ENGINE] 快照失败 ${f}: ${e.message}（保持状态，下轮重试）\n`);
      continue;
    }

    // F10: 漏检自动记账（fail-open 不阻塞主链，但记 journal）
    if (triReviewLedgerDir && escapeLedger) {
      try {
        classifyEscapes({ snapshot, owner: preState.owner, repo: preState.repo, prNumber: preState.pr_number, triReviewLedgerDir, escapeLedger });
      } catch (e) { journal(journalFile, { kind: 'escape-classify-error', pr: prKey, error: e.message }); }
    }

    // F14: 状态读改写全程持锁（ack/complete 用同一把）
    // 审⑨-P2-2: 单 PR 锁超时/异常 fail-closed 记账后 continue——一个被锁死/损坏的 PR
    // 不得中断整轮扫描（其余 PR 照常处理）
    try {
    withLock(`${path}.lock`, () => {
      if (!existsSync(path)) return; // 已销单
      const state = readJson(path);

      // 终态: 先清理再销单（I2-R: 清理失败/repoDir 缺失 → cleanup-pending 不销单）
      if (snapshot.state === 'merged' || snapshot.state === 'closed') {
        // 审⑩-P2-1: 销单/清理之前必须先机械结算 pending 的权威预留——
        // canceling 中或普通 pending 的 PR 转终态时，unregister 会删掉唯一记着权威
        // ledger 路径的 state，$预留就永久占额到日切。对账成功才允许进入清理；
        // release 失败 → 留 state 记账下轮再试（fail-closed，绝不销单丢账本）。
        let settled = state;
        if (state.pending_dispatch) {
          const pd = state.pending_dispatch;
          try {
            releaseReserve({ ledgerFile: pd.budget?.ledger ?? budget.ledger, dispatchId: pd.dispatch_id });
          } catch (e) {
            journal(journalFile, { kind: 'terminal-budget-release-failed', pr: prKey, dispatch_id: pd.dispatch_id, error: e.message });
            writeJsonAtomic(path, { ...state, last_scan: nowIso() });
            return;
          }
          // 审⑪-P1: 放弃 pending 的同一笔原子写内轮换 generation——closed→cleanup-pending→reopen
          // 后同 head/同反馈的重派必然是新 id，旧取消会话的迟到 ack/finalize 命不中
          settled = { ...state, pending_dispatch: null, dispatch_generation: (state.dispatch_generation ?? 0) + 1 };
          writeJsonAtomic(path, settled); // 结算先落盘——此后 cleanup 失败也不再依赖 pending 里的账本路径
          journal(journalFile, { kind: 'terminal-pending-settled', pr: prKey, dispatch_id: pd.dispatch_id, was_canceling: pd.canceling === true, generation: settled.dispatch_generation });
        }
        const repoDir = repoDirs[`${settled.owner}/${settled.repo}`] ?? null;
        const clean = cleanupTerminal(settled, repoDir, journalFile);
        if (!clean.ok) {
          writeJsonAtomic(path, { ...settled, status: 'cleanup-pending', last_scan: nowIso() });
          return;
        }
        // owner 点单（2026-08-01）: merged 后顺手清远端 feature 分支。
        // 只在 merged（closed 未合并的分支绝不删）+ 显式 opt-in；全部硬门在 branch-cleanup.mjs。
        // best-effort: 失败/跳过 journal 留痕但不阻塞销单（分支清理不值得让状态机卡死）。
        if (deleteRemoteBranchOnMerge && snapshot.state === 'merged' && repoDir) {
          try {
            const bc = cleanupRemoteBranch({
              repoDir, remote: settled.push_remote, branch: settled.branch,
              repoFullName: settled.push_repo ?? `${settled.owner}/${settled.repo}`,
              expectedHeadSha: snapshot.head_sha
            });
            journal(journalFile, { kind: 'branch-cleanup', pr: prKey, ...bc });
          } catch (e) {
            journal(journalFile, { kind: 'branch-cleanup-failed', pr: prKey, branch: settled.branch, error: e.message });
          }
        }
        unregisterPr({ stateDir, owner: settled.owner, repo: settled.repo, prNumber: settled.pr_number, reason: snapshot.state, journalFile, skipLock: true });
        out.terminal.push(f);
        return;
      }

      const next = { ...state, last_scan: nowIso() };
      if (!next.first_scan_ack) next.first_scan_ack = nowIso();

      // F6: pending → 单飞；lease 到期重派同 id；≥N 次 → stuck 路由
      if (state.pending_dispatch) {
        const pd0 = state.pending_dispatch;
        // T3/SC-3a: 旧 state 缺 first_dispatched_at → 先原子回填（取当时 dispatched_at）再做任何
        // 重派更新——回填随本轮 writeJsonAtomic(path, next) 一并落盘，年龄基准不因迁移后移
        let pd = (pd0.first_dispatched_at === undefined && pd0.dispatched_at)
          ? { ...pd0, first_dispatched_at: pd0.dispatched_at }
          : pd0;
        if (pd !== pd0) next.pending_dispatch = pd;
        // 审⑨-P2-1R: canceling 状态机恢复——cancel 在 release/清态之间崩溃时由引擎收敛，
        // 绝不把 canceling pending 当普通 pending 重派（重派 session 无预留 = 预算低计）
        if (pd.canceling) {
          try {
            releaseReserve({ ledgerFile: pd.budget?.ledger ?? budget.ledger, dispatchId: pd.dispatch_id });
          } catch (e) {
            journal(journalFile, { kind: 'cancel-resume-release-failed', pr: prKey, dispatch_id: pd.dispatch_id, error: e.message });
            writeJsonAtomic(path, next); // 保持 canceling，下轮再试（fail-closed 不清态）
            return;
          }
          next.pending_dispatch = null;
          next.status = 'watching';
          next.dispatch_generation = (state.dispatch_generation ?? 0) + 1;
          journal(journalFile, { kind: 'cancel-resumed', pr: prKey, dispatch_id: pd.dispatch_id, generation: next.dispatch_generation });
          writeJsonAtomic(path, next);
          return;
        }
        // T3/SC-3b: 每轮对每个持有 pending 的 PR 记 waiting——waiting_for 枚举只有 'ack'；
        // canceling 分支已提前 return，天然不记 waiting（正在收尾的取消会话不制造等待噪音）
        const pendingAgeMin = (nowMs - Date.parse(pd.first_dispatched_at ?? pd.dispatched_at)) / 60000;
        journal(journalFile, {
          kind: 'waiting', pr: prKey, dispatch_id: pd.dispatch_id,
          waiting_for: 'ack', age_minutes: Math.round(pendingAgeMin),
          attempt: (pd.redispatch_count ?? 0) + 1
        });
        // T3/SC-3a: pending 超时告警——年龄基准 = first_dispatched_at（重派不更新）；
        // 去重标记持久化在 pending_dispatch 内：尝试发送后即置 true（含发送失败），
        // 宁丢一次不刷屏——取舍与下方 stuck 通知的 try/catch 同口径
        if (pd.pending_stuck_notified !== true && pendingAgeMin > pendingStuckHours * 60) {
          try {
            routeNotify({
              eventType: 'pending-stuck', repo: `${state.owner}/${state.repo}`, feishuCmd, slackCmd,
              message: `【盯梢器】${prKey} 修复会话 ${pd.dispatch_id} 等待 ack 已超 ${Math.floor(pendingAgeMin / 60)} 小时，请检查修复会话是否还活着。`
            });
          } catch (e) { journal(journalFile, { kind: 'notify-error', pr: prKey, error: e.message }); }
          pd = { ...pd, pending_stuck_notified: true };
          next.pending_dispatch = pd;
        }
        const ageMin = (nowMs - Date.parse(pd.dispatched_at)) / 60000;
        if (ageMin > leaseTtlMinutes) {
          const count = (pd.redispatch_count ?? 0) + 1;
          if (count >= stuckThreshold) {
            out.stuck.push(prKey);
            journal(journalFile, { kind: 'stuck', pr: prKey, dispatch_id: pd.dispatch_id, redispatch_count: count });
            try {
              routeNotify({
                eventType: 'stuck', repo: `${state.owner}/${state.repo}`, feishuCmd, slackCmd,
                message: `【盯梢器】${prKey} 修复会话疑似挂死：dispatch ${pd.dispatch_id} 已重派 ${count} 次仍无完工回执。`
              });
            } catch (e) { journal(journalFile, { kind: 'notify-error', pr: prKey, error: e.message }); }
          }
          try {
            runCmd(dispatchCmd, {}, JSON.stringify(pd.manifest));
            next.pending_dispatch = { ...pd, dispatched_at: nowIso(), redispatch_count: count };
            out.redispatched.push(prKey);
            journal(journalFile, { kind: 'redispatch', pr: prKey, dispatch_id: pd.dispatch_id, count });
          } catch (e) {
            // SC-2a: 重派失败同样持久化 redispatch_count——否则连续失败永远到不了 stuck 判据。
            // 判活语义变更（如实声明）：stuck 的「已重派 N 次」计数现在包含失败尝试。
            next.pending_dispatch = { ...pd, redispatch_count: count };
            journal(journalFile, { kind: 'redispatch-failed', pr: prKey, dispatch_id: pd.dispatch_id, attempt: count, error: e.message });
            process.stderr.write(`[ENGINE] 重派失败 ${f}: ${e.message}（下轮再试）\n`);
          }
        }
        writeJsonAtomic(path, next);
        return;
      }

      // 信号判定（F7-R: hold 不消费游标）
      const res = evaluate(state.cursors ?? emptyCursors(), snapshot, { hmacKey });

      if (res.decision === 'blocked-external') {
        next.status = 'blocked-external';
        writeJsonAtomic(path, next); // 游标不动
        return;
      }
      if (res.decision !== 'actionable') {
        if (state.status === 'blocked-external' || state.status === 'fixing') next.status = 'watching';
        writeJsonAtomic(path, next);
        return;
      }

      // 审⑤-F4: 自包含前提校验——branch/push_remote 缺失的状态文件不派发（fail-closed），
      // 否则投递出的 manifest 注定在 finalize 失败，白烧预算。remote 名只来自注册，不猜。
      if (!state.branch || !state.push_remote) {
        journal(journalFile, { kind: 'state-invalid', pr: prKey, error: `状态文件缺 ${!state.branch ? 'branch' : 'push_remote'}（注册协议 v2 必填，需重新注册补齐）` });
        process.stderr.write(`[ENGINE] ${prKey} 状态缺 branch/push_remote，跳过派发（重新 register 补齐）\n`);
        writeJsonAtomic(path, next);
        return;
      }

      // F13-R: 原子预算预留（检查+reserve 同锁；两引擎共享 ledger）
      // 审⑦-P1: generation 纳入 id——cancel 后同一信号以新 id 重派，旧会话迟到 ack 命不中
      // 审⑪-P1: registration_epoch 也纳入——销单→reopen→重注册后 generation 归零，
      // 但新注册 epoch 不同，跨注册生命周期同样不复用旧 id 空间
      const dispatchId = sha256(canonicalJson({ pr: prKey, head: snapshot.head_sha, items: res.newItems, gen: state.dispatch_generation ?? 0, epoch: state.registration_epoch ?? null })).slice(0, 16);
      const b = reserveBudget({ ledgerFile: budget.ledger, capUsd: budget.cap, estimateUsd: budget.estimate, dispatchId, nowMs });
      if (!b.allowed) {
        out.paused = true;
        const today = new Date(nowMs).toISOString().slice(0, 10);
        if (state.budget_notified_on !== today) {
          try {
            routeNotify({
              eventType: 'budget-pause', repo: `${state.owner}/${state.repo}`, feishuCmd, slackCmd,
              message: `【预算闸】${b.reason}。${prKey} 有新反馈但暂停派活，等你确认后继续。`
            });
          } catch (e) { journal(journalFile, { kind: 'notify-error', pr: prKey, error: e.message }); }
          next.budget_notified_on = today;
        }
        journal(journalFile, { kind: 'budget-pause', pr: prKey, spent: b.spent });
        writeJsonAtomic(path, next); // 游标不推进 → 恢复后同信号补派
        return;
      }

      // 审④-F5: manifest 自包含到「修复会话可直接执行」——finalize/complete 的完整命令随单投递
      const scriptsDir = new URL('.', import.meta.url).pathname;
      const manifestPath = join(stateDir, `manifest-${f.replace(/\.json$/, '')}-${dispatchId}.json`);
      const manifest = {
        kind: 'pr-fix',
        dispatch_id: dispatchId,
        owner: state.owner, repo: state.repo, pr_number: state.pr_number,
        branch: state.branch, head_sha: snapshot.head_sha, original_head: snapshot.head_sha,
        push_repo: state.push_repo ?? null, // cindy: fork 全名，finalize 绑 remote URL
        remote: state.push_remote, // 审⑤-F4: remote 名来自注册持久化，引擎不硬编码猜测
        state_dir: stateDir, snapshot_cmd: snapshotCmd, journal_file: journalFile ?? null,
        manifest_path: manifestPath,
        finalize_cmd: `node ${scriptsDir}finalize.mjs --repo-dir <修复worktree路径> --manifest ${manifestPath} --snapshot-cmd "${snapshotCmd}" --state-dir ${stateDir}`,
        complete_cmd: `node ${scriptsDir}complete.mjs --manifest ${manifestPath} --snapshot-cmd "${snapshotCmd}" --state-dir ${stateDir}`,
        signals: res.signals, new_items: res.newItems,
        // 审(2026-08-08): 预算结算字段随 manifest 自包含投递——complete 在 ack 前凭
        // manifest.budget.{ledger,estimate} 机械结算 reserve（缺省 estimate 结算，--actual 可给实值）
        budget: { ledger: budget.ledger, estimate: budget.estimate },
        worktree_name: `fix-${state.pr_number}`,
        rules: [
          '第一步必须 git worktree add ../fix-<pr> 并切入（宿主无 per-dispatch worktree，S2）',
          '从反馈提炼 SC 清单，goal skill --until-sc 修到每条 SC 有证据',
          'push 必须经 finalize.mjs（remote CAS + PR open 复查 + CI 路径守卫 + remote↔仓绑定），绝不裸 push',
          '回帖必须带 provenance 签名且正文含 dispatch:<dispatch_id>（complete 探测依据）',
          '绝不合并、禁 force-push、禁改 CI 路径',
          '收尾必须运行 manifest.complete_cmd——push（凭 finalize receipt）与回帖两项副作用都确认后才 ack；不跑 = 视为挂死重派',
          'owner 常设授权: PR 分支 push 与 PR 内回帖为已授权动作'
        ]
      };
      try {
        writeJsonAtomic(manifestPath, manifest); // 落盘: 修复会话按 manifest_path 拿完整参数（F5）
        runCmd(dispatchCmd, {}, JSON.stringify(manifest));
        next.status = 'fixing';
        // 首派时刻单一真相：first_dispatched_at 与 dispatched_at 必须同源同值。
        // 分两次调 nowIso() 会在跨毫秒边界时差 1ms，破坏「首派时二者相等」不变量
        // （T3/SC-3c 断言），在高负载下偶发红。取一次复用即根除。
        const firstDispatchedAt = nowIso();
        next.pending_dispatch = {
          dispatch_id: dispatchId, manifest, cursors_next: res.cursors,
          dispatched_at: firstDispatchedAt,
          first_dispatched_at: firstDispatchedAt, // T3/SC-3a: 首派时刻（重派不更新）——pending 超时年龄基准；与 dispatched_at 同源保证首派时相等
          redispatch_count: 0,
          // 审⑨-P2-1R: 权威预算账本随派发固化——cancel 只认这里，不接受调用者任意自报
          budget: { ledger: budget.ledger, estimate: budget.estimate }
        };
        out.dispatched.push({ pr: prKey, signals: res.signals, dispatch_id: dispatchId });
        journal(journalFile, { kind: 'dispatch', pr: prKey, dispatch_id: dispatchId, signals: res.signals });
      } catch (e) {
        // 审④-F7: 投递失败释放预留，预算不漂
        try { releaseReserve({ ledgerFile: budget.ledger, dispatchId }); } catch { /* 记账失败下轮 reserve 幂等兜底 */ }
        // SC-2a: 首派失败记结构化事件——attempt 恒 1（首派失败无 pending、无跨轮状态，
        // 游标不推进、下轮重试 = at-least-once，不存在「重派第几次」的概念）
        journal(journalFile, { kind: 'dispatch-failed', pr: prKey, dispatch_id: dispatchId, attempt: 1, error: e.message });
        process.stderr.write(`[ENGINE] 投递失败 ${f}: ${e.message}（游标不推进 + 预留已释放，下轮重试 = at-least-once）\n`);
      }
      writeJsonAtomic(path, next);
    }, { timeoutMs: lockTimeoutMs });
    } catch (e) {
      journal(journalFile, { kind: 'pr-scan-error', pr: prKey, error: e.message });
      process.stderr.write(`[ENGINE] ${prKey} 本轮扫描失败: ${e.message}（记账跳过，不阻断其余 PR）\n`);
    }
  }
  return out;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const need = ['state-dir', 'lease', 'snapshot-cmd', 'dispatch-cmd', 'config'];
  if (need.some((k) => !args[k])) {
    fail('用法: engine.mjs --state-dir <dir> --lease <file> --snapshot-cmd "<cmd>" --dispatch-cmd "<cmd>" --config <engine.json>（config 必填: budget/repoDirs 等，F13-R/I2-R fail-closed）');
  }
  const extra = readJson(args.config);
  const res = runEngine({
    stateDir: args['state-dir'], leaseFile: args.lease,
    snapshotCmd: args['snapshot-cmd'], dispatchCmd: args['dispatch-cmd'],
    journalFile: args.journal,
    ...extra
  });
  process.stdout.write(JSON.stringify(res) + '\n');
}
