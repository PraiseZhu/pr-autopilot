#!/usr/bin/env node
// 有状态修复编排器 v2 — SC-8（R2）+ R3 全面修正。
// R3 判定 v1 的四个实质洞并在此关闭:
//   · integrate 不校验 caller plan → 现在 init/allocate/integrate/serial-*/finalize 全程绑定
//     canonical plan hash（SC-R3-2）
//   · validate 可被空/错 sc-manifest 造 vacuous PASS → init 绑定 sc_manifest_hash，
//     validate 要求本波 SC 集 exact 全覆盖（SC-R3-3）
//   · verify 走 /bin/sh -c + 原样落 stdout → 结构化 argv + execFile(shell:false) +
//     只存 exit/sha256（SC-R3-4，owner 决策 D2）
//   · cherry-pick 被冒充「串行重跑」→ 删除；overlap = fail-closed + 串行重派，worker 在
//     新 base 上**真实重跑**（SC-R3-9，owner 决策 D1）
// 集成方式 = squash（D1）: 每波只把验证过的最终树用 commit-tree 打成一个 squash commit，
// group tips 永不进最终祖先——「commit 藏密钥再恢复」的净 diff 洗历史从构造上无处容身，
// push-guard 的 lineage 校验退化为精确集合判定（SC-R3-8）。
// 主 checkout 零接触: 全程不在主 repoDir checkout/detach（SC-R3-11）。
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readJson, parseArgs, fail, isMain, nowIso, sha256, canonicalJson, normalizeRepoPath, hashObject } from './lib/common.mjs';
import { computeFixPlanHash } from './fix-plan.mjs';
import { recomputeArtifactHash } from './consensus-gate.mjs';
import { allocateWave, changedFiles, isAncestor, cleanupRun, stampOwner, readOwner, newNonce } from './fix-orchestrate.mjs';

const TEST_PATH_RE = /(^|\/)(e2e|fixtures)\//;
const TEST_FILE_RE = /\.(test|spec)\.[A-Za-z0-9]+$/;
const isTestPath = (p) => TEST_PATH_RE.test(p) || TEST_FILE_RE.test(p);

