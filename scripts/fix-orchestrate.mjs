#!/usr/bin/env node
// 修复执行编排器 — 计划: docs/plan/fix-orchestration-gate.md §4b（审 R1-P1-5 修正版）
// 职责（构造级保证「该串行必须串行」，不依赖 lead 诚实）:
//   allocate  按 plan 为本波每组建独立 worktree+分支（base=wave_base），产出组→路径/base 映射
//   integrate 逐组 merge 回集成分支；**merge 前比实改文件集**，非空交集 → fail-closed 弃组重排
//   waveBase  wave1 = candidate；wave k+1 = wave k 集成 tip（审 R1-P1-5: 否则依赖波看不见前波产物）
//
// 隔离即安全: 每组在自己 worktree 里改，并发写危险从构造上消失（不是事后检查）。
// git merge conflict 与 实改文件交集 是**真实**碰撞检测器，不是预测。
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fail, isMain, nowIso, normalizeRepoPath } from './lib/common.mjs';

// R5-P0: 「内容相等 ≠ 创建归属」——HEAD/base 血缘都可能与他人 worktree 撞值。
// 唯一可靠的归属判据是**创建时印记**: worktree 的 admin git-dir 里写 owner 文件
// （run_id + 随机 nonce），manifest 记录 nonce；cleanup 时两边比对。
const OWNER_FILE = 'pr-autopilot-owner';
export function stampOwner({ worktreeDir, payload, exec = null }) {
  const gitdir = exec
    ? exec(['git', '-C', worktreeDir, 'rev-parse', '--absolute-git-dir']).trim()
    : git(worktreeDir, 'rev-parse', '--absolute-git-dir');
  writeFileSync(join(gitdir, OWNER_FILE), JSON.stringify(payload) + '\n');
  return payload;
}
export function readOwner({ worktreeDir, exec = null }) {
  try {
    const gitdir = exec
      ? exec(['git', '-C', worktreeDir, 'rev-parse', '--absolute-git-dir']).trim()
      : git(worktreeDir, 'rev-parse', '--absolute-git-dir');
    return JSON.parse(readFileSync(join(gitdir, OWNER_FILE), 'utf8'));
  } catch { return null; }
}
export function newNonce() { return randomBytes(16).toString('hex'); }

const BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;

