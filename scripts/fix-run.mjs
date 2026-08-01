#!/usr/bin/env node
// 有状态修复编排器 — SC-8（审 R2-P1-4）。
// R2 判定: 无状态 allocate/integrate/cleanup CLI 之间「没有任何主体持有 run 不变量」，
// 导致 wave base、group tips、lineage 全靠 lead 手工传对，overlap 后的恢复路径实际是死的。
// 本模块引入 **run manifest**（hash 链 append-only 事件）作为唯一权威状态，并强制:
//   ① CAS 波次基线: wave0 base == plan 绑定的 source candidate；wave k+1 base == manifest 记录的
//      wave k integrated_tip。**base 不接受 caller 自报**（旧实现 allocate 收任意 40hex SHA）
//   ② tip 归属: 每组 tip 必须 == 该组 allocation 分支 HEAD、≠ base（非空交卷）、
//      实改 ⊆ 该组 allowed_paths（verify 组额外要求全为测试路径）；组集合与 planned exact 相等
//   ③ 专用 integration worktree/分支（不在主 repoDir detach），集成后把 feature branch 前推到
//      integrated_tip，使 push-guard 的 branch-ref==expected_sha 自然成立
//   ④ overlap 自动串行重跑（不再 return false 让恢复路径死掉），事件入 manifest
//   ⑤ SC-10b: 集成后 orchestrator **自己复跑** 各 SC 的 verify 命令，不信 worker 自报
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readJson, parseArgs, fail, isMain, nowIso, sha256, canonicalJson, normalizeRepoPath } from './lib/common.mjs';
import { computeFixPlanHash } from './fix-plan.mjs';
import { allocateWave, integrateWave, changedFiles, isAncestor, groupBranch, groupWorktreePath, cleanupRun } from './fix-orchestrate.mjs';

const TEST_PATH_RE = /(^|\/)(e2e|fixtures)\//;
const TEST_FILE_RE = /\.(test|spec)\.[A-Za-z0-9]+$/;
const isTestPath = (p) => TEST_PATH_RE.test(p) || TEST_FILE_RE.test(p);

function git(repoDir, ...a) { return execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8', timeout: 120_000 }).trim(); }

export function runManifestPath(stateDir, runId) { return join(stateDir, `run-${runId}.json`); }
export function integrationBranch(runId) { return `fix/${runId}/integration`; }

// hash 链: 每个事件带 prev = 上一事件规范化内容的 sha256（删/改历史即断裂）
export function appendEvent(manifest, event) {
  const prev = manifest.events.length ? sha256(canonicalJson(manifest.events[manifest.events.length - 1])) : 'GENESIS';
  manifest.events.push({ ...event, at: nowIso(), prev });
  return manifest;
}
export function verifyEventChain(manifest) {
  const errs = [];
  for (let i = 0; i < (manifest.events ?? []).length; i++) {
    const e = manifest.events[i];
    const expect = i === 0 ? 'GENESIS' : sha256(canonicalJson({ ...manifest.events[i - 1] }));
    if (e.prev !== expect) errs.push(`run manifest 事件链断裂于第 ${i + 1} 条（疑似删改历史，fail-closed）`);
  }
  return errs;
}
function saveManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  renameSync(tmp, path);
}

// ---- init: 绑定 plan 与 source candidate（此后 base 全部由 manifest 派生） ----
export function initRun({ stateDir, runId, repoDir, plan, sourceCandidate, featureBranch }) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(runId))) throw new Error(`runId 非法: ${runId}`);
  if (!/^[0-9a-f]{40}$/.test(String(sourceCandidate))) throw new Error('sourceCandidate 必须是完整 SHA');
  const real = computeFixPlanHash(plan);
  if (plan.fix_plan_hash !== real) throw new Error('plan 自身 hash 与内容重算不符（plan 被改）');
  const path = runManifestPath(stateDir, runId);
  if (existsSync(path)) throw new Error(`run ${runId} 已存在（幂等保护，换 runId 或先 cleanup）`);
  const m = {
    schema_version: 'v1', run_id: runId, repo_dir: repoDir,
    fix_plan_hash: plan.fix_plan_hash, source_candidate: sourceCandidate,
    feature_branch: featureBranch ?? null,
    integration_branch: integrationBranch(runId),
    waves: [], events: []
  };
  appendEvent(m, { kind: 'run-init', source_candidate: sourceCandidate, plan_hash: plan.fix_plan_hash, waves: plan.waves.length });
  saveManifest(path, m);
  return m;
}

