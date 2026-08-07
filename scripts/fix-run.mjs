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
import { existsSync, writeFileSync, renameSync, mkdirSync, symlinkSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { readJson, parseArgs, fail, isMain, nowIso, sha256, canonicalJson, normalizeRepoPath, hashObject } from './lib/common.mjs';
import { computeFixPlanHash } from './fix-plan.mjs';
import { recomputeArtifactHash, assertArtifactShape } from './consensus-gate.mjs';
import { allocateWave, changedFiles, isAncestor, cleanupRun, stampOwner, readOwner, newNonce, writePathsFor } from './fix-orchestrate.mjs';

const TEST_PATH_RE = /(^|\/)(e2e|fixtures)\//;
const TEST_FILE_RE = /\.(test|spec)\.[A-Za-z0-9]+$/;
const isTestPath = (p) => TEST_PATH_RE.test(p) || TEST_FILE_RE.test(p);

function git(repoDir, ...a) { return execFileSync('git', ['-C', repoDir, ...a], { encoding: 'utf8', timeout: 120_000 }).trim(); }

// R4 归一（lead 2026-08-07）：run manifest 的 schema 版本此前是散字面量（构造 'v3' +
// runManifestHash 的 'fix-run/v3' tag + batch-closure-gate 校验 'v3'）——同类「纯值散字面量」
// 漂移点（与 artifact schema 版本号散在实现里同一形状）。改为单一导出常量，各处引用。
// 注意：这是 **run manifest 自己的 schema 版本**，与 consensus-artifact.schema.json 的
// schema_version（ARTIFACT_SCHEMA_VERSION）是两套独立版本线——前者无独立 schema 文件，
// 后者从 schema 派生。此处导出让实现内不再手写字面量。
export const RUN_MANIFEST_SCHEMA_VERSION = 'v3';

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
// i9-batch: 可选 batch 参数 { batch_id, frozen_families }——批次事务协议（issue #9 SC 延伸）。
// 批次开始即冻结待处置 family 集：frozen_at_sha 强制 = source_candidate（CAS 派生，不接受自报，
// 与 SC-R3-10 同一原则）；frozen_families 每项必须匹配 fk1- 派生 key 且**必须存在于源共识的
// canonical_findings**（冻结集只能来自这份审查产物，编造/照抄他批 family 即拒，fail-closed）。
export function initRun({ stateDir, runId, repoDir, plan, scManifest, sourceArtifact, featureBranch, batch }) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(runId))) throw new Error(`runId 非法: ${runId}`);
  if (batch !== undefined) {
    if (!batch || typeof batch !== 'object') throw new Error('batch 参数非法: 必须为对象 { batch_id, frozen_families }（fail-closed）');
    if (!/^[A-Za-z0-9._-]+$/.test(String(batch.batch_id ?? ''))) throw new Error(`batch_id 非法: ${batch.batch_id}`);
    if (!Array.isArray(batch.frozen_families) || batch.frozen_families.length === 0) {
      throw new Error('batch.frozen_families 必须是非空数组（批次冻结集为空 = 没有待处置义务，语义不成立，fail-closed）');
    }
    for (const fk of batch.frozen_families) {
      if (typeof fk !== 'string' || !/^fk1-[0-9a-f]{64}$/.test(fk)) {
        throw new Error(`batch.frozen_families 含非法 family_key: ${JSON.stringify(fk)}（必须是 fk1- 派生的 64-hex key，i9-batch）`);
      }
    }
    const canonKeys = new Set((sourceArtifact?.canonical_findings ?? []).map((c) => c.family_key).filter(Boolean));
    for (const fk of batch.frozen_families) {
      if (!canonKeys.has(fk)) {
        throw new Error(`batch.frozen_families 含不在源共识 canonical_findings 中的 family_key: ${fk.slice(0, 12)}…（冻结集只能从源共识派生，fail-closed，i9-batch）`);
      }
    }
  }
  const real = computeFixPlanHash(plan);
  if (plan.fix_plan_hash !== real) throw new Error('plan 自身 hash 与内容重算不符（plan 被改）');
  // issue #9 R2 blocker: 结构门先于 hash 自洽——sourceArtifact 的 schema_version/round 非法
  // 时必须 throw 出结构问题本身，不能被"hash 恰好被攻击者重算到自洽"掩盖（hash 自洽挡不住
  // 确定性重算攻击，见 consensus-gate.mjs 的 assertArtifactShape 注释）。
  const shapeErrs = assertArtifactShape(sourceArtifact, '源 consensus artifact');
  if (shapeErrs.length) throw new Error(shapeErrs[0]);
  const srcHash = recomputeArtifactHash(sourceArtifact);
  if (sourceArtifact.consensus_artifact_hash !== srcHash) throw new Error('源 consensus artifact hash 与内容重算不符（SC-R3-10）');
  // issue #9 SC-A2: 源 artifact 必须是 PASS 共识——此前只验 hash 自洽，一份手工拼的
  // fail artifact（hash 自洽但 gate_result=fail）能原样启动一次修复 run。
  if (sourceArtifact.gate_result !== 'pass') throw new Error(`源 consensus artifact gate_result=${sourceArtifact.gate_result} ≠ pass（issue #9 SC-A: initRun 只接受 PASS 共识作源）`);
  if (plan.consensus_artifact_hash !== srcHash) throw new Error('plan 绑定的 artifact hash ≠ 源 artifact 重算值（plan 不是从这份共识算出来的）');
  const sourceCandidate = sourceArtifact.candidate_sha;
  if (!/^[0-9a-f]{40}$/.test(String(sourceCandidate))) throw new Error('源 artifact 的 candidate_sha 非法（起点由 artifact 派生，SC-R3-10）');
  const path = runManifestPath(stateDir, runId);
  if (existsSync(path)) throw new Error(`run ${runId} 已存在（幂等保护，换 runId 或先 cleanup）`);
  const m = {
    schema_version: RUN_MANIFEST_SCHEMA_VERSION, run_id: runId, repo_dir: repoDir,
    fix_plan_hash: plan.fix_plan_hash,
    sc_manifest_hash: hashObject(scManifest),
    source_artifact_hash: srcHash,
    source_candidate: sourceCandidate,
    feature_branch: featureBranch ?? null,
    integration_branch: integrationBranch(runId),
    waves: [], events: []
  };
  // i9-batch: 批次段——frozen_at_sha 派生不自报；successor_sha/status 在 finalizeRun 收口时写入。
  if (batch !== undefined) {
    m.batch = {
      batch_id: batch.batch_id,
      frozen_at_sha: sourceCandidate,
      frozen_families: [...new Set(batch.frozen_families)].sort(), // 确定性: 去重 + 排序，hash 稳定
      successor_sha: null,
      status: 'open'
    };
  }
  appendEvent(m, { kind: 'run-init', source_candidate: sourceCandidate, source_artifact_hash: srcHash, plan_hash: plan.fix_plan_hash, sc_manifest_hash: m.sc_manifest_hash, waves: plan.waves.length, ...(m.batch ? { batch_id: m.batch.batch_id, frozen_families: m.batch.frozen_families.length } : {}) });
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