function git(repoDir, ...a) { return execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8', timeout: 120_000 }).trim(); }

export function runManifestPath(stateDir, runId) { return join(stateDir, `run-${runId}.json`); }
export function integrationBranch(runId) { return `fix/${runId}/integration`; }
export function integrationWorktree(worktreeRoot, runId) { return join(worktreeRoot, `${runId}-integration`); }

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
function loadRun(stateDir, runId, plan = null) {
  const path = runManifestPath(stateDir, runId);
  const m = readJson(path);
  const chainErrs = verifyEventChain(m);
  if (chainErrs.length) throw new Error(chainErrs[0]);
  if (plan && m.fix_plan_hash !== computeFixPlanHash(plan)) {
    throw new Error('plan 与 run manifest 绑定的 plan hash 不符（SC-R3-2: 编排全程只认 init 时绑定的 canonical plan）');
  }
  return { path, m };
}

// ---- init: 绑定 plan + sc manifest + 源共识（起点由 artifact 派生，不接受 CLI 自报 SC-R3-10） ----
export function initRun({ stateDir, runId, repoDir, plan, scManifest, sourceArtifact, featureBranch }) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(runId))) throw new Error(`runId 非法: ${runId}`);
  const real = computeFixPlanHash(plan);
  if (plan.fix_plan_hash !== real) throw new Error('plan 自身 hash 与内容重算不符（plan 被改）');
  const srcHash = recomputeArtifactHash(sourceArtifact);
  if (sourceArtifact.consensus_artifact_hash !== srcHash) throw new Error('源 consensus artifact hash 与内容重算不符（SC-R3-10）');
  if (plan.consensus_artifact_hash !== srcHash) throw new Error('plan 绑定的 artifact hash ≠ 源 artifact 重算值（plan 不是从这份共识算出来的）');
  const sourceCandidate = sourceArtifact.candidate_sha;
  if (!/^[0-9a-f]{40}$/.test(String(sourceCandidate))) throw new Error('源 artifact 的 candidate_sha 非法（起点由 artifact 派生，SC-R3-10）');
  const path = runManifestPath(stateDir, runId);
  if (existsSync(path)) throw new Error(`run ${runId} 已存在（幂等保护，换 runId 或先 cleanup）`);
  const m = {
    schema_version: 'v2', run_id: runId, repo_dir: repoDir,
    fix_plan_hash: plan.fix_plan_hash,
    sc_manifest_hash: hashObject(scManifest),
    source_artifact_hash: srcHash,
    source_candidate: sourceCandidate,
    feature_branch: featureBranch ?? null,
    integration_branch: integrationBranch(runId),
    waves: [], events: []
  };
  appendEvent(m, { kind: 'run-init', source_candidate: sourceCandidate, source_artifact_hash: srcHash, plan_hash: plan.fix_plan_hash, sc_manifest_hash: m.sc_manifest_hash, waves: plan.waves.length });
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
  const { path, m } = loadRun(stateDir, runId, plan);
  if (m.waves[waveIndex]?.integrated_tip) throw new Error(`wave${waveIndex + 1} 已集成，不可重复 allocate`);
  // R4-P1: replan 状态不可被 allocate 重放清除——否则串行重派可被绕回并行集成（fail-open）。
  // 该状态只能被 serialAllocate/serialIntegrate 消费。
  if (m.waves[waveIndex]?.replan) {
    throw new Error(`wave${waveIndex + 1} 已进入 overlap 串行重派状态，禁止重新 allocate（只能 serial-allocate 消费，R4-P1）`);
  }
  const waveBase = nextWaveBase(m, waveIndex); // ← 权威来源
  const alloc = allocateWave({ repoDir: m.repo_dir, worktreeRoot, runId, plan, waveIndex, waveBase });
  m.waves[waveIndex] = { wave_index: waveIndex, base: waveBase, worktree_root: worktreeRoot, allocations: alloc.allocations, tips: null, integrated_tip: null, replan: null, validation: null };
  appendEvent(m, { kind: 'wave-allocate', wave: waveIndex, base: waveBase, groups: alloc.allocations.map((a) => a.group_id) });
  saveManifest(path, m);
  return { manifest: m, allocations: alloc.allocations, wave_base: waveBase };
}

// ---- tip 归属校验（SC-8 ② + SC-R3-7: allowed ⊆ 对所有组强制，verify 组叠加测试路径） ----
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
    const { errs: pathErrs, changed } = checkGroupChanges({ repoDir, base: waveState.base, tip: head, alloc: a, group: plan.groups.find((g) => g.id === groupId), label: `组 ${groupId}` });
    errs.push(...pathErrs);
    if (!pathErrs.length) tips.push({ group_id: groupId, tip: head, changed });
  }
  return { errs, tips };
}

// SC-R3-7: **所有组**先过 changed ⊆ allowed_paths，verify 组在此之上叠加全测试路径要求
// （v1 的 else-if 让 verify 组完全跳过 allowed 集——R3 实证的旁路）。
function checkGroupChanges({ repoDir, base, tip, alloc, group, label }) {
  const errs = [];
  const changed = changedFiles({ repoDir, base, tip });
  if (changed.length === 0) { errs.push(`${label} 实改为空（空交卷）`); return { errs, changed }; }
  const allowed = new Set(alloc.allowed_paths ?? []);
  for (const f of changed) {
    const r = normalizeRepoPath(f);
    if (!r.ok) { errs.push(`${label} 改了非法路径 ${f}`); continue; }
    if (!allowed.has(f)) errs.push(`${label} 越域改动 ${f}（不在 allowed_paths: ${[...allowed].join(',')}——SC-R3-7 对所有组强制）`);
    if (group?.verify && !isTestPath(f)) errs.push(`verify ${label} 改了非测试文件 ${f}（verify 位不得藏生产改动）`);
  }
  return { errs, changed };
}

