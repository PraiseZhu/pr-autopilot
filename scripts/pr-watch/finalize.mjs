#!/usr/bin/env node
// 修复会话 push 收尾 wrapper — 计划依据: W-4（审②-F5: CAS/复查/守卫必须是机器门）
// 立即 push 前的机械检查（全过才 execFile push，随后自动 ack）:
//   ① 远端 CAS: snapshot.head_sha === manifest.original_head（维护者推进了 head → 拒，回炉重取反馈）
//   ② PR 仍 open（merged/closed → 拒，等引擎销单）
//   ③ original_head..HEAD 的 diff 不碰 CI 路径（git diff -z）
//   ④ remote 必须已配置、branch 合法、固定普通 refspec（复用 push-guard F3 规则）
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readJson, writeJsonAtomic, parseArgs, fail, isMain } from '../lib/common.mjs';
import { join as joinPath } from 'node:path';
import { stateFileName, legacyStateFileName, resolveStateFile } from './register.mjs';
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
// R3 修复: receipt 路径与 stateFileName 同源（SC-S2: ack/finalize/complete/receipt 全链一致）。
// R4 修复 (2026-08-08 GPT R4 finding): 旧实现把「检查 canonical → rename 迁移」拆在锁外两步，
// 窗口期另一进程写入 canonical 后 renameSync 会静默覆盖新 receipt（TOCTOU）。修复:
//   - 迁移并入 per-state 锁内串行（锁内重新检查 canonical 目标，绝不 rename 覆盖已存在 receipt）；
//   - 分层: receiptPathLocked = 锁内 helper（调用方必须已持 state 锁，本函数不加锁）；
//           receiptPath = 锁外公共 API（自行解析并持同一把 per-state 锁后调 helper）。
//     所有锁内调用点（finalize main / ack cancelDispatch）用 Locked；锁外调用点（complete）用公共 API。
// canonical 已存在（锁内复核）→ 优先保留 canonical:
//   同 dispatch → 幂等视为已迁移（返回 canonical；legacy 保留不删——显式策略，双保险不丢数据）；
//   不同 dispatch 且 legacy 待迁移（legacy.dispatch == manifest.dispatch）→ 显式冲突抛错:
//     两文件保留、调用方 fail-closed（不 push/不结算不 ack，人工核对后处理）；
//   不同 dispatch 且无 legacy 待迁移 → 返回 canonical（调用方以 recoverFromReceipt 判定恢复分支，
//     不同 dispatch receipt 由 pending 核对与后续 complete 身份核对兜底——SC-FIX-4: 本函数只做
//     receipt 路径解析，不越权判定归属；恢复分支的字段绑定与 complete 的锁内身份核对
//     承担调用方侧校验，此处不替调用方断言）。
// 只读核对（调用方无 dispatch_id，ack.mjs cancel）→ 不做任何迁移/抛错，按 canonical 优先返回。
export function receiptPathLocked(stateDir, manifest) {
  const newPath = joinPath(stateDir, `receipt-${stateFileName(manifest.owner, manifest.repo, manifest.pr_number)}`);
  const legacyPath = joinPath(stateDir, `receipt-${legacyStateFileName(manifest.owner, manifest.repo, manifest.pr_number)}`);
  if (existsSync(newPath)) {
    // 锁内复核: canonical 已存在 → 绝不 rename 覆盖
    if (!manifest.dispatch_id) return newPath; // 只读核对（ack cancel）: canonical 优先
    let canonical = null;
    try { canonical = readJson(newPath); } catch { canonical = null; }
    if (canonical && canonical.dispatch_id === manifest.dispatch_id) return newPath; // 同 dispatch 幂等（已迁移）
    if (existsSync(legacyPath)) {
      let legacy = null;
      try { legacy = readJson(legacyPath); } catch { legacy = null; }
      if (legacy && legacy.dispatch_id === manifest.dispatch_id) {
        // 迁移在途被抢占: canonical 属其他 dispatch → 显式冲突，两文件保留，调用方 fail-closed
        throw new Error(
          `receipt 迁移冲突: canonical 已被 dispatch=${String(canonical?.dispatch_id).slice(0, 12) ?? '?'} 占用，` +
          `legacy dispatch=${String(legacy.dispatch_id).slice(0, 12)}，manifest.dispatch_id=${String(manifest.dispatch_id).slice(0, 12)}` +
          `——两文件保留不覆盖（fail-closed），人工核对 canonical 归属后处理`
        );
      }
    }
    return newPath; // 无 legacy 待迁移 → canonical 属其他 dispatch，调用方按 pending 核对兜底（SC-FIX-4）
  }
  if (!existsSync(legacyPath)) return newPath;
  if (!manifest.dispatch_id) return legacyPath; // 只读核对场景（ack.mjs cancel）
  let rec = null;
  try { rec = readJson(legacyPath); } catch { rec = null; }
  if (!rec || rec.dispatch_id !== manifest.dispatch_id) return newPath; // 损坏/不匹配 → 不迁移
  renameSync(legacyPath, newPath); // 锁内: canonical 已复核不存在 → 同目录原子迁移，无覆盖风险
  return newPath;
}

// R4: 锁外公共 API——自行解析 state 文件并持同一把 per-state 锁（与 finalize/ack/complete
// 同一把 ${stateFile}.lock），迁移与复核在锁内串行完成，释放后路径已稳定。
export function receiptPath(stateDir, manifest) {
  const stateFile = joinPath(stateDir, stateFileName(manifest.owner, manifest.repo, manifest.pr_number));
  return withLock(`${stateFile}.lock`, () => receiptPathLocked(stateDir, manifest));
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
  // R3 修复: 状态文件同源解析——旧命名文件先迁移，pending 核对才能在升级后命中旧注册
  const { file: resolvedStateFile } = resolveStateFile({
    stateDir: args['state-dir'], owner: manifest.owner, repo: manifest.repo,
    prNumber: manifest.pr_number, journalFile: args.journal ?? null
  });
  const stateFile = joinPath(args['state-dir'], resolvedStateFile);
  const outcome = withLock(`${stateFile}.lock`, () => {
    // R4 修复: receipt 解析/迁移移入锁内（receiptPathLocked 不加锁，避免嵌套死锁）——
    // 锁内复核 canonical 目标后才迁移，receipt 路径在临界区内稳定，pending 核对与
    // intent/committed 写入使用同一路径（TOCTOU 覆盖窗口关闭）。迁移冲突（canonical
    // 被其他 dispatch 占用）在此捕获为 errors 走统一 fail-closed 出口，不裸堆栈。
    let rp;
    try { rp = receiptPathLocked(args['state-dir'], manifest); }
    catch (e) { return { code: 1, errors: [e.message] }; }
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
  // R4: receipt 迁移冲突（canonical 被其他 dispatch 占用）显式 fail-closed——锁在 finally
  // 已释放，此处只做干净报错，不 push 不写盘
  if (outcome.code !== 0) {
    for (const e of outcome.errors) process.stderr.write(`[FINALIZE] ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(outcome.msg);
}
