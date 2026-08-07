#!/usr/bin/env node
// dispatch 完成回执 — 计划依据: W-3 at-least-once（审②-F6）
// 修复会话（或 finalize wrapper）在副作用完成后调用；引擎只在收到本回执后才推进游标。
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { readJson, writeJsonAtomic, parseArgs, fail, nowIso, isMain} from '../lib/common.mjs';
import { withLock } from '../lib/state-lock.mjs';
import { resolveStateFile } from './register.mjs';
import { releaseReserve, settleDispatchBudget } from './budget.mjs';
import { receiptPathLocked } from './finalize.mjs';

// 审③-F14: 读改写全程持 per-key 锁（与 engine 同一把），防并发丢更新/复活 pending
export function ackDispatch({ stateDir, owner, repo, prNumber, dispatchId, journalFile }) {
  // R3 修复: 按身份解析（旧命名文件先迁移）再持新名锁——与 engine/register/finalize 同源
  const { file: resolvedFile } = resolveStateFile({ stateDir, owner, repo, prNumber, journalFile });
  const file = join(stateDir, resolvedFile);
  return withLock(`${file}.lock`, () => {
    if (!existsSync(file)) return { ok: false, reason: '状态文件不存在（可能已销单）' };
    const state = readJson(file);
    const pending = state.pending_dispatch;
    if (!pending) return { ok: false, reason: '无 pending dispatch（重复 ack 幂等忽略）' };
    if (pending.dispatch_id !== dispatchId) {
      return { ok: false, reason: `dispatch_id 不匹配（pending=${pending.dispatch_id} ack=${dispatchId}）——旧会话的迟到 ack 被拒` };
    }
    if (pending.canceling) {
      return { ok: false, reason: '该 dispatch 正在取消（canceling）——等引擎收敛取消状态机，不接受收口 ack（审⑨-P2-1R）' };
    }
    const next = {
      ...state,
      cursors: pending.cursors_next, // 游标只在此刻推进（F6 核心）
      pending_dispatch: null,
      status: 'watching',
      last_ack: nowIso()
    };
    writeJsonAtomic(file, next);
    if (journalFile) {
      mkdirSync(dirname(journalFile), { recursive: true });
      appendFileSync(journalFile, JSON.stringify({ at: nowIso(), kind: 'ack', pr: `${owner}/${repo}#${prNumber}`, dispatch_id: dispatchId }) + '\n');
    }
    return { ok: true };
  });
}