// squash: 把 srcTree（某 commit 的树）以单 commit 落在 parent 上（D1: group tips 不进最终祖先）
function squashCommit({ repoDir, treeOf, parent, message }) {
  const tree = git(repoDir, 'rev-parse', `${treeOf}^{tree}`);
  return git(repoDir, 'commit-tree', tree, '-p', parent, '-m', message);
}

// R5-P0/P2: integration worktree 的创建与复用统一走此处——
// 创建即写 owner 印记（run_id + nonce）并**立刻落盘** manifest（crash 窗口内 cleanup 也能凭
// 印记回收）；路径已被占用但无本 run 记录/印记不符 → fail-closed，绝不 checkout 进他人 worktree。
function ensureIntegrationWorktree({ manifestPath, m, ws, runId, checkoutRef }) {
  const rec = m.integration_worktree ?? null; // run 级记录: integration worktree 跨波共享
  // R6-P2: 记录一旦存在，其路径就是唯一权威——后续波换 worktree_root 不得在新路径
  // 分叉出第二个同 nonce worktree（会产生 manifest 记不到、cleanup 收不走的泄漏）
  const wt = rec?.path ?? integrationWorktree(ws.worktree_root, runId);
  const g = (...a) => git(m.repo_dir, ...a);
  if (existsSync(wt)) {
    const o = readOwner({ worktreeDir: wt });
    if (!rec || !o || o.run_id !== runId || o.nonce !== rec.nonce) {
      throw new Error(`integration worktree 路径被占用且 owner 印记不符（记录=${rec?.nonce ? rec.nonce.slice(0, 8) : '无'} 实际=${o?.nonce ? o.nonce.slice(0, 8) : '无'}）——不 checkout 进他人 worktree，fail-closed 人工处理: ${wt}`);
    }
    execFileSync('git', ['-C', wt, 'checkout', '-q', '--detach', checkoutRef], { encoding: 'utf8' });
    return wt;
  }
  g('worktree', 'add', '-q', '--detach', wt, checkoutRef);
  const nonce = rec?.nonce ?? newNonce();
  stampOwner({ worktreeDir: wt, payload: { run_id: runId, kind: 'integration', nonce } });
  if (!rec) {
    m.integration_worktree = { path: wt, nonce };
    appendEvent(m, { kind: 'integration-worktree-created', wave: ws.wave_index, path: wt });
    saveManifest(manifestPath, m); // 创建身份即刻落盘（R5-P2 crash 窗口）
  }
  return wt;
}