function git(repoDir, ...a) { return execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8', timeout: 120_000 }).trim(); }

export function groupBranch(runId, groupId) { return `fix/${runId}/${groupId}`; }
export function groupWorktreePath(worktreeRoot, runId, groupId) { return join(worktreeRoot, `${runId}-${groupId}`); }

// 为一个波次分配 worktree（幂等: 已存在同名 worktree 视为复用，base 必须一致否则 fail-closed）
export function allocateWave({ repoDir, worktreeRoot, runId, plan, waveIndex, waveBase, exec = null }) {
  const g = exec ? (...a) => exec(['git', '-C', repoDir, ...a]) : (...a) => git(repoDir, ...a);
  if (!/^[A-Za-z0-9._-]+$/.test(String(runId))) throw new Error(`runId 非法: ${runId}`);
  if (!/^[0-9a-f]{40}$/.test(String(waveBase))) throw new Error(`waveBase 必须是完整 SHA: ${waveBase}`);
  const wave = plan.waves?.[waveIndex];
  if (!Array.isArray(wave) || wave.length === 0) throw new Error(`plan 无 wave[${waveIndex}]`);

  const allocations = [];
  for (const groupId of wave) {
    const group = plan.groups.find((x) => x.id === groupId);
    if (!group) throw new Error(`plan.waves 引用未知组 ${groupId}`);
    for (const p of group.paths ?? []) {
      const r = normalizeRepoPath(p);
      if (!r.ok) throw new Error(`组 ${groupId} 路径非法 ${p}: ${r.reason}`);
    }
    const branch = groupBranch(runId, groupId);
    if (!BRANCH_RE.test(branch)) throw new Error(`分支名非法: ${branch}`);
    const wtPath = groupWorktreePath(worktreeRoot, runId, groupId);
    let nonce = null;
    if (existsSync(wtPath)) {
      // 幂等复用: 必须是本 run 本组创建的（owner 印记，R5-P0），且分支已在 waveBase 之上
      const owner = readOwner({ worktreeDir: wtPath, exec });
      if (!owner || owner.run_id !== runId || owner.group_id !== groupId) {
        throw new Error(`worktree ${wtPath} 无本 run 本组的 owner 印记（他人/残骸占位，fail-closed 人工清理）`);
      }
      nonce = owner.nonce;
      let head = null;
      try { head = exec ? exec(['git', '-C', wtPath, 'rev-parse', 'HEAD']).trim() : git(wtPath, 'rev-parse', 'HEAD'); } catch { /* 损坏 */ }
      const ok = head && (head === waveBase || isAncestor({ repoDir, ancestor: waveBase, descendant: head, exec }));
      if (!ok) throw new Error(`worktree 残骸 ${wtPath} 不在本波 base 之上（fail-closed，人工清理后重跑）`);
    } else {
      g('worktree', 'add', '-q', '-b', branch, wtPath, waveBase);
      nonce = newNonce();
      stampOwner({ worktreeDir: wtPath, payload: { run_id: runId, group_id: groupId, nonce }, exec });
    }
    allocations.push({ group_id: groupId, sc_ids: group.sc_ids, allowed_paths: group.paths, branch, worktree: wtPath, base: waveBase, owner_nonce: nonce });
  }
  return { run_id: runId, wave_index: waveIndex, wave_base: waveBase, allocations, allocated_at: nowIso() };
}

export function isAncestor({ repoDir, ancestor, descendant, exec = null }) {
  try {
    if (exec) { exec(['git', '-C', repoDir, 'merge-base', '--is-ancestor', ancestor, descendant]); return true; }
    execFileSync('git', ['-C', repoDir, 'merge-base', '--is-ancestor', ancestor, descendant], { encoding: 'utf8' });
    return true;
  } catch { return false; }
}

// 实改文件集（相对 base）——审 R1「actual write set 漂移」: anchor 是证据不是写集，必须按真实 diff 判
export function changedFiles({ repoDir, base, tip, exec = null }) {
  const out = exec
    ? exec(['git', '-C', repoDir, 'diff', '-z', '--name-only', `${base}..${tip}`])
    : git(repoDir, 'diff', '-z', '--name-only', `${base}..${tip}`);
  return String(out).split('\0').filter(Boolean);
}

// 集成一个波次: 逐组核验 tip 血统 → 两两比实改文件交集 → 无重叠才 merge
export function integrateWave({ repoDir, waveBase, groupTips, exec = null }) {
  const g = exec ? (...a) => exec(['git', '-C', repoDir, ...a]) : (...a) => git(repoDir, ...a);
  const report = { wave_base: waveBase, groups: [], overlaps: [], integrated_tip: null, ok: false };

  // ① 血统: 每组 tip 必须是 waveBase 的后代（防 lead 塞不相关 commit）
  for (const t of groupTips) {
    if (!/^[0-9a-f]{40}$/.test(String(t.tip))) { report.overlaps.push({ error: `组 ${t.group_id} tip 非完整 SHA` }); return report; }
    if (t.tip !== waveBase && !isAncestor({ repoDir, ancestor: waveBase, descendant: t.tip, exec })) {
      report.overlaps.push({ error: `组 ${t.group_id} 的 tip 不是本波 base 的后代（血统不符，fail-closed）` });
      return report;
    }
  }

  // ② 实改文件集 + 两两交集
  const sets = new Map();
  for (const t of groupTips) {
    const files = changedFiles({ repoDir, base: waveBase, tip: t.tip, exec });
    sets.set(t.group_id, files);
    report.groups.push({ group_id: t.group_id, tip: t.tip, changed: files });
  }
  const ids = [...sets.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = new Set(sets.get(ids[i]));
      const inter = sets.get(ids[j]).filter((f) => A.has(f));
      if (inter.length) report.overlaps.push({ a: ids[i], b: ids[j], files: inter });
    }
  }
  if (report.overlaps.length) return report; // fail-closed: 不 merge，调用方按 replan-serial 处理

  // ③ 逐组 merge（无重叠 → 文本冲突理论不该有；真有则 fail-closed 不留脏状态）
  g('checkout', '-q', '--detach', waveBase);
  for (const t of groupTips) {
    try {
      g('merge', '--no-edit', '-q', t.tip);
    } catch (e) {
      try { g('merge', '--abort'); } catch { /* 无进行中 merge */ }
      report.overlaps.push({ a: t.group_id, error: `merge 冲突（无文件重叠仍冲突，需人工）: ${e.message}` });
      return report;
    }
  }
  report.integrated_tip = exec ? exec(['git', '-C', repoDir, 'rev-parse', 'HEAD']).trim() : git(repoDir, 'rev-parse', 'HEAD');
  report.ok = true;
  return report;
}