// 审(2026-08-08 GPT R2): 结算+ack 同锁复合原语——complete 收口的唯一入口。
// 与 ackDispatch 的区别: 本函数在**同一 state-lock 临界区**内完成「机械结算 reserve →
// actual」与「推进游标/清 pending」，两个动作之间不存在可被观察或插入的窗口（SC-B3）。
// 权威来源（SC-B1/SC-B2）: 结算账本与估算值**只认 state 固化的 pending_dispatch.budget**，
// 不看 manifest.budget——manifest 是投递给修复会话的可变文件，会话可把 ledger 指向坏账本
// 或把 estimate 改成 0 洗账，信任它等于把结算权交给被修复方。旧版本派发的 manifest 无
// budget 字段时，同样从这里自动收口（引擎 0bf3c4e 起固化 pending.budget）。
// 锁纪律: settleDispatchBudget 内部不取锁（recordCost 为单条原子追加、isDispatchSettled
// 只读全账本折叠），在 state 锁内调用不产生同锁/异锁嵌套；结算抛错 → state 未被改写、
// pending 原样保留 → 引擎 at-least-once 重派重跑，幂等收敛（已结算跳过，无半状态）。
export function settleAndAckDispatch({ stateDir, owner, repo, prNumber, dispatchId, actualUsd = null, journalFile }) {
  // R3 修复: 同源解析（旧命名文件先迁移），收口路径与 ack/cancel/finalize 一致
  const { file: resolvedFile } = resolveStateFile({ stateDir, owner, repo, prNumber, journalFile });
  const file = join(stateDir, resolvedFile);
  return withLock(`${file}.lock`, () => {
    if (!existsSync(file)) return { ok: false, reason: '状态文件不存在（可能已销单）' };
    const state = readJson(file);
    // SC-B1: manifest 自报 identity 必须与 state 内容一致（文件路径按 owner/repo/pr 定位，
    // 但内容可能错放/被换——锁内核对，任一不符 fail-closed：不结算不 ack）
    if (state.owner !== owner || state.repo !== repo || state.pr_number !== Number(prNumber)) {
      return { ok: false, reason: `manifest identity 与 state 不匹配（state=${state.owner}/${state.repo}#${state.pr_number} manifest=${owner}/${repo}#${prNumber}）——不结算不 ack（fail-closed）` };
    }
    const pending = state.pending_dispatch;
    if (!pending) return { ok: false, reason: '无 pending dispatch（重复 complete 幂等忽略）' };
    if (pending.dispatch_id !== dispatchId) {
      return { ok: false, reason: `dispatch_id 不匹配（pending=${pending.dispatch_id} complete=${dispatchId}）——旧会话的迟到 complete 被拒，不结算不 ack` };
    }
    if (pending.canceling) {
      return { ok: false, reason: '该 dispatch 正在取消（canceling）——等引擎收敛取消状态机，不接受收口 ack（审⑨-P2-1R）' };
    }
    // SC-B2: 权威 budget 只认 pending 固化的账本——manifest 可变不信任；旧 manifest 无 budget
    // 时这里同样能收口（无 authority 则 fail-closed，人工 record 纠偏后重试）
    const authority = pending.budget ?? null;
    if (!authority || !authority.ledger) {
      return { ok: false, reason: 'pending 缺权威 budget 账本（非引擎标准派发遗留）——人工 record 纠偏后重试，不结算不 ack（fail-closed）' };
    }
    // SC-B3: 结算与 ack 同一临界区——结算抛错即整个收口失败，state 未动，pending 保留
    settleDispatchBudget({ ledgerFile: authority.ledger, dispatchId, actualUsd, estimateUsd: authority.estimate ?? null });
    const next = {
      ...state,
      cursors: pending.cursors_next, // 游标只在此刻推进（F6 核心）
      pending_dispatch: null,
      status: 'watching',
      last_ack: nowIso()
    };
    writeJsonAtomic(file, next);
    if (journalFile) {
      mkdirSync(dirname(journalFile), { recursive: true });
      appendFileSync(journalFile, JSON.stringify({ at: nowIso(), kind: 'ack', pr: `${owner}/${repo}#${prNumber}`, dispatch_id: dispatchId }) + '\n');
    }
    return { ok: true };
  });
}