// ---- 集成（squash；overlap = fail-closed + 串行重派标记 SC-R3-8/9） ----
export function integrate({ stateDir, runId, plan, waveIndex }) {
  const { path, m } = loadRun(stateDir, runId, plan);
  const ws = m.waves[waveIndex];
  if (!ws) throw new Error(`wave${waveIndex + 1} 未 allocate`);
  if (ws.integrated_tip) return { manifest: m, integrated_tip: ws.integrated_tip, already: true };
  if (ws.replan) {
    return { manifest: m, ok: false, errors: [`wave${waveIndex + 1} 已进入 overlap 串行重派流程，用 serial-allocate / serial-integrate 完成（SC-R3-9: 不得回头并行集成）`] };
  }

  const { errs, tips } = validateTips({ repoDir: m.repo_dir, plan, waveIndex, waveState: ws });
  if (errs.length) {
    appendEvent(m, { kind: 'tips-rejected', wave: waveIndex, errors: errs.slice(0, 5) });
    saveManifest(path, m);
    return { manifest: m, ok: false, errors: errs };
  }

  // 实改交集检测
  const overlaps = [];
  for (let i = 0; i < tips.length; i++) {
    for (let j = i + 1; j < tips.length; j++) {
      const A = new Set(tips[i].changed);
      const inter = tips[j].changed.filter((f) => A.has(f));
      if (inter.length) overlaps.push({ a: tips[i].group_id, b: tips[j].group_id, files: inter });
    }
  }
  if (overlaps.length) {
    // SC-R3-9（D1）: 不 cherry-pick 旧产物冒充重跑——fail-closed，整波转串行重派：
    // 并行产物全部废弃，各组按确定性顺序在**递进的新 base 上重新执行**。
    const order = (plan.waves[waveIndex] ?? []).slice().sort();
    ws.replan = { order, rounds: [] };
    appendEvent(m, { kind: 'overlap-replan-required', wave: waveIndex, overlaps, order });
    saveManifest(path, m);
    return { manifest: m, ok: false, replan_required: true, overlaps, order, errors: [`wave${waveIndex + 1} 实改交集非空——并行产物废弃，转串行重派（serial-allocate 逐组重跑，SC-R3-9）`] };
  }
  ws.tips = tips;

  const g = (...a) => git(m.repo_dir, ...a);
  const wt = ensureIntegrationWorktree({ manifestPath: path, m, ws, runId, checkoutRef: ws.base });
  try {
    const gi = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8', timeout: 120_000 }).trim();
    for (const t of tips) {
      try { gi('merge', '--no-edit', '-q', t.tip); }
      catch (e) {
        try { gi('merge', '--abort'); } catch { /* 无进行中 merge */ }
        appendEvent(m, { kind: 'merge-failed', wave: waveIndex, group: t.group_id, error: e.message });
        saveManifest(path, m);
        return { manifest: m, ok: false, errors: [`merge 组 ${t.group_id} 冲突（无文件重叠仍冲突，fail-closed 交人工）: ${e.message}`] };
      }
    }
    // SC-R3-8: 只有验证过的最终树进历史——merge 中间 commit 不被任何最终 ref 引用
    const msg = `fix-run ${runId} wave${waveIndex + 1} squash\n\n${tips.map((t) => `group ${t.group_id} tip ${t.tip}`).join('\n')}`;
    const squash = squashCommit({ repoDir: wt, treeOf: 'HEAD', parent: ws.base, message: msg });
    gi('checkout', '-q', '--detach', squash);
    g('branch', '-f', m.integration_branch, squash);
    ws.integrated_tip = squash;
    ws.squash_commits = [squash];
    appendEvent(m, { kind: 'wave-integrated', wave: waveIndex, integrated_tip: squash, group_tips: tips.map((t) => ({ group_id: t.group_id, tip: t.tip })) });
    saveManifest(path, m);
    return { manifest: m, ok: true, integrated_tip: squash, overlaps: [] };
  } finally { /* SC-R3-11: 主 repoDir 全程未 checkout，无需还原 */ }
}

// ---- 串行重派: 每轮给一个组开新 worktree（base = 链上最新 tip），worker 真实重跑 ----
export function serialAllocate({ stateDir, runId, plan, waveIndex }) {
  const { path, m } = loadRun(stateDir, runId, plan);
  const ws = m.waves[waveIndex];
  if (!ws?.replan) throw new Error(`wave${waveIndex + 1} 不在串行重派状态（只有 overlap 后才走 serial-*）`);
  const { order, rounds } = ws.replan;
  if (rounds.length >= order.length) throw new Error(`wave${waveIndex + 1} 串行重派已全部完成`);
  const last = rounds[rounds.length - 1];
  if (last && !last.squash) throw new Error(`上一轮（组 ${last.group_id}）尚未 serial-integrate，不能开下一轮`);
  const roundIdx = rounds.length;
  const groupId = order[roundIdx];
  const group = plan.groups.find((x) => x.id === groupId);
  if (!group) throw new Error(`plan 无组 ${groupId}`);
  const base = roundIdx === 0 ? ws.base : rounds[roundIdx - 1].squash;
  const branch = `fix/${runId}/${groupId}-r${roundIdx}`;
  const wtPath = join(ws.worktree_root, `${runId}-${groupId}-r${roundIdx}`);
  if (existsSync(wtPath)) throw new Error(`串行重派 worktree 已存在: ${wtPath}（fail-closed，人工清理）`);
  git(m.repo_dir, 'worktree', 'add', '-q', '-b', branch, wtPath, base);
  const ownerNonce = newNonce();
  stampOwner({ worktreeDir: wtPath, payload: { run_id: runId, group_id: groupId, round: roundIdx, nonce: ownerNonce } });
  const round = { round: roundIdx, group_id: groupId, base, branch, worktree: wtPath, allowed_paths: group.paths, sc_ids: group.sc_ids, owner_nonce: ownerNonce, tip: null, squash: null };
  rounds.push(round);
  appendEvent(m, { kind: 'serial-allocate', wave: waveIndex, round: roundIdx, group: groupId, base });
  saveManifest(path, m);
  return { manifest: m, allocation: round };
}