// D3（gpt 终审阻断修复）: artifact/scManifest 改**必填**——旧版允许不传、静默产出
// family_context=null，「强制覆盖全部路径」这件事因此可以静默退化成部分覆盖，且对真旧版
// manifest（未升级到 family_key 数据契约）不做静默兼容，两个入口（本函数 + fix-orchestrate.mjs
// 的 allocateWave/familyContext）同等 fail-closed，不留 legacy 通道（hardening-checklist 第
// 5 类）。传入后必须与本 run init 时绑定的 hash 一致（fail-closed，防误传不相关的
// artifact/manifest——字段错配，不是恶意场景的专用措辞，D5），不一致直接抛错，不静默降级
// 为「没有 family_context」（那会把「输入错」伪装成「无 family」）。
export function allocate({ stateDir, runId, plan, waveIndex, worktreeRoot, artifact, scManifest }) {
  const { path, m } = loadRun(stateDir, runId, plan);
  if (m.waves[waveIndex]?.integrated_tip) throw new Error(`wave${waveIndex + 1} 已集成，不可重复 allocate`);
  // R4-P1: replan 状态不可被 allocate 重放清除——否则串行重派可被绕回并行集成（fail-open）。
  // 该状态只能被 serialAllocate/serialIntegrate 消费。
  if (m.waves[waveIndex]?.replan) {
    throw new Error(`wave${waveIndex + 1} 已进入 overlap 串行重派状态，禁止重新 allocate（只能 serial-allocate 消费，R4-P1）`);
  }
  if (!artifact) throw new Error('allocate 缺 artifact（D3 必填：family_context 强制覆盖全部路径，不传会静默退化，两个入口同等 fail-closed）');
  if (!scManifest) throw new Error('allocate 缺 scManifest（D3 必填，同上）');
  if (recomputeArtifactHash(artifact) !== m.source_artifact_hash) {
    throw new Error('allocate 传入的 artifact 与本 run 绑定的 source_artifact_hash 不符（字段错配：family_context 输入必须是同一份源共识，fail-closed）');
  }
  if (hashObject(scManifest) !== m.sc_manifest_hash) {
    throw new Error('allocate 传入的 scManifest 与本 run 绑定的 sc_manifest_hash 不符（字段错配：family_context 输入必须是同一份 sc manifest，fail-closed）');
  }
  const waveBase = nextWaveBase(m, waveIndex); // ← 权威来源
  const alloc = allocateWave({ repoDir: m.repo_dir, worktreeRoot, runId, plan, waveIndex, waveBase, artifact, scManifest });
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

// anchor_paths 拆分（2026-08-02）: 写入许可读 alloc.write_paths（脚本按 SC kind 推导，
// 不再是 anchor 并集本身——见 fix-orchestrate.mjs 的 writePathsFor 注释）。
//   mode='anchor-test-path'（verify 类，SC-R3-7 加固不变）: changed ⊆ write_paths.paths，
//     且叠加全测试路径要求（v1 的 else-if 让 verify 组完全跳过 allowed 集——R3 实证的旁路）。
//   mode='fixed-list'（archive 类，SC-M2）: changed ⊆ write_paths.paths（脚本给定常量
//     ARCHIVE_PATH，全链唯一诚实拥有正向写入清单的场景）——不叠加测试路径要求，archive
//     改的是残余风险登记文档，不是测试文件。
//   mode='isolated'（fix 类）: 不设清单——不得因「改动不在证据锚点内」被拒（anchor 是证据
//     不是写集）；写入边界只靠独立 worktree + 集成期真实 diff 重叠检测兜底（本函数之外，
//     integrate() 无条件执行）。
// write_paths 缺失/mode 非法 = 内部编排 bug（本函数从不接受外部输入），throw 而非静默兜底，
// 避免 fail-closed 默认值掩盖故障（见加固清单「fail-closed 默认值降低可观测性」）。
// 加固清单第 5/6 类: 白名单放行 mode ≠ 约束生效——下方 allowed 判定必须覆盖每个新 mode，
// 光加进 includes() 而不接进约束分支等于放开了口子（本次 SC-M 系列专门补的洞）。
function checkGroupChanges({ repoDir, base, tip, alloc, group, label }) {
  const errs = [];
  const changed = changedFiles({ repoDir, base, tip });
  if (changed.length === 0) { errs.push(`${label} 实改为空（空交卷）`); return { errs, changed }; }
  const wp = alloc.write_paths;
  if (!wp || !['isolated', 'anchor-test-path', 'fixed-list'].includes(wp.mode)) {
    throw new Error(`${label} 的 allocation 缺 write_paths 或 mode 非法（${JSON.stringify(wp)}）——内部编排 bug，fail-closed`);
  }
  const allowed = wp.mode === 'isolated' ? null : new Set(wp.paths ?? []);
  for (const f of changed) {
    const r = normalizeRepoPath(f);
    if (!r.ok) { errs.push(`${label} 改了非法路径 ${f}`); continue; }
    if (allowed && !allowed.has(f)) errs.push(`${label} 越域改动 ${f}（不在 write_paths: ${[...allowed].join(',')}——mode=${wp.mode} 强制）`);
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
  const round = { round: roundIdx, group_id: groupId, base, branch, worktree: wtPath, anchor_paths: group.paths, write_paths: writePathsFor(group), sc_ids: group.sc_ids, owner_nonce: ownerNonce, tip: null, squash: null };
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

// ---- D8（owner 2026-08-03 授权）: 选中数闸门——「PASS」必须建立在真的跑了用例之上 ----
// 根因: vitest 对 `-t <无匹配>` 的处理是 **skip 全部用例并 exit 0**（`--passWithNoTests` 只
// 管文件级无匹配，不管 `-t` 级）。于是一条选不中任何用例的 verify 在本函数里记 PASS、
// 有唯一 verify_digest、stdout 非空，看起来样样齐全，却对该 SC 的交付物零约束。
// 这一族在 bug-doctor 批次1 上连吃四轮，每轮的判据都被下一轮推翻:
//   R2→R3  「digest 互不相同 ⇒ 无假覆盖」 → 反例: 6 条 SC 共用一条 verify 之外，还有
//            digest 唯一但选中 0 的（SC-BD1-R2-N05 把文件写成 state.test.mjs，用例实际在
//            gate.test.mjs）。**唯一 ≠ 非空**
//   R3→R4  「选中数 > 0」（人工逐条实测） → 反例: SC-BD1-R4-N10 的 `-t 已知局限` 选中 2 条，
//            但那 2 条是上一轮 D01 的锚点断言。**非空 ≠ 相关**
//   R4→R5  「本轮 SC id 各自在场」（硬编码快照） → 该断言本身 fail-open（未登记的 SC 不被守）
// 本闸门只关掉**可机器判定**的那一半（非空）；「相关」由 manifest 侧的约定保证
// （过滤词 = 该 SC 自己的 id + 测试 describe 标题带该 id），二者合起来才等于「verify 选中的
// 是因该 SC 的实现而存在的用例」。
//
// **为什么不做「verify 在 base 上必红」**（初版设想，实测不可行）: 它与上面那条 id 约定互斥——
// 过滤词是本 SC 自己的 id 时，base 上该 describe 还不存在 → 选中 0 → exit 0 → base 是绿的，
// 于是每条新增测试类 SC 都会被误判。base-red 只在「测试先于实现存在」（TDD 型）或整文件 verify
// 下成立，不能作为通用闸门。**撤实现必红仍是真属性，但它留在交卷义务里，不在本闸门内。**
//
// 覆盖边界（如实声明，T1 级——防疏忽/漂移，不防刻意规避）:
//   · 只覆盖**已识别的 vitest recipe**（cmd ∈ node 工具链且 args 出现 'vitest'）。
//   · 其他 runner（含 `node -e "..."`、`test -f x` 这类自包含 recipe，坑④ 明确它们合法）
//     无通用的「选中数」概念，记 selection_gate='unmeasured' + note，**不阻断**。
//     换 runner 即可绕过本闸门——这是已知且如实登记的洞，不冒称覆盖全部。
//   · recipe 自带 --reporter/--outputFile 时无法叠加 json reporter 取数 → **阻断**
//     （不允许用自定义 reporter 把闸门关掉）。
const VITEST_REPORTER_FLAG_RE = /^--(reporter|outputFile)/;
export function vitestSelectionApplies(v) {
  if (!DEP_TOOLCHAIN_CMDS.has(v.cmd)) return { applies: false, reason: `cmd="${v.cmd}" 不是已识别的 node 工具链` };
  if (!v.args.includes('vitest')) return { applies: false, reason: "args 未出现 'vitest'" };
  const conflict = v.args.find((a) => VITEST_REPORTER_FLAG_RE.test(String(a)));
  if (conflict) return { applies: true, blocked: true, reason: `recipe 自带 ${conflict}，无法叠加 json reporter 取选中数（fail-closed: 不允许用自定义 reporter 绕过选中数闸门）` };
  return { applies: true, blocked: false };
}
// 选中数 = passed + failed。vitest 的 json reporter 把「被 -t 过滤掉的」记为 pending，
// 所以 pending 不计入选中——`it.skip` 同样落 pending，也确实不该算「跑过了」。
// 返回 null = 测不出来（json 文件没产出/解析不了/字段缺失），调用方按 fail-closed 处理。
export function readVitestSelection(jsonText) {
  let r;
  try { r = JSON.parse(jsonText); } catch { return null; }
  const p = r?.numPassedTests, f = r?.numFailedTests;
  if (!Number.isInteger(p) || !Number.isInteger(f)) return null;
  return p + f;
}

// ---- D7: 依赖准备 + fail-closed 分支 ----
// 根因（另一会话实测，2026-08-02）: ensureIntegrationWorktree 只做 `git worktree add --detach`，
// 裸 checkout 没有 node_modules——依赖项目依赖的 verify recipe（如 `npx vitest`）会立刻
// exit!=0 且 stdout 为空，SC-10「orchestrator 不信 worker 自报」这道门因此在任何带依赖的
// 项目上全数假阳，训练调用方忽略它（比没有门更糟）。
// 主仓存在 node_modules 且 worktree 内没有 → 软链（成本近零，依赖不是被审代码，不违背
// 隔离初衷）。**fail-closed 分支（必须有，否则产出静默错误结果）**: 软链主仓依赖等于
// 用主仓依赖集跑候选代码——若候选累计 diff 改了依赖清单，链过来的 node_modules 与候选
// 不一致，测试可能通过但通过的是错的依赖状态，比响亮失败更危险。此时不建软链，直接把
// 整波（同一 worktree/环境）判 UNRUNNABLE，原因点名具体哪个清单文件。
// 不实现 npm ci（新增机制确认门）：本轮目标是让门可用，自动安装要处理网络/超时策略，
// 留给下一轮；本轮 fail-closed 报出来即可，不静默、不硬撑。
// 坑④: 主仓本就没有 node_modules 不是错误——自包含 verify recipe（纯 node/bash，不依赖
// 项目依赖）合法存在，此时 no-op，不报错、不阻断。
// 「recipe 依赖 node 工具链」的确定性判据：cmd 是 npx/npm/yarn/pnpm 之一（这几个命令的存在
// 意义就是解析/调用项目依赖里的东西，不可能在没有 node_modules 时正常工作）——这不是启发式，
// 是对这四个命令语义的确定性事实。裸 `node` 不算（可能是自包含的 `node -e "..."`）。
const DEP_MANIFEST_BASENAMES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
export const DEP_TOOLCHAIN_CMDS = new Set(['npx', 'npm', 'yarn', 'pnpm']);
export function prepareDependencies({ repoDir, wt, sourceCandidate, integratedTip }) {
  const repoModules = join(repoDir, 'node_modules');
  if (!existsSync(repoModules)) return { unrunnable: false, linked: false }; // 坑④: 主仓也没有 = 合法态
  // R2-F2（gpt 复审 finding 2，P1）: 依赖清单 diff 必须**先于**「worktree 已有 node_modules」
  // 的早返回。旧顺序是先看 wtModules 存在就直接返回 runnable，而 integration worktree 是
  // **run 级跨波复用**（见 ensureIntegrationWorktree，注释原话「run 级记录: integration
  // worktree 跨波共享」），波间只做 `git checkout --detach`——**不清 untracked**，所以 wave 1
  // 建的软链原地活到 wave 2。于是 wave 2 即便改了 package.json 也撞第一行早返回，永远走不到
  // 下面的清单检查，被归成 runnable，然后在**旧依赖**下跑出 PASS。
  // 阻断谓词本身是对的（validate 用 every(status==='PASS')，UNRUNNABLE 令 ok=false；
  // finalizeRun 拒 validation.ok !== true）——出问题的是它的**分类前提**被短路了。
  // gpt 实测探针（已有软链 + source..tip 改 package.json）拿到 {unrunnable:false,linked:false}。
  let changed;
  try {
    changed = changedFiles({ repoDir, base: sourceCandidate, tip: integratedTip });
  } catch (e) {
    // 算不出实改集就不敢判「依赖没变」——抛错归 UNRUNNABLE，不是归 runnable（fail-closed）
    return {
      unrunnable: true, linked: false,
      reason: `无法计算 ${sourceCandidate?.slice?.(0, 8) ?? '?'}..${integratedTip?.slice?.(0, 8) ?? '?'} 的实改集，无法判断依赖清单是否变化（fail-closed）: ${e.message}`
    };
  }
  const touched = changed.find((f) => DEP_MANIFEST_BASENAMES.has(basename(f)));
  const wtModules = join(wt, 'node_modules');
  if (touched) {
    // changedFiles 取的是 source_candidate..本波 tip 的**树差**（不是逐波增量）：只要依赖清单
    // 相对 source 的差异**仍然存在**，后续每一波都还会看到它，持续判 UNRUNNABLE。
    //
    // 这里**不删**任何已有的 node_modules。初版注释把理由写成「某波改过清单后后续每波都还
    // 带着它，所以永远不会放行」——那是**全称句，不成立**：gpt 终审构造了「后续波把
    // package.json 内容恢复到与 source 相同」的对照组，实测 beforeRevert=["other.txt",
    // "package.json"]、afterRevert=["other.txt"]，清单差异确实会消失。
    // 但**决定仍然正确，安全性由另一条机制兜住**：恢复后候选依赖重新等于 source，那条旧软链
    // 已经不 stale（用它跑是对的）；而先前那一波留下的 `validation.ok=false` 不会被后续波抹掉，
    // `finalizeRun` 逐波检查、任一波不过即拒。所以「阻断」不是靠 diff 一直带着清单来维持的，
    // 是靠**已落盘的逐波验证结果**维持的。
    // 至于为什么不删：既然已阻断，删了不多买一分安全，而误删一份真实安装的依赖不可逆。
    // 只把「有残留软链」如实写进 reason。
    const stale = existsSync(wtModules) ? '（integration worktree 内已有前一波留下的 node_modules 残留，未删除）' : '';
    return {
      unrunnable: true, linked: false,
      reason: `候选改动了依赖清单 ${touched}，链入主仓的 node_modules 与候选不一致（fail-closed，未尝试软链）${stale}——需真实安装依赖后重跑，本轮不自动 npm ci（新增机制确认门，留给下一轮）`
    };
  }
  if (existsSync(wtModules)) return { unrunnable: false, linked: false }; // 依赖清单未变，前一波的软链仍然有效
  symlinkSync(repoModules, wtModules, 'dir');
  return { unrunnable: false, linked: true };
}

// ---- SC-10b + SC-R3-3: orchestrator 复跑 SC verify，绑定 sc manifest，空跑不算过 ----
// D8: 选中数探针——单独跑一次同 recipe + json reporter，只取计数。
// 刻意与主记录**分离两次运行**：主记录的 exit/stdout_sha256/stdout_bytes 语义因此逐字不变，
// 不因引入本闸门而改写既有证据形状（json reporter 会让 stdout 变成 JSON，若合并成一次跑
// 会把 stdout_bytes 的含义悄悄换掉）。代价是带过滤词的 verify 多跑一次（收集期为主，秒级）。
export function probeVitestSelection({ verify, wt }) {
  const dir = mkdtempSync(join(tmpdir(), 'sel-'));
  const out = join(dir, 'sel.json');
  try {
    const args = [...verify.args, '--reporter=json', `--outputFile=${out}`];
    try {
      execFileSync(verify.cmd, args, {
        cwd: wt, encoding: 'utf8', timeout: 600_000, shell: false,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' }
      });
    } catch { /* 探针本身的退出码不作判据: 主记录已经判过成败，这里只要那份 json */ }
    if (!existsSync(out)) return null;
    return readVitestSelection(readFileSync(out, 'utf8'));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  }
}

export function validateIntegration({ stateDir, runId, scManifest, waveIndex, runner = null, selectionProbe = null }) {
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

  // D7: 依赖准备——整波共用同一个 worktree/环境，判定一次即可
  const depPrep = prepareDependencies({ repoDir: m.repo_dir, wt, sourceCandidate: m.source_candidate, integratedTip: ws.integrated_tip });
  const wtHasModules = existsSync(join(wt, 'node_modules'));

  const results = [];
  for (const id of scIds) {
    const sc = byId.get(id);
    const recipeErr = validateVerifyRecipe(sc.verify);
    if (recipeErr) throw new Error(`SC ${id}: ${recipeErr}`);
    if (depPrep.unrunnable) {
      // D7 确定性分类①: 已知我们主动跳过了依赖准备（候选改了依赖清单），不是猜的。
      // UNRUNNABLE 与 FAIL 分开报但同等阻断（下方 ok 判定对两者一视同仁，不得把
      // UNRUNNABLE 排除在 every(PASS) 之外）。
      results.push({ sc_id: id, status: 'UNRUNNABLE', exit_code: null, verify_digest: verifyDigest(sc.verify), stdout_sha256: sha256(''), stdout_bytes: 0, note: depPrep.reason });
      continue;
    }
    if (DEP_TOOLCHAIN_CMDS.has(sc.verify.cmd) && !wtHasModules) {
      // D7 确定性分类②: recipe 明确要用 npx/npm/yarn/pnpm，但 worktree 里确实没有
      // node_modules（无论是主仓也没有、还是软链已尝试但仍不存在）——这是对命令语义的
      // 确定性判断，不是「exit!=0 且 stdout 空」那种启发式猜测。
      results.push({ sc_id: id, status: 'UNRUNNABLE', exit_code: null, verify_digest: verifyDigest(sc.verify), stdout_sha256: sha256(''), stdout_bytes: 0, note: `verify.cmd="${sc.verify.cmd}" 依赖 node 工具链，但 worktree 无 node_modules（主仓亦无可链入的依赖）——未尝试执行，避免落一个无意义的原生报错` });
      continue;
    }
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
    const status = exitCode === 0 ? 'PASS' : 'FAIL';
    const entry = { sc_id: id, status, exit_code: exitCode, verify_digest: verifyDigest(sc.verify), stdout_sha256: sha256(String(stdout)), stdout_bytes: Buffer.byteLength(String(stdout)) };
    // D7: exit≠0 且 stdout 为空只是**提示**，不是判据——真实测试失败也可能 stdout 为空
    // （有些 runner 只写 stderr），不得据此改判 UNRUNNABLE，只在 note 里给排查方向。
    if (status === 'FAIL' && entry.stdout_bytes === 0) {
      entry.note = '退出非零且 stdout 为空——疑似环境问题（如 worktree 缺 node_modules、命令找不到），也可能是真实测试失败但输出全落在 stderr；请先查 worktree 运行环境再确认是否为真实失败';
    }
    // D8 选中数闸门: 只在「主记录判 PASS」时才有意义——FAIL/UNRUNNABLE 已经阻断了，
    // 再测选中数不改变结论、白花一次运行。
    if (entry.status === 'PASS') {
      const sel = vitestSelectionApplies(sc.verify);
      if (!sel.applies) {
        entry.selected_tests = null;
        entry.selection_gate = 'unmeasured';
        // 刻意**不**写进 note: D7-③ 的既有契约是「正常 PASS 不带诊断 note」，note 专供
        // 需要人去排查的异常。本条是闸门自身的覆盖边界声明，属常态，走独立字段。
        entry.selection_reason = `${sel.reason}。如实声明: 本闸门只覆盖已识别的 vitest recipe，其他 runner 的空验证不被检测（T1，换 runner 即可绕过）`;
      } else if (sel.blocked) {
        entry.status = 'UNRUNNABLE';
        entry.selected_tests = null;
        entry.selection_gate = 'blocked';
        entry.note = [entry.note, `D8 选中数闸门 fail-closed: ${sel.reason}`].filter(Boolean).join(' | ');
      } else {
        const selected = selectionProbe ? selectionProbe(sc.verify, wt) : probeVitestSelection({ verify: sc.verify, wt });
        entry.selected_tests = selected;
        if (selected === null) {
          entry.status = 'UNRUNNABLE';
          entry.selection_gate = 'unmeasurable';
          entry.note = [entry.note, 'D8 选中数闸门 fail-closed: 探针未能产出/解析 vitest json 报告，无法确认本条 verify 真的跑了用例——不允许在测不出选中数时记 PASS'].filter(Boolean).join(' | ');
        } else if (selected === 0) {
          entry.status = 'VACUOUS';
          entry.selection_gate = 'fail';
          entry.note = [entry.note, 'D8 选中数闸门: 本条 verify 选中 0 个用例却 exit 0（vitest 对 -t 无匹配即 skip 全部并 exit 0）——它对该 SC 的交付物零约束，不得记 PASS。请把过滤词改成能选中本 SC 自己用例的值（约定: 过滤词 = 该 SC 的 id，且测试 describe 标题带该 id）'].filter(Boolean).join(' | ');
        } else {
          entry.selection_gate = 'pass';
        }
      }
    }
    results.push(entry);
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
  // i9-batch: 批次收口——successor_sha 由 final_candidate 派生（CAS 派生，不自报），
  // status 置 closed。push-guard 侧验证「恰好一个后继」：successor_sha 必须是 frozen_at_sha
  // 的直接后继（见 push-guard.mjs 的批次校验段）。
  if (m.batch) {
    m.batch.successor_sha = last.integrated_tip;
    m.batch.status = 'closed';
  }
  appendEvent(m, { kind: 'run-finalized', final_candidate: last.integrated_tip, feature_branch: m.feature_branch ?? null, ...(m.batch ? { batch_id: m.batch.batch_id, successor_sha: m.batch.successor_sha, batch_status: m.batch.status } : {}) });
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
// i9-batch: batch 段（batch_id/frozen_at_sha/frozen_families/successor_sha/status）入锅——
// 照 gate_result 入 recomputeArtifactHash 的同一做法：末尾追加 canonicalJson，不重排既有字段；
// v tag 升 'fix-run/v3'，旧 manifest（v2）重算 hash 不再等于声明值，push-guard 的
// fix_orchestration.run_manifest_hash 比对即 fail-closed。
// **注意（2026-08-07，lead 补充派工）**：`v:` 是**常量 tag**（`fix-run/${RUN_MANIFEST_SCHEMA_VERSION}`），
// **不绑定 manifest 自身的 `schema_version` 字段**——`m.schema_version` 从不入 hash，任何 run
// manifest 用当前代码重算 `runManifestHash` 都必然自洽，该字段写 v2/写错/缺失都一样过。所以
// **版本一致性由 push-guard 的显式比较负责**（`runManifest.schema_version === RUN_MANIFEST_SCHEMA_VERSION`），
// 不要以为 hash 覆盖了它。刻意不加进 hash：改 hash 公式 = 迁移事件（在途 run 全部失效且失败
// 信息是「hash 不符」不可诊断），显式比较给出「期望 v3、实到 v2」可诊断。
export function runManifestHash(m) {
  return sha256(canonicalJson({
    v: `fix-run/${RUN_MANIFEST_SCHEMA_VERSION}`, run_id: m.run_id, fix_plan_hash: m.fix_plan_hash,
    sc_manifest_hash: m.sc_manifest_hash, source_artifact_hash: m.source_artifact_hash,
    source_candidate: m.source_candidate, final_candidate: m.final_candidate ?? null,
    waves: (m.waves ?? []).map((w) => ({
      base: w.base,
      tips: (w.tips ?? []).map((t) => ({ g: t.group_id, tip: t.tip })),
      integrated_tip: w.integrated_tip,
      squashes: w.squash_commits ?? [],
      rounds: (w.replan?.rounds ?? []).map((r) => ({ g: r.group_id, base: r.base, tip: r.tip, squash: r.squash })),
      validation: w.validation ? { ok: !!w.validation.ok, results: (w.validation.results ?? []).map((r) => ({ sc_id: r.sc_id, status: r.status, exit_code: r.exit_code, verify_digest: r.verify_digest })) } : null
    })),
    batch: m.batch ? {
      batch_id: m.batch.batch_id,
      frozen_at_sha: m.batch.frozen_at_sha,
      frozen_families: m.batch.frozen_families ?? [],
      successor_sha: m.batch.successor_sha ?? null,
      status: m.batch.status ?? null
    } : null
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
      // D3: --artifact/--sc-manifest 改必填——两个入口同等 fail-closed，不留 legacy 通道。
      need(['state-dir', 'run-id', 'plan', 'wave', 'worktree-root', 'artifact', 'sc-manifest']);
      const r = allocate({
        stateDir: args['state-dir'], runId: args['run-id'], plan: readJson(args.plan),
        waveIndex: Number(args.wave), worktreeRoot: args['worktree-root'],
        artifact: readJson(args.artifact),
        scManifest: readJson(args['sc-manifest'])
      });
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
