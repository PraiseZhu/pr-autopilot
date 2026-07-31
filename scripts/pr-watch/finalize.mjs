#!/usr/bin/env node
// 修复会话 push 收尾 wrapper — 计划依据: W-4（审②-F5: CAS/复查/守卫必须是机器门）
// 立即 push 前的机械检查（全过才 execFile push，随后自动 ack）:
//   ① 远端 CAS: snapshot.head_sha === manifest.original_head（维护者推进了 head → 拒，回炉重取反馈）
//   ② PR 仍 open（merged/closed → 拒，等引擎销单）
//   ③ original_head..HEAD 的 diff 不碰 CI 路径（git diff -z）
//   ④ remote 必须已配置、branch 合法、固定普通 refspec（复用 push-guard F3 规则）
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readJson, writeJsonAtomic, parseArgs, fail, isMain } from '../lib/common.mjs';
import { join as joinPath } from 'node:path';
import { stateFileName } from './register.mjs';
import { matchAny } from '../push-guard.mjs';
import { validateRemoteBranch } from '../lib/git-checks.mjs';
import { withLock } from '../lib/state-lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function git(repoDir, ...a) { return execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8' }); }

export function checkFinalize({ repoDir, manifest, snapshot, constitution }) {
  const errors = [];
  for (const k of ['owner', 'repo', 'pr_number', 'branch', 'original_head', 'dispatch_id']) {
    if (!manifest[k]) errors.push(`pr-fix manifest 缺字段: ${k}`);
  }
  if (errors.length) return { ok: false, errors, pushArgv: null };

  // ② PR 状态
  if (snapshot.state !== 'open') errors.push(`PR 非 open（${snapshot.state}）——终态分支禁 push，等引擎销单`);
  // ① 远端 CAS
  if (snapshot.head_sha !== manifest.original_head) {
    errors.push(`远端 head 已前进: remote=${String(snapshot.head_sha).slice(0, 12)} ≠ original=${String(manifest.original_head).slice(0, 12)}（CAS 拒绝，防覆盖新 head）`);
  }
  // ③ CI 路径守卫
  try {
    const out = git(repoDir, 'diff', '-z', '--name-only', `${manifest.original_head}...HEAD`);
    for (const f of out.split('\0').filter(Boolean)) {
      if (matchAny(f, constitution.ci_paths)) errors.push(`修复 diff 落在 CI 路径（W-4/R6）: ${f}`);
    }
  } catch (e) {
    errors.push(`无法计算 original_head...HEAD diff（fail-closed）: ${e.message}`);
  }
  // ④ remote/branch/refspec —— 与 push-guard 共用同一校验（审③-F3-R），
  //    push_repo（如 PraiseZhu/cindy-fork）绑定 remote URL，upstream 冒充被拦
  const remote = manifest.remote ?? 'origin';
  errors.push(...validateRemoteBranch({
    repoDir, remote, branch: manifest.branch,
    repoFullName: manifest.push_repo ?? `${manifest.owner}/${manifest.repo}`
  }));

  // 审④-F1: refspec 源钉死为当前 HEAD 对象；branch ref 必须与 HEAD 一致
  let headSha = null;
  try {
    headSha = git(repoDir, 'rev-parse', 'HEAD').trim();
    const branchSha = git(repoDir, 'rev-parse', `refs/heads/${manifest.branch}`).trim();
    if (branchSha !== headSha) errors.push(`branch ref 分叉: refs/heads/${manifest.branch}=${branchSha.slice(0, 12)} ≠ HEAD=${headSha.slice(0, 12)}（审 A 推 B 被拦）`);
  } catch { errors.push('HEAD/branch ref 读取失败（fail-closed）'); }
  const pushArgv = errors.length === 0
    ? ['git', '-C', repoDir, 'push', remote, `${headSha}:refs/heads/${manifest.branch}`]
    : null;
  return { ok: errors.length === 0, errors, pushArgv, headSha };
}

// 审④-F4: push 成功后原子写不可变 receipt——complete 只认 receipt，candidate 不再自报
export function receiptPath(stateDir, manifest) {
  return joinPath(stateDir, `receipt-${stateFileName(manifest.owner, manifest.repo, manifest.pr_number)}`);
}