// R6-P1: 分支是否正被任一 worktree 检出——update-ref 系操作会绕过 git 的检出保护，
// 删除/移动前必须显式查（branch -D 会拒，update-ref 不会）
export function branchCheckedOut({ repoDir, branch, exec = null }) {
  const out = exec ? exec(['git', '-C', repoDir, 'worktree', 'list', '--porcelain']) : git(repoDir, 'worktree', 'list', '--porcelain');
  return String(out).split('\n').includes(`branch refs/heads/${branch}`);
}

// R7/R8-P1: 分支 CAS 删除的**补偿事务**（group / serial / integration 共用同一实现，
// 避免两条路径漂移）。不变量: destructive step（update-ref -d）之后的任何异常都不得在
// 补偿尝试前逃逸——包括复查命令自身失败（R8 实证: worktree list 普通 IO 失败即可让
// 删除落地却既不回滚也不留 br-restore-fail，racer worktree 被打成 unborn）。
//   ① 预检查检出（含检查失败）→ fail-closed 不删
//   ② CAS 删除（old = 记录 tip；不匹配 git 自己拒）
//   ③ 删除后复查: 抛错 = **按不安全处理**（与"确实被检出"同路径）
//   ④ 需补偿 → 创建式 CAS（old = 全零）按记录 tip 精确恢复；成功记 br-restored，
//      失败记 br-restore-fail 并带完整 expected tip + 两个错误
function casDeleteBranch({ repoDir, branch, expectedTip, label, exec, g, steps, errors }) {
  let checkedOut = null;
  try { checkedOut = branchCheckedOut({ repoDir, branch, exec }); }
  catch (e) {
    errors.push(`拒绝删除分支 ${branch}: 无法确认检出状态（${e.message}）——fail-closed 不做破坏性操作`);
    steps.push(`br-refused:${label}`);
    return;
  }
  if (checkedOut) {
    // R6-P1: update-ref -d 会绕过 git 的 checked-out 保护，把检出方打成「No commits yet」
    errors.push(`拒绝删除分支 ${branch}: 正被某个 worktree 检出（update-ref 会绕过 git 检出保护破坏其基线，fail-closed——R6-P1）`);
    steps.push(`br-refused:${label}`);
    return;
  }
  try { g('update-ref', '-d', `refs/heads/${branch}`, expectedTip); }
  catch (e) {
    errors.push(`分支 CAS 删除失败 ${branch}: ${e.message}`);
    steps.push(`br-refused:${label}`);
    return;
  }
  // —— 以下已是「删除已落地」，必须走完补偿状态机 ——
  let raced = false, recheckErr = null;
  try { raced = branchCheckedOut({ repoDir, branch, exec }); }
  catch (e) { raced = true; recheckErr = e; } // 复查失败 → 不可证明安全 → 按不安全处理（R8-P1）
  if (!raced) { steps.push(`br-deleted:${label}`); return; }
  try {
    g('update-ref', `refs/heads/${branch}`, expectedTip, '0'.repeat(40)); // 仅当 ref 不存在时恢复（不覆盖第三方同名新 ref）
    errors.push(recheckErr
      ? `分支 ${branch} 删除后复查失败（${recheckErr.message}）——按不安全处理，已按记录 tip ${expectedTip} 恢复（R8-P1）`
      : `分支 ${branch} 删除时被检出竞态——已按记录 tip 原样恢复（R7-P1 补偿回滚）`);
    steps.push(`br-restored:${label}`);
  } catch (e2) {
    errors.push(`分支 ${branch} 补偿恢复失败，请人工恢复到 ${expectedTip}: ${e2.message}${recheckErr ? ` / 复查错误: ${recheckErr.message}` : ''}`);
    steps.push(`br-restore-fail:${label}`);
  }
}

// git 已登记的 worktree 路径集合（SC-1 归属校验的唯一可信来源）
export function registeredWorktrees({ repoDir, exec = null }) {
  const out = exec ? exec(['git', '-C', repoDir, 'worktree', 'list', '--porcelain']) : git(repoDir, 'worktree', 'list', '--porcelain');
  const paths = [];
  for (const line of String(out).split('\n')) {
    const m = line.match(/^worktree (.+)$/);
    if (m) { try { paths.push(realpathSync(m[1])); } catch { paths.push(m[1]); } }
  }
  return paths;
}

