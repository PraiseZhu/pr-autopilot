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
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail, isMain, nowIso, normalizeRepoPath } from './lib/common.mjs';

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
    if (existsSync(wtPath)) {
      // 幂等复用: 该 worktree 的分支必须已在 waveBase 之上（防拿旧波残骸当本波用）
      let head = null;
      try { head = exec ? exec(['git', '-C', wtPath, 'rev-parse', 'HEAD']).trim() : git(wtPath, 'rev-parse', 'HEAD'); } catch { /* 损坏 */ }
      const ok = head && (head === waveBase || isAncestor({ repoDir, ancestor: waveBase, descendant: head, exec }));
      if (!ok) throw new Error(`worktree 残骸 ${wtPath} 不在本波 base 之上（fail-closed，人工清理后重跑）`);
    } else {
      g('worktree', 'add', '-q', '-b', branch, wtPath, waveBase);
    }
    allocations.push({ group_id: groupId, sc_ids: group.sc_ids, allowed_paths: group.paths, branch, worktree: wtPath, base: waveBase });
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
// SC-R3-1（R3-P0，替换 R2 的 SC-1 半成品）: 回收对象**只从 run manifest 枚举**——
// caller 不再传 worktreeRoot/plan（v1 用 caller 输入预测路径 = 同仓无关 worktree 恰好同名
// 即被 remove --force，R3 实证的 P0）。每个目标做**双重归属校验**:
//   ① 路径出现在 git worktree list（realpath 比对）
//   ② 该 worktree 的 git common-dir 归属本仓，且（组/串行 worktree）检出分支 == 记录分支
// 任一不符 → 拒删且**连分支都不删**。git worktree remove 失败 → 记 wt-fail 交人工，
// 绝不 rmSync 兜底。
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

  // 回收目标全部来自 manifest 记录（allocation / 串行轮 / integration worktree + 各自分支）
  const targets = [];
  for (const w of manifest.waves ?? []) {
    for (const a of w.allocations ?? []) targets.push({ label: a.group_id, worktree: a.worktree, branch: a.branch });
    for (const r of w.replan?.rounds ?? []) targets.push({ label: `${r.group_id}-r${r.round}`, worktree: r.worktree, branch: r.branch });
    if (w.worktree_root) targets.push({ label: 'integration', worktree: join(w.worktree_root, `${runId}-integration`), branch: null, detachedOk: true });
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
      if (owned && t.branch) {
        // 归属校验 ②b: 检出分支必须就是 allocation 记录的分支
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
    }
    // 分支只在 worktree 归属确认（或已不存在）时删——归属不符连分支都不动
    if (t.branch && (owned || !existsSync(t.worktree))) {
      try { g('branch', '-D', t.branch); steps.push(`br-deleted:${t.label}`); } catch { steps.push(`br-absent:${t.label}`); }
    }
  }
  if (manifest.integration_branch) {
    try { g('branch', '-D', manifest.integration_branch); steps.push('br-deleted:integration'); } catch { steps.push('br-absent:integration'); }
  }
  try { g('worktree', 'prune'); } catch { /* best-effort */ }
  return { steps, errors };
}

// SC-R3-11: 独立 CLI 入口已删除——fix-run.mjs 是唯一编排入口（本文件只做库函数）。
// 直接执行本文件 = 用法错误，指向状态机入口。
if (isMain(import.meta.url)) {
  fail('fix-orchestrate.mjs 不再提供 CLI（SC-R3-11: 单入口防绕过状态机）。请使用 scripts/fix-run.mjs <init|allocate|integrate|serial-allocate|serial-integrate|validate|finalize|cleanup>');
}