export function serialIntegrate({ stateDir, runId, plan, waveIndex }) {
  const { path, m } = loadRun(stateDir, runId, plan);
  const ws = m.waves[waveIndex];
  if (!ws?.replan) throw new Error(`wave${waveIndex + 1} 不在串行重派状态`);
  const { order, rounds } = ws.replan;
  const round = rounds[rounds.length - 1];
  if (!round || round.squash) throw new Error('无待集成的串行轮（先 serial-allocate）');
  let head = null;
  try { head = git(m.repo_dir, 'rev-parse', `refs/heads/${round.branch}`); }
  catch { throw new Error(`串行轮分支 ${round.branch} 不存在`); }
  if (head === round.base) return failRound(`组 ${round.group_id} 串行重跑空交卷（tip == base）`);
  if (!isAncestor({ repoDir: m.repo_dir, ancestor: round.base, descendant: head })) {
    return failRound(`组 ${round.group_id} 串行重跑 tip 血统不符（不是本轮 base 的后代）`);
  }
  const group = plan.groups.find((g2) => g2.id === round.group_id);
  const { errs, changed } = checkGroupChanges({ repoDir: m.repo_dir, base: round.base, tip: head, alloc: round, group, label: `串行组 ${round.group_id}` });
  if (errs.length) return failRound(errs.join('; '));

  const msg = `fix-run ${runId} wave${waveIndex + 1} serial round ${round.round} squash\n\ngroup ${round.group_id} tip ${head}`;
  const squash = squashCommit({ repoDir: m.repo_dir, treeOf: head, parent: round.base, message: msg });
  round.tip = head;
  round.changed = changed;
  round.squash = squash;
  git(m.repo_dir, 'branch', '-f', m.integration_branch, squash);
  const done = rounds.length === order.length && rounds.every((r) => r.squash);
  if (done) {
    ws.integrated_tip = squash;
    ws.tips = rounds.map((r) => ({ group_id: r.group_id, tip: r.tip, changed: r.changed }));
    ws.squash_commits = rounds.map((r) => r.squash);
  }
  appendEvent(m, { kind: done ? 'wave-integrated' : 'serial-round-integrated', wave: waveIndex, round: round.round, group: round.group_id, squash, ...(done ? { integrated_tip: squash, group_tips: rounds.map((r) => ({ group_id: r.group_id, tip: r.tip })) } : {}) });
  saveManifest(path, m);
  return { manifest: m, ok: true, round: round.round, squash, wave_done: done, integrated_tip: done ? squash : null };

  function failRound(msg2) {
    appendEvent(m, { kind: 'serial-round-rejected', wave: waveIndex, round: round.round, group: round.group_id, error: msg2 });
    saveManifest(path, m);
    return { manifest: m, ok: false, errors: [msg2] };
  }
}

// ---- SC-R3-4（D2）: verify 结构化 argv——不走 shell、不落原始输出 ----
export function validateVerifyRecipe(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'verify 必须是 {cmd, args[]} 结构化配方（不再接受自由文本，SC-R3-4）';
  if (typeof v.cmd !== 'string' || !v.cmd.trim()) return 'verify.cmd 缺失';
  if (v.cmd.includes('/') || v.cmd.includes('\\') || v.cmd.startsWith('-')) return `verify.cmd 必须是裸程序名（禁路径/前导 -）: ${v.cmd}`;
  if (!Array.isArray(v.args) || v.args.some((a) => typeof a !== 'string')) return 'verify.args 必须是字符串数组';
  return null;
}
export function verifyDigest(v) { return sha256(canonicalJson({ cmd: v.cmd, args: v.args })); }