// ---- 波次基线: CAS 派生，不接受 caller 自报（SC-8 ①） ----
export function nextWaveBase(manifest, waveIndex) {
  if (waveIndex === 0) return manifest.source_candidate;
  const prev = manifest.waves[waveIndex - 1];
  if (!prev || !prev.integrated_tip) {
    throw new Error(`wave${waveIndex + 1} 的 base 不可得: wave${waveIndex} 尚未集成（CAS 强制顺序，不接受跳波/自报 base）`);
  }
  return prev.integrated_tip;
}

export function allocate({ stateDir, runId, plan, waveIndex, worktreeRoot }) {
  const path = runManifestPath(stateDir, runId);
  const m = readJson(path);
  const chainErrs = verifyEventChain(m);
  if (chainErrs.length) throw new Error(chainErrs[0]);
  if (m.fix_plan_hash !== computeFixPlanHash(plan)) throw new Error('plan 与 run manifest 绑定的 plan hash 不符');
  if (m.waves[waveIndex]?.integrated_tip) throw new Error(`wave${waveIndex + 1} 已集成，不可重复 allocate`);
  const waveBase = nextWaveBase(m, waveIndex); // ← 权威来源
  const alloc = allocateWave({ repoDir: m.repo_dir, worktreeRoot, runId, plan, waveIndex, waveBase });
  m.waves[waveIndex] = { wave_index: waveIndex, base: waveBase, worktree_root: worktreeRoot, allocations: alloc.allocations, tips: null, integrated_tip: null, validation: null };
  appendEvent(m, { kind: 'wave-allocate', wave: waveIndex, base: waveBase, groups: alloc.allocations.map((a) => a.group_id) });
  saveManifest(path, m);
  return { manifest: m, allocations: alloc.allocations, wave_base: waveBase };
}

// ---- tip 归属校验（SC-8 ②） ----
export function validateTips({ repoDir, plan, waveIndex, waveState }) {
  const errs = [];
  const planned = plan.waves[waveIndex] ?? [];
  const allocs = new Map((waveState.allocations ?? []).map((a) => [a.group_id, a]));
  const tips = [];
  for (const groupId of planned) {
    const a = allocs.get(groupId);
    if (!a) { errs.push(`wave${waveIndex + 1}: 组 ${groupId} 无分配记录`); continue; }
    let head = null;
    try { head = git(repoDir, 'rev-parse', `refs/heads/${a.branch}`); }
    catch { errs.push(`组 ${groupId} 的分支 ${a.branch} 不存在（worker 未在分配的 worktree 内工作？）`); continue; }
    // 非空交卷
    if (head === waveState.base) { errs.push(`组 ${groupId} 的 tip 等于 base（空交卷，worker 先 commit 再 reset 也在此被拦）`); continue; }
    if (!isAncestor({ repoDir, ancestor: waveState.base, descendant: head })) {
      errs.push(`组 ${groupId} 的 tip 不是本波 base 的后代（血统不符）`); continue;
    }
    // 实改必须落在该组 allowed_paths（verify 组额外要求全测试路径）
    const changed = changedFiles({ repoDir, base: waveState.base, tip: head });
    if (changed.length === 0) { errs.push(`组 ${groupId} 实改为空（空交卷）`); continue; }
    const allowed = new Set(a.allowed_paths ?? []);
    const group = plan.groups.find((g) => g.id === groupId);
    for (const f of changed) {
      const r = normalizeRepoPath(f);
      if (!r.ok) { errs.push(`组 ${groupId} 改了非法路径 ${f}`); continue; }
      if (group?.verify) {
        if (!isTestPath(f)) errs.push(`verify 组 ${groupId} 改了非测试文件 ${f}（verify 位不得藏生产改动）`);
      } else if (!allowed.has(f)) {
        errs.push(`组 ${groupId} 越域改动 ${f}（不在 allowed_paths: ${[...allowed].join(',')}）`);
      }
    }
    tips.push({ group_id: groupId, tip: head, changed });
  }
  return { errs, tips };
}