// 审⑤-F1: 两段 receipt 协议——push 前原子写 intent（记 candidate），push 后升 committed。
// push 成功但进程在升级前死亡: 重跑 finalize 时若 intent 存在且远端 head == intent.candidate，
// 走严格幂等恢复分支（补升 committed，不重推）；CAS 不再把「自己已推的 candidate」误判为他人推进。
export function recoverFromReceipt({ manifest, snapshot, receipt }) {
  if (!receipt) return false;
  // 审⑥-F5: 恢复入口与 complete 同一 phase 闸 + manifest 全字段绑定——损坏/伪造 receipt 不得借道补升
  if (receipt.phase !== 'intent' && receipt.phase !== 'committed') return false;
  if (receipt.dispatch_id !== manifest.dispatch_id) return false;
  if (receipt.original_head !== manifest.original_head) return false;
  if (receipt.branch !== manifest.branch) return false;
  if ((receipt.remote ?? 'origin') !== (manifest.remote ?? 'origin')) return false;
  if (!/^[0-9a-f]{40}$/.test(String(receipt.candidate ?? ''))) return false;
  return snapshot.head_sha === receipt.candidate; // 远端核实: 远端 head 正是本 receipt 的 candidate
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const need = ['repo-dir', 'manifest', 'snapshot-cmd', 'state-dir'];
  if (need.some((k) => !args[k])) {
    fail('用法: finalize.mjs --repo-dir <dir> --manifest <pr-fix.json> --snapshot-cmd "<cmd>" --state-dir <dir> [--check-only] [--journal <f>]（宪法路径表固定随仓，审④-F3）');
  }
  // 审⑩-P2-2: push timeout 硬边界 [1s, 120s]——0/空串/NaN/超大 env 会重新打开「push 永久
  // 持 state 锁」的挂死面；非法值在做任何事之前直接非零退出（fail-closed，不 push 不取快照）
  let pushTimeoutMs = 120_000;
  if (process.env.PR_AUTOPILOT_PUSH_TIMEOUT_MS !== undefined) {
    const n = Number(process.env.PR_AUTOPILOT_PUSH_TIMEOUT_MS);
    if (!Number.isInteger(n) || n < 1000 || n > 120_000) {
      fail(`PR_AUTOPILOT_PUSH_TIMEOUT_MS 非法（"${process.env.PR_AUTOPILOT_PUSH_TIMEOUT_MS}"）——必须是 [1000, 120000] 毫秒整数；env 不得放大超过默认 120s（审⑩-P2-2 fail-closed）`);
    }
    pushTimeoutMs = n;
  }
  const manifest = readJson(args.manifest);
  const constitution = readJson(join(HERE, '../evolution/constitution-paths.json')); // 固定路径（审④-F3）
  const tpl = args['snapshot-cmd'].split(' ').map((p) =>
    p.replace('{owner}', manifest.owner).replace('{repo}', manifest.repo).replace('{pr}', String(manifest.pr_number)));
  const snapshot = JSON.parse(execFileSync(tpl[0], tpl.slice(1), { encoding: 'utf8' }));

  // 审⑧-P1-2: pending 核对 + intent/push/committed 临界段全部在 per-key state 锁内
  // （与 engine/ack/cancel/complete 同一把）——cancel 与 finalize 真并发只有一个合法结果:
  //   cancel 先 → pending 被清 → 本处 push 前核对失败，旧 manifest 到不了远端；
  //   finalize 先 → intent receipt 已落盘 → cancel 见 receipt fail-closed。
  const rp = receiptPath(args['state-dir'], manifest);
  const stateFile = joinPath(args['state-dir'], stateFileName(manifest.owner, manifest.repo, manifest.pr_number));
  const outcome = withLock(`${stateFile}.lock`, () => {
    // 审⑤-F1: 恢复分支优先——上次 push 成功但 committed 升级前崩溃时，
    // intent receipt + 远端 head==candidate 即可幂等补升，不再被 CAS 永拒。
    const prevReceipt = (() => { try { return readJson(rp); } catch { return null; } })();
    if (recoverFromReceipt({ manifest, snapshot, receipt: prevReceipt })) {
      if (prevReceipt.phase !== 'committed' && !args['check-only']) {
        writeJsonAtomic(rp, { ...prevReceipt, phase: 'committed', committed_at: new Date().toISOString(), recovered: true });
      }
      return { code: 0, msg: 'FINALIZE-OK push 已在远端（receipt 恢复分支，幂等）；回帖后运行 complete.mjs 收口\n' };
    }
    const st = existsSync(stateFile) ? readJson(stateFile) : null;
    const pendingId = st?.pending_dispatch?.dispatch_id ?? null;
    if (pendingId !== manifest.dispatch_id) {
      return { code: 1, errors: [`该 dispatch 已被取消/替换/收口（state.pending=${pendingId} ≠ manifest=${manifest.dispatch_id}）——旧会话禁止按旧 manifest push（审⑧-P1-2）`] };
    }
    if (st.pending_dispatch.canceling) {
      return { code: 1, errors: ['该 dispatch 处于 canceling（取消状态机进行中）——push 门关闭，等引擎收敛（审⑨-P2-1R）'] };
    }
    const res = checkFinalize({ repoDir: args['repo-dir'], manifest, snapshot, constitution });
    if (!res.ok) return { code: 1, errors: res.errors };
    if (!args['check-only']) {
      // 审⑤-F1: push 前先原子写 intent receipt——push 与写盘之间的崩溃窗口由恢复分支闭合
      const base = {
        dispatch_id: manifest.dispatch_id, original_head: manifest.original_head,
        candidate: res.headSha, remote: manifest.remote ?? 'origin', branch: manifest.branch
      };
      writeJsonAtomic(rp, { ...base, phase: 'intent', at: new Date().toISOString() });
      // 审⑨-P2-2: push 有限超时（默认 120s，远小于 lease SLO）——网络半开/凭证询问挂死时
      // SIGKILL 子进程并抛错，withLock finally 释放 state 锁；intent receipt 留盘可恢复
      // （远端若已收下 push → 下次 finalize 走恢复分支补升 committed；未收下 → 正常重试）
      execFileSync(res.pushArgv[0], res.pushArgv.slice(1), {
        stdio: 'inherit',
        timeout: pushTimeoutMs, // 审⑩-P2-2: 已过 [1s,120s] 硬边界校验
        killSignal: 'SIGKILL'
      });
      writeJsonAtomic(rp, { ...base, phase: 'committed', at: new Date().toISOString() });
      // 审③-F6-R: finalize 只负责 push，不 ack——一次修复的副作用是 push + 回帖，
      // 两项都落地后由 complete.mjs 探测确认并原子 ack（游标那时才推进）。
    }
    return { code: 0, msg: 'FINALIZE-OK push 已落地；回帖后运行 complete.mjs 收口\n' };
  }, { timeoutMs: 120_000 }); // push 在锁内，给足网络时间
  if (outcome.code !== 0) {
    for (const e of outcome.errors) process.stderr.write(`[FINALIZE] ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(outcome.msg);
}