// ---- SC-10b + SC-R3-3: orchestrator 复跑 SC verify，绑定 sc manifest，空跑不算过 ----
export function validateIntegration({ stateDir, runId, scManifest, waveIndex, runner = null }) {
  const { path, m } = loadRun(stateDir, runId);
  if (hashObject(scManifest) !== m.sc_manifest_hash) {
    throw new Error('sc manifest 与 run 绑定的 sc_manifest_hash 不符（SC-R3-3: 换/改 manifest 造 vacuous PASS 被拦）');
  }
  const ws = m.waves[waveIndex];
  if (!ws?.integrated_tip) throw new Error(`wave${waveIndex + 1} 未集成，无法验证`);
  const scIds = [...new Set((ws.allocations ?? []).flatMap((a) => a.sc_ids))].sort();
  if (scIds.length === 0) throw new Error(`wave${waveIndex + 1} 无 SC 可验（allocation 记录异常，fail-closed）`);
  const byId = new Map((scManifest.scs ?? []).map((s) => [s.id, s]));
  const missing = scIds.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`sc manifest 缺本波 SC: ${missing.join(',')}（SC-R3-3: 本波 SC 集必须 exact 全覆盖）`);

  // 验证在 integration worktree 的 integrated_tip 上跑（owner 印记校验同 integrate）
  const wt = ensureIntegrationWorktree({ manifestPath: path, m, ws, runId, checkoutRef: ws.integrated_tip });

  const results = [];
  for (const id of scIds) {
    const sc = byId.get(id);
    const recipeErr = validateVerifyRecipe(sc.verify);
    if (recipeErr) throw new Error(`SC ${id}: ${recipeErr}`);
    let exitCode = 0, stdout = '';
    try {
      stdout = runner
        ? runner(sc.verify, wt)
        : execFileSync(sc.verify.cmd, sc.verify.args, {
            cwd: wt, encoding: 'utf8', timeout: 600_000, shell: false,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' } // 最小环境: 不透传凭证类变量
          });
    } catch (e) {
      exitCode = Number.isInteger(e.status) ? e.status : 1;
      stdout = String(e.stdout ?? '');
    }
    // 凭证不落库红线: 只存 exit + 摘要 hash，不存原始输出
    results.push({ sc_id: id, status: exitCode === 0 ? 'PASS' : 'FAIL', exit_code: exitCode, verify_digest: verifyDigest(sc.verify), stdout_sha256: sha256(String(stdout)), stdout_bytes: Buffer.byteLength(String(stdout)) });
  }
  const ok = results.every((r) => r.status === 'PASS');
  ws.validation = { at: nowIso(), ok, results };
  appendEvent(m, { kind: 'wave-validated', wave: waveIndex, ok, failed: results.filter((r) => r.status !== 'PASS').map((r) => r.sc_id) });
  saveManifest(path, m);
  return { ok, results, manifest: m };
}