// ---- 集成（含 overlap 自动串行重跑 SC-8 ④） ----
export function integrate({ stateDir, runId, plan, waveIndex }) {
  const path = runManifestPath(stateDir, runId);
  const m = readJson(path);
  const chainErrs = verifyEventChain(m);
  if (chainErrs.length) throw new Error(chainErrs[0]);
  const ws = m.waves[waveIndex];
  if (!ws) throw new Error(`wave${waveIndex + 1} 未 allocate`);
  if (ws.integrated_tip) return { manifest: m, integrated_tip: ws.integrated_tip, already: true };

  const { errs, tips } = validateTips({ repoDir: m.repo_dir, plan, waveIndex, waveState: ws });
  if (errs.length) {
    appendEvent(m, { kind: 'tips-rejected', wave: waveIndex, errors: errs.slice(0, 5) });
    saveManifest(path, m);
    return { manifest: m, ok: false, errors: errs };
  }
  ws.tips = tips;

  // 实改交集检测
  const overlaps = [];
  for (let i = 0; i < tips.length; i++) {
    for (let j = i + 1; j < tips.length; j++) {
      const A = new Set(tips[i].changed);
      const inter = tips[j].changed.filter((f) => A.has(f));
      if (inter.length) overlaps.push({ a: tips[i].group_id, b: tips[j].group_id, files: inter });
    }
  }

  const g = (...a) => git(m.repo_dir, ...a);
  // 专用 integration 分支（SC-8 ③）——不在主 repoDir 上裸 detach
  const ib = m.integration_branch;
  try { g('branch', '-f', ib, ws.base); } catch { g('branch', ib, ws.base); }

  let order = tips;
  if (overlaps.length) {
    // SC-8 ④: 自动串行重跑——把碰撞组按确定性顺序逐个 rebase 到最新 integration tip
    appendEvent(m, { kind: 'overlap-detected', wave: waveIndex, overlaps });
    order = [...tips].sort((x, y) => x.group_id.localeCompare(y.group_id));
  }

  const prevHead = g('rev-parse', 'HEAD');
  const wt = join(ws.worktree_root, `${runId}-integration`);
  try {
    if (!existsSync(wt)) g('worktree', 'add', '-q', '--detach', wt, ws.base);
    else execFileSync('git', ['-C', wt, 'checkout', '-q', '--detach', ws.base], { encoding: 'utf8' });
    const gi = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8', timeout: 120_000 }).trim();
    const serialized = [];
    for (const t of order) {
      if (overlaps.length) {
        // 串行重跑: 把该组改动以 cherry-pick 方式叠到当前 integration tip（冲突则 fail-closed）
        try { gi('cherry-pick', '-x', `${ws.base}..${t.tip}`); serialized.push(t.group_id); }
        catch (e) {
          try { gi('cherry-pick', '--abort'); } catch { /* 无进行中 */ }
          appendEvent(m, { kind: 'serial-rerun-failed', wave: waveIndex, group: t.group_id, error: e.message });
          saveManifest(path, m);
          return { manifest: m, ok: false, errors: [`串行重跑组 ${t.group_id} 时冲突，需人工: ${e.message}`], overlaps };
        }
      } else {
        try { gi('merge', '--no-edit', '-q', t.tip); }
        catch (e) {
          try { gi('merge', '--abort'); } catch { /* noop */ }
          appendEvent(m, { kind: 'merge-failed', wave: waveIndex, group: t.group_id, error: e.message });
          saveManifest(path, m);
          return { manifest: m, ok: false, errors: [`merge 组 ${t.group_id} 冲突: ${e.message}`] };
        }
      }
    }
    const integratedTip = gi('rev-parse', 'HEAD');
    g('branch', '-f', ib, integratedTip);
    ws.integrated_tip = integratedTip;
    ws.serialized_groups = serialized.length ? serialized : null;
    appendEvent(m, { kind: 'wave-integrated', wave: waveIndex, integrated_tip: integratedTip, group_tips: tips.map((t) => ({ group_id: t.group_id, tip: t.tip })), serialized: serialized.length ? serialized : null });
    saveManifest(path, m);
    return { manifest: m, ok: true, integrated_tip: integratedTip, overlaps, serialized };
  } finally {
    try { if (prevHead) g('checkout', '-q', prevHead); } catch { /* 主仓状态尽力还原 */ }
  }
}

// ---- SC-10b: orchestrator 复跑 SC verify（不信 worker 自报） ----
export function validateIntegration({ stateDir, runId, scManifest, waveIndex, runner = null }) {
  const path = runManifestPath(stateDir, runId);
  const m = readJson(path);
  const ws = m.waves[waveIndex];
  if (!ws?.integrated_tip) throw new Error(`wave${waveIndex + 1} 未集成，无法验证`);
  const wt = join(ws.worktree_root, `${runId}-integration`);
  const scIds = new Set((ws.allocations ?? []).flatMap((a) => a.sc_ids));
  const results = [];
  for (const sc of scManifest.scs ?? []) {
    if (!scIds.has(sc.id)) continue;
    let status = 'PASS', out = '';
    try {
      out = runner ? runner(sc.verify, wt) : execFileSync('/bin/sh', ['-c', sc.verify], { cwd: wt, encoding: 'utf8', timeout: 600_000 });
    } catch (e) { status = 'FAIL'; out = String(e.message ?? '').slice(0, 300); }
    results.push({ sc_id: sc.id, status, evidence: String(out).slice(0, 300) });
  }
  const ok = results.every((r) => r.status === 'PASS');
  ws.validation = { at: nowIso(), ok, results };
  appendEvent(m, { kind: 'wave-validated', wave: waveIndex, ok, failed: results.filter((r) => r.status !== 'PASS').map((r) => r.sc_id) });
  saveManifest(path, m);
  return { ok, results, manifest: m };
}