// 清理本 run 的全部 worktree/分支（终态或 replan 时调用）
// 归属模型（R5-P0 定版——「内容相等 ≠ 创建归属」，HEAD/血缘集合可被撞值）:
//   worktree: ① git 登记（realpath）② common-dir 归属本仓 ③ **owner 印记**——创建时写进
//   admin git-dir 的 {run_id, nonce} 必须与 manifest 记录完全一致（组/串行/integration 一律）；
//   分支目标叠加 ④ 检出分支 == 记录分支。integration 目标**只来自 manifest 的
//   integration_worktree 记录**（没有记录 = 本 run 从未创建 = 一个字都不碰，路径不做预测）。
//   分支删除: worktree 归属已证 → branch -D；否则必须有记录 tip，用
//   `git update-ref -d <ref> <expected>` 做 CAS 删除——无记录/不匹配一律拒。
// 任一不符 → 拒删且**连分支都不删**；remove 失败 → wt-fail 交人工，绝不 rmSync 兜底。
export function cleanupRun({ manifest, exec = null }) {
  const repoDir = manifest.repo_dir;
  const runId = manifest.run_id;
  const g = exec ? (...a) => exec(['git', '-C', repoDir, ...a]) : (...a) => git(repoDir, ...a);
  const steps = [];
  const errors = [];
  let registered = [];
  try { registered = registeredWorktrees({ repoDir, exec }); }
  catch (e) { return { steps, errors: [`无法读取 git worktree 列表（fail-closed 不删任何目录）: ${e.message}`] }; }
  let repoCommon = null;
  try {
    const out = exec ? exec(['git', '-C', repoDir, 'rev-parse', '--git-common-dir']).trim() : git(repoDir, 'rev-parse', '--git-common-dir');
    repoCommon = realpathSync(resolve(repoDir, out));
  } catch (e) { return { steps, errors: [`无法解析本仓 git common-dir（fail-closed）: ${e.message}`] }; }

  // 回收目标全部来自 manifest 记录。integration 只认创建记录（R5-P0: 不做路径预测）。
  const targets = [];
  let lastIntegrationTip = null;
  if (manifest.integration_worktree) {
    targets.push({ label: 'integration', worktree: manifest.integration_worktree.path, branch: null, nonce: manifest.integration_worktree.nonce ?? null });
  }
  for (const w of manifest.waves ?? []) {
    const tipOf = (gid) => (w.tips ?? []).find((x) => x.group_id === gid)?.tip ?? null;
    for (const a of w.allocations ?? []) targets.push({ label: a.group_id, worktree: a.worktree, branch: a.branch, nonce: a.owner_nonce ?? null, expectedTip: tipOf(a.group_id) });
    for (const r of w.replan?.rounds ?? []) targets.push({ label: `${r.group_id}-r${r.round}`, worktree: r.worktree, branch: r.branch, nonce: r.owner_nonce ?? null, expectedTip: r.tip ?? null });
    if (w.integrated_tip) lastIntegrationTip = w.integrated_tip;
  }

  const seen = new Set();
  for (const t of targets) {
    if (seen.has(t.worktree)) continue;
    seen.add(t.worktree);
    let owned = true;
    if (existsSync(t.worktree)) {
      let real = t.worktree;
      try { real = realpathSync(t.worktree); } catch { /* 保持原值 */ }
      if (!registered.includes(real)) {
        errors.push(`拒绝回收 ${t.worktree}: 不在本仓 git worktree 登记列表内（归属不符，fail-closed）`);
        steps.push(`wt-refused:${t.label}`);
        owned = false;
      }
      if (owned) {
        // 归属校验 ②: common-dir 必须是本仓
        try {
          const out = exec ? exec(['git', '-C', t.worktree, 'rev-parse', '--git-common-dir']).trim() : git(t.worktree, 'rev-parse', '--git-common-dir');
          const wtCommon = realpathSync(resolve(t.worktree, out));
          if (wtCommon !== repoCommon) {
            errors.push(`拒绝回收 ${t.worktree}: 归属其他仓（common-dir 不符，fail-closed）`);
            steps.push(`wt-refused:${t.label}`);
            owned = false;
          }
        } catch (e) {
          errors.push(`拒绝回收 ${t.worktree}: 无法确认归属（${e.message}）`);
          steps.push(`wt-refused:${t.label}`);
          owned = false;
        }
      }
      if (owned) {
        // 归属校验 ③（R5-P0 核心）: owner 印记必须与 manifest 记录一致——
        // 内容点（HEAD==base/squash）可撞值，创建 nonce 撞不了
        const o = readOwner({ worktreeDir: t.worktree, exec });
        if (!t.nonce || !o || o.run_id !== runId || o.nonce !== t.nonce) {
          errors.push(`拒绝回收 ${t.worktree}: owner 印记缺失/不匹配（记录=${t.nonce ? t.nonce.slice(0, 8) : '无'} 实际=${o?.nonce ? o.nonce.slice(0, 8) : '无'}——归属不符，fail-closed）`);
          steps.push(`wt-refused:${t.label}`);
          owned = false;
        }
      }
      if (owned && t.branch) {
        // 归属校验 ④: 检出分支必须就是 allocation 记录的分支
        let headRef = null;
        try { headRef = exec ? exec(['git', '-C', t.worktree, 'symbolic-ref', '--short', 'HEAD']).trim() : git(t.worktree, 'symbolic-ref', '--short', 'HEAD'); }
        catch { /* detached */ }
        if (headRef !== t.branch) {
          errors.push(`拒绝回收 ${t.worktree}: 检出分支 ${headRef ?? '(detached)'} ≠ allocation 记录 ${t.branch}（归属不符，fail-closed）`);
          steps.push(`wt-refused:${t.label}`);
          owned = false;
        }
      }
      if (owned) {
        try { g('worktree', 'remove', '--force', t.worktree); steps.push(`wt-removed:${t.label}`); }
        catch (e) {
          errors.push(`git worktree remove 失败（不做强删兜底，请人工检查 ${t.worktree}）: ${e.message}`);
          steps.push(`wt-fail:${t.label}`);
          owned = false;
        }
      }
    } else {
      steps.push(`wt-absent:${t.label}`);
      owned = false; // worktree 缺席 = 归属未证明，分支删除必须走 CAS
    }
    // 分支删除: 归属已证（owned）→ branch -D；否则只接受「记录 tip 完全一致」的 CAS 删除
    if (t.branch) {
      let brTip = null;
      try { brTip = exec ? exec(['git', '-C', repoDir, 'rev-parse', `refs/heads/${t.branch}`]).trim() : git(repoDir, 'rev-parse', `refs/heads/${t.branch}`); }
      catch { steps.push(`br-absent:${t.label}`); continue; }
      if (owned) {
        try { g('branch', '-D', t.branch); steps.push(`br-deleted:${t.label}`); } catch { steps.push(`br-absent:${t.label}`); }
      } else if (!existsSync(t.worktree)) {
        if (!t.expectedTip) {
          errors.push(`拒绝删除分支 ${t.branch}: 本 run 无记录 tip、worktree 又已缺席，归属无法确认（fail-closed 交人工）`);
          steps.push(`br-refused:${t.label}`);
        } else if (brTip !== t.expectedTip) {
          errors.push(`拒绝删除分支 ${t.branch}: tip ${brTip.slice(0, 12)} ≠ 记录 ${t.expectedTip.slice(0, 12)}（同名他人分支/被移动，fail-closed）`);
          steps.push(`br-refused:${t.label}`);
        } else {
          // 「未被检出」是外部条件，CAS 只保护 ref 的 old 值——统一走补偿事务 helper
          casDeleteBranch({ repoDir, branch: t.branch, expectedTip: t.expectedTip, label: t.label, exec, g, steps, errors });
        }
      }
      // owned=false 且 worktree 仍在（归属不符）→ 分支一个字都不碰
    }
  }
  if (manifest.integration_branch) {
    // integration 分支同样走 CAS: expected = 最后记录的 integrated_tip；无记录 → 拒
    let ibTip = null;
    try { ibTip = exec ? exec(['git', '-C', repoDir, 'rev-parse', `refs/heads/${manifest.integration_branch}`]).trim() : git(repoDir, 'rev-parse', `refs/heads/${manifest.integration_branch}`); }
    catch { steps.push('br-absent:integration'); ibTip = null; }
    if (ibTip !== null) {
      if (!lastIntegrationTip || ibTip !== lastIntegrationTip) {
        errors.push(`拒绝删除分支 ${manifest.integration_branch}: tip ${ibTip.slice(0, 12)} ≠ 记录的 integrated_tip ${lastIntegrationTip ? lastIntegrationTip.slice(0, 12) : '(无)'}（同名他人分支/无记录，fail-closed）`);
        steps.push('br-refused:integration');
      } else {
        // 与 group/serial 同一补偿事务实现（R8-P1: 消除两条路径漂移）
        casDeleteBranch({ repoDir, branch: manifest.integration_branch, expectedTip: lastIntegrationTip, label: 'integration', exec, g, steps, errors });
      }
    }
  }
  try { g('worktree', 'prune'); } catch { /* best-effort */ }
  return { steps, errors };
}

// SC-R3-11: 独立 CLI 入口已删除——fix-run.mjs 是唯一编排入口（本文件只做库函数）。
// 直接执行本文件 = 用法错误，指向状态机入口。
if (isMain(import.meta.url)) {
  fail('fix-orchestrate.mjs 不再提供 CLI（SC-R3-11: 单入口防绕过状态机）。请使用 scripts/fix-run.mjs <init|allocate|integrate|serial-allocate|serial-integrate|validate|finalize|cleanup>');
}