// ---- 收尾: 把 feature branch 前推到最终 integration tip（SC-8 ③） ----
// SC-R3-11 备注: v1 的 branch -f 之所以"能成"，是 integrate 先把主 checkout detach 了
// （R3-P2 实证）。现在主 checkout 零接触，前推分两种：feature branch 正被检出 →
// merge --ff-only（squash 链的 parent 就是旧 tip，天然 fast-forward，工作区同步且 clean）；
// 未检出 → branch -f。工作区不 clean 一律 fail-closed。
export function finalizeRun({ stateDir, runId }) {
  const { path, m } = loadRun(stateDir, runId);
  const last = m.waves[m.waves.length - 1];
  if (!last?.integrated_tip) throw new Error('最后一波尚未集成，不能 finalize');
  for (const [i, w] of m.waves.entries()) {
    if (!w.validation?.ok) throw new Error(`wave${i + 1} 未通过 orchestrator 复跑验证（fail-closed）`);
  }
  if (m.feature_branch) {
    let currentBranch = null;
    try { currentBranch = git(m.repo_dir, 'symbolic-ref', '--short', 'HEAD'); } catch { /* detached */ }
    if (currentBranch === m.feature_branch) {
      if (git(m.repo_dir, 'status', '--porcelain') !== '') {
        throw new Error('feature branch 检出处工作区不 clean，拒绝前推（fail-closed）');
      }
      git(m.repo_dir, 'merge', '--ff-only', last.integrated_tip); // 分叉即失败，天然 CAS
    } else {
      // R5-P1: update-ref 会绕过 git 的「检出中分支不可强推」保护——feature branch 若在
      // 任何其他 worktree 检出，移动 ref 会把那个 worktree 的基线静默污染。先查后动。
      const wtList = git(m.repo_dir, 'worktree', 'list', '--porcelain');
      if (wtList.split('\n').includes(`branch refs/heads/${m.feature_branch}`)) {
        throw new Error(`feature branch ${m.feature_branch} 正被某个 worktree 检出——update-ref 会绕过 git 检出保护污染其工作区，拒绝前推（到该 worktree 里用 merge --ff-only，或先取消检出——R5-P1）`);
      }
      // R4-P1: branch -f 会静默覆盖并发提交——改 update-ref CAS，旧值必须仍是 run 起点
      // （run 期间 feature branch 被外部推进 = 出现未审内容，fail-closed 交人工 replan）
      try {
        git(m.repo_dir, 'update-ref', `refs/heads/${m.feature_branch}`, last.integrated_tip, m.source_candidate);
      } catch (e) {
        throw new Error(`feature branch 前推 CAS 失败: refs/heads/${m.feature_branch} 已不在 run 起点 ${m.source_candidate.slice(0, 12)}（并发提交会被 branch -f 静默覆盖，拒绝——R4-P1）: ${e.message}`);
      }
    }
  }
  m.final_candidate = last.integrated_tip;
  appendEvent(m, { kind: 'run-finalized', final_candidate: last.integrated_tip, feature_branch: m.feature_branch ?? null });
  saveManifest(path, m);
  return { final_candidate: last.integrated_tip, manifest: m };
}

// 本 run 记录过的全部 squash commit（push-guard 的 lineage 精确集合，SC-R3-8）
export function recordedSquashes(m) {
  const set = new Set();
  for (const w of m.waves ?? []) {
    for (const s of w.squash_commits ?? []) set.add(s);
    for (const r of w.replan?.rounds ?? []) if (r.squash) set.add(r.squash);
    if (w.integrated_tip) set.add(w.integrated_tip);
  }
  return set;
}