// ---- 收尾: 把 feature branch 前推到最终 integration tip（SC-8 ③） ----
export function finalizeRun({ stateDir, runId }) {
  const path = runManifestPath(stateDir, runId);
  const m = readJson(path);
  const chainErrs = verifyEventChain(m);
  if (chainErrs.length) throw new Error(chainErrs[0]);
  const last = m.waves[m.waves.length - 1];
  if (!last?.integrated_tip) throw new Error('最后一波尚未集成，不能 finalize');
  for (const [i, w] of m.waves.entries()) {
    if (!w.validation?.ok) throw new Error(`wave${i + 1} 未通过 orchestrator 复跑验证（fail-closed）`);
  }
  if (m.feature_branch) git(m.repo_dir, 'branch', '-f', m.feature_branch, last.integrated_tip);
  m.final_candidate = last.integrated_tip;
  appendEvent(m, { kind: 'run-finalized', final_candidate: last.integrated_tip, feature_branch: m.feature_branch ?? null });
  saveManifest(path, m);
  return { final_candidate: last.integrated_tip, manifest: m };
}

// SC-9 用: run manifest 的权威 hash（纳入 fix_orchestration）
export function runManifestHash(m) {
  return sha256(canonicalJson({
    v: 'fix-run/v1', run_id: m.run_id, fix_plan_hash: m.fix_plan_hash,
    source_candidate: m.source_candidate, final_candidate: m.final_candidate ?? null,
    waves: (m.waves ?? []).map((w) => ({ base: w.base, tips: (w.tips ?? []).map((t) => ({ g: t.group_id, tip: t.tip })), integrated_tip: w.integrated_tip, validation_ok: !!w.validation?.ok }))
  }));
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const mode = args._[0];
  const need = (ks) => { for (const k of ks) if (!args[k]) fail(`缺参数 --${k}`); };
  try {
    if (mode === 'init') {
      need(['state-dir', 'run-id', 'repo-dir', 'plan', 'source-candidate']);
      const m = initRun({ stateDir: args['state-dir'], runId: args['run-id'], repoDir: args['repo-dir'], plan: readJson(args.plan), sourceCandidate: args['source-candidate'], featureBranch: args['feature-branch'] });
      process.stdout.write(JSON.stringify({ ok: true, run_id: m.run_id, source_candidate: m.source_candidate }) + '\n');
    } else if (mode === 'allocate') {
      need(['state-dir', 'run-id', 'plan', 'wave', 'worktree-root']);
      const r = allocate({ stateDir: args['state-dir'], runId: args['run-id'], plan: readJson(args.plan), waveIndex: Number(args.wave), worktreeRoot: args['worktree-root'] });
      process.stdout.write(JSON.stringify({ ok: true, wave_base: r.wave_base, allocations: r.allocations }, null, 2) + '\n');
    } else if (mode === 'integrate') {
      need(['state-dir', 'run-id', 'plan', 'wave']);
      const r = integrate({ stateDir: args['state-dir'], runId: args['run-id'], plan: readJson(args.plan), waveIndex: Number(args.wave) });
      process.stdout.write(JSON.stringify(r.ok ? { ok: true, integrated_tip: r.integrated_tip, serialized: r.serialized ?? null } : { ok: false, errors: r.errors }, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    } else if (mode === 'validate') {
      need(['state-dir', 'run-id', 'sc-manifest', 'wave']);
      const r = validateIntegration({ stateDir: args['state-dir'], runId: args['run-id'], scManifest: readJson(args['sc-manifest']), waveIndex: Number(args.wave) });
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    } else if (mode === 'finalize') {
      need(['state-dir', 'run-id']);
      const r = finalizeRun({ stateDir: args['state-dir'], runId: args['run-id'] });
      process.stdout.write(JSON.stringify({ ok: true, final_candidate: r.final_candidate, run_manifest_hash: runManifestHash(r.manifest) }) + '\n');
    } else if (mode === 'cleanup') {
      need(['state-dir', 'run-id', 'plan', 'worktree-root']);
      const m = readJson(runManifestPath(args['state-dir'], args['run-id']));
      const r = cleanupRun({ repoDir: m.repo_dir, worktreeRoot: args['worktree-root'], runId: args['run-id'], plan: readJson(args.plan) });
      process.stdout.write(JSON.stringify(r) + '\n');
    } else {
      fail('用法: fix-run.mjs <init|allocate|integrate|validate|finalize|cleanup> ...\n（有状态编排器: base 由 run manifest CAS 派生，不接受自报——SC-8）');
    }
  } catch (e) {
    process.stderr.write(`[FIX-RUN] ${e.message}\n`);
    process.exit(1);
  }
}