// 审⑦-P1: 取消在途任务 ≠ ack。ack 是「副作用已核验完成」的收口（只应由 complete 触发），
// 会消费游标；cancel 是「放弃这次派发」——**不推进游标**（同一批反馈仍是未处理信号，
// 下轮会重派）、释放预算预留、并递增 dispatch_generation（generation 参与 dispatch_id
// 计算，旧会话的迟到 ack/complete 拿旧 id 永远命不中新 pending）。
// 审⑨-P2-1R: 可恢复两阶段取消状态机。
//   权威账本 = engine 派发时固化在 pending.budget.ledger 的路径——cancel 不接受任意自报
//   账本（--ledger 只作核对，错账本直接拒，杜绝「往错账本写 release 洗掉真预留」）。
//   Phase A: pending 标 canceling 落盘（finalize 的 pending 门与 engine 重派即刻对该
//            dispatch 失效——canceling ≠ 可重派，无预留的重派 session 不可能出现）
//   Phase B: 对权威账本幂等 release（失败即抛，canceling 留盘，引擎恢复路径下轮续跑）
//   Phase C: 清 pending + 升 generation
//   任一崩溃点重启后由 engine 的 canceling 恢复分支收敛。
export function cancelDispatch({ stateDir, owner, repo, prNumber, dispatchId, budgetLedger = null, journalFile }) {
  // R3 修复: 同源解析（旧命名文件先迁移），取消路径与 ack/complete/finalize 一致
  const { file: resolvedFile } = resolveStateFile({ stateDir, owner, repo, prNumber, journalFile });
  const file = join(stateDir, resolvedFile);
  return withLock(`${file}.lock`, () => {
    if (!existsSync(file)) return { ok: false, reason: '状态文件不存在（可能已销单）' };
    const state = readJson(file);
    const pending = state.pending_dispatch;
    if (!pending) return { ok: false, reason: '无 pending dispatch（无可取消）' };
    if (pending.dispatch_id !== dispatchId) {
      return { ok: false, reason: `dispatch_id 不匹配（pending=${pending.dispatch_id} cancel=${dispatchId}）——只允许显式点名取消` };
    }
    // 审⑧-P1-2: 已有 intent/committed receipt = 该 dispatch 已表达/完成 push 意图，
    // 取消无法撤回已发生或在途的远端写——fail-closed，只能走 complete 收口。
    // R4: 本函数已持 state 锁（含 resolveStateFile 的锁），只读核对必须用锁内 helper
    // receiptPathLocked——公共 API 会再拿同一把锁 → 自锁死锁（mkdir 锁不可重入）。
    // 只读模式（无 dispatch_id）不迁移、不抛冲突，canonical 优先返回。
    const rp = receiptPathLocked(stateDir, { owner, repo, pr_number: prNumber });
    if (existsSync(rp)) {
      const rec = readJson(rp);
      if (rec.dispatch_id === dispatchId && (rec.phase === 'intent' || rec.phase === 'committed')) {
        return { ok: false, reason: `该 dispatch 已有 ${rec.phase} receipt（push 意图已表达/已落地）——取消撤不回远端写，先运行 complete 收口（审⑧-P1-2）` };
      }
    }
    const authoritative = pending.budget?.ledger ?? null;
    if (!authoritative) {
      return { ok: false, reason: 'pending 缺权威 budget 账本（非引擎标准派发）——不接受任意账本对账，人工核账处理（审⑨-P2-1R）' };
    }
    if (budgetLedger && resolvePath(budgetLedger) !== resolvePath(authoritative)) {
      return { ok: false, reason: `--ledger 与派发固化的权威账本不符（authoritative=${authoritative}）——错账本对账被拒（审⑨-P2-1R）` };
    }
    // Phase A: canceling 落盘
    writeJsonAtomic(file, { ...state, pending_dispatch: { ...pending, canceling: true, cancel_started_at: nowIso() } });
    // Phase B: 幂等 release（失败即抛——canceling 已留盘，引擎恢复路径收敛，绝不静默）
    releaseReserve({ ledgerFile: authoritative, dispatchId });
    // Phase C: 清 pending + 升 generation
    const next = {
      ...state,
      pending_dispatch: null,
      status: 'watching',
      dispatch_generation: (state.dispatch_generation ?? 0) + 1,
      last_cancel: nowIso()
      // cursors 原样 —— W-3 at-least-once: 未完成的反馈必须能重派，绝不吞信号
    };
    writeJsonAtomic(file, next);
    if (journalFile) {
      mkdirSync(dirname(journalFile), { recursive: true });
      appendFileSync(journalFile, JSON.stringify({ at: nowIso(), kind: 'cancel', pr: `${owner}/${repo}#${prNumber}`, dispatch_id: dispatchId, generation: next.dispatch_generation }) + '\n');
    }
    return { ok: true, generation: next.dispatch_generation };
  });
}

// 审⑧-P1-1: 本 CLI **只有 --cancel 一种模式**。裸 ack（不验 receipt/push/回帖直接推游标）
// 没有任何合法使用场景——推进游标的唯一入口是 complete.mjs 的副作用核验路径
// （ackDispatch 仅作为内部函数被 complete 调用）。误跑裸 ack 吞反馈的通道从 CLI 层拆除。
if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const need = ['state-dir', 'owner', 'repo', 'pr', 'dispatch-id'];
  if (!args.cancel || need.some((k) => !args[k])) {
    fail('用法: ack.mjs --cancel --state-dir <dir> --owner <o> --repo <r> --pr <N> --dispatch-id <id> [--ledger <cost.jsonl>] [--journal <f>]\n（本 CLI 只提供取消：不消费游标，对派发时固化的权威账本释放预留（--ledger 仅作核对，错账本拒），同信号以新 generation 重派。收口/推进游标必须走 complete.mjs——裸 ack 无 CLI 入口，审⑧-P1-1）');
  }
  const res = cancelDispatch({
    stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr,
    dispatchId: args['dispatch-id'], budgetLedger: args.ledger ?? null, journalFile: args.journal
  });
  process.stdout.write(JSON.stringify(res) + '\n');
  process.exit(res.ok ? 0 : 1);
}