// SC-9 用: run manifest 的权威 hash（纳入 fix_orchestration）——
// SC-R3-3: validation 明细（sc_id/exit/verify digest）入锅，事后换 sc manifest/结果即失效
export function runManifestHash(m) {
  return sha256(canonicalJson({
    v: 'fix-run/v2', run_id: m.run_id, fix_plan_hash: m.fix_plan_hash,
    sc_manifest_hash: m.sc_manifest_hash, source_artifact_hash: m.source_artifact_hash,
    source_candidate: m.source_candidate, final_candidate: m.final_candidate ?? null,
    waves: (m.waves ?? []).map((w) => ({
      base: w.base,
      tips: (w.tips ?? []).map((t) => ({ g: t.group_id, tip: t.tip })),
      integrated_tip: w.integrated_tip,
      squashes: w.squash_commits ?? [],
      rounds: (w.replan?.rounds ?? []).map((r) => ({ g: r.group_id, base: r.base, tip: r.tip, squash: r.squash })),
      validation: w.validation ? { ok: !!w.validation.ok, results: (w.validation.results ?? []).map((r) => ({ sc_id: r.sc_id, status: r.status, exit_code: r.exit_code, verify_digest: r.verify_digest })) } : null
    }))
  }));
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const mode = args._[0];
  const need = (ks) => { for (const k of ks) if (!args[k]) fail(`缺参数 --${k}`); };
  try {
    if (mode === 'init') {
      need(['state-dir', 'run-id', 'repo-dir', 'plan', 'sc-manifest', 'source-artifact']);
      const m = initRun({ stateDir: args['state-dir'], runId: args['run-id'], repoDir: args['repo-dir'], plan: readJson(args.plan), scManifest: readJson(args['sc-manifest']), sourceArtifact: readJson(args['source-artifact']), featureBranch: args['feature-branch'] });
      process.stdout.write(JSON.stringify({ ok: true, run_id: m.run_id, source_candidate: m.source_candidate }) + '\n');
    } else if (mode === 'allocate') {
      need(['state-dir', 'run-id', 'plan', 'wave', 'worktree-root']);
      const r = allocate({ stateDir: args['state-dir'], runId: args['run-id'], plan: readJson(args.plan), waveIndex: Number(args.wave), worktreeRoot: args['worktree-root'] });
      process.stdout.write(JSON.stringify({ ok: true, wave_base: r.wave_base, allocations: r.allocations }, null, 2) + '\n');
    } else if (mode === 'integrate') {
      need(['state-dir', 'run-id', 'plan', 'wave']);
      const r = integrate({ stateDir: args['state-dir'], runId: args['run-id'], plan: readJson(args.plan), waveIndex: Number(args.wave) });
      process.stdout.write(JSON.stringify(r.ok ? { ok: true, integrated_tip: r.integrated_tip } : { ok: false, replan_required: r.replan_required ?? false, errors: r.errors }, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    } else if (mode === 'serial-allocate') {
      need(['state-dir', 'run-id', 'plan', 'wave']);
      const r = serialAllocate({ stateDir: args['state-dir'], runId: args['run-id'], plan: readJson(args.plan), waveIndex: Number(args.wave) });
      process.stdout.write(JSON.stringify({ ok: true, allocation: r.allocation }, null, 2) + '\n');
    } else if (mode === 'serial-integrate') {
      need(['state-dir', 'run-id', 'plan', 'wave']);
      const r = serialIntegrate({ stateDir: args['state-dir'], runId: args['run-id'], plan: readJson(args.plan), waveIndex: Number(args.wave) });
      process.stdout.write(JSON.stringify(r.ok ? { ok: true, round: r.round, squash: r.squash, wave_done: r.wave_done, integrated_tip: r.integrated_tip } : { ok: false, errors: r.errors }, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    } else if (mode === 'validate') {
      need(['state-dir', 'run-id', 'sc-manifest', 'wave']);
      const r = validateIntegration({ stateDir: args['state-dir'], runId: args['run-id'], scManifest: readJson(args['sc-manifest']), waveIndex: Number(args.wave) });
      process.stdout.write(JSON.stringify({ ok: r.ok, results: r.results }, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    } else if (mode === 'finalize') {
      need(['state-dir', 'run-id']);
      const r = finalizeRun({ stateDir: args['state-dir'], runId: args['run-id'] });
      process.stdout.write(JSON.stringify({ ok: true, final_candidate: r.final_candidate, run_manifest_hash: runManifestHash(r.manifest) }) + '\n');
    } else if (mode === 'cleanup') {
      // SC-R3-1: 回收对象只从 run manifest 枚举，caller 不再传 worktree-root/plan
      need(['state-dir', 'run-id']);
      const m = readJson(runManifestPath(args['state-dir'], args['run-id']));
      const r = cleanupRun({ manifest: m });
      process.stdout.write(JSON.stringify(r) + '\n');
    } else {
      fail('用法: fix-run.mjs <init|allocate|integrate|serial-allocate|serial-integrate|validate|finalize|cleanup> ...\n（有状态编排器: base 由 run manifest CAS 派生；cleanup 只认 manifest 记录的 allocation——SC-8/SC-R3-1）');
    }
  } catch (e) {
    process.stderr.write(`[FIX-RUN] ${e.message}\n`);
    process.exit(1);
  }
}
