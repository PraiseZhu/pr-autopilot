#!/usr/bin/env node
// issue #9 SC-A / SC-B 回归 fixtures — worker: fix/i9-core-hash-round
// 覆盖范围（详见 runtime/i9/sc-final.md §3 SC-A/SC-B，与 lead 派工包 Decisions 1-7）:
//   SC-A1: gate_result 入 recomputeArtifactHash——翻转即 hash 失效
//   SC-A2: push-guard(fix_orchestration.sourceArtifact) / sc-coverage-gate(checkScCoverage) /
//          fix-run(initRun) 三入口拒 gate_result≠pass 的源 artifact（各一正一反，消息文本互斥
//          以支持反向变异隔离）
//   SC-B1: 非空 R1（closed blocker finding + 七面覆盖 + APPROVED + 无 parent）→ PASS，round===1
//   SC-B2: R2 携带完整可信 parent（gate_result=pass/round=1/hash 自洽）→ PASS
//   SC-B3: 六种非法态全部 fail，各自可分辨（① R1 带 parent ② R>=2 无 parent ③ 三席 round 不一致
//          ④ 伪造 parent(hash 不自洽) ⑤ parent.round 跳号 ⑥ parent 自身 gate_result≠pass）
//   SC-B4: 三席 attempt 不一致 → fail；一致 → 不因此失败
// 本文件独立可跑：`node fixtures/i9-core.mjs`，不并入 run-fixtures.mjs / run-all.sh
// （lead 边界：run-fixtures.mjs 由另一位并行 worker + lead 汇收时统一接线）。
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { computeReviewInputHash } from '../scripts/review-input-hash.mjs';
import { runConsensusGate, recomputeArtifactHash } from '../scripts/consensus-gate.mjs';
import { checkPushGuard } from '../scripts/push-guard.mjs';
import { checkScCoverage } from '../scripts/sc-coverage-gate.mjs';
import { initRun } from '../scripts/fix-run.mjs';
import { computeFixPlanHash } from '../scripts/fix-plan.mjs';
import { readJson } from '../scripts/lib/common.mjs';
import { HARDENING_CLASS_COUNT, HARDENING_CHECKLIST_VERSION } from '../scripts/lib/hardening-registry.mjs';
// SC-R3-6（只读引用，不修改该文件）: REVIEWERS 是 verdict-validate.mjs 的唯一权威声明——
// consensus-gate.mjs 已改为直接 import 它（MAJOR1 修复）。这里同样只读引用，用于行为级验证
// 「改席位名单 → consensus-gate 的席位门跟着变」，测试内会 push/pop 还原，不留污染。
import { REVIEWERS, SCHEMA_VERSION } from '../scripts/verdict-validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const S = join(HERE, '..', 'scripts');

let pass = 0, failCount = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { failCount++; failures.push(name); console.log(`FAIL  ${name}: ${e.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg = '') {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg} expected=${jb} got=${ja}`);
}

const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40), SHA_C = 'c'.repeat(40);

// ---- 复刻 run-fixtures.mjs 的最小 verdict/共识构造 helper（独立实现，不 import 该文件——
// 它是脚本不是模块，且 lead 边界禁止依赖它）----
const FULL_FACES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((f) => ({ face: f, result: f === 'B' ? 'n_a' : 'pass', evidence: `${f} 面走查完成` }));
const THIRD_FACES = ['D', 'E', 'F', 'G'].map((f) => ({ face: f, result: 'pass', evidence: `${f} 面走查完成` }));
const THIRD_GATES = ['format-gate', 'rule-compliance', 'security-privacy-gate', 'product-arch-gate'].map((g) => ({ gate_id: g, result: 'pass', evidence: `${g} 走查完成` }));
const FULL_HARDENING = Array.from({ length: HARDENING_CLASS_COUNT }, (_, i) => ({ class_id: i + 1, result: 'covered', evidence: `scripts/verdict-validate.mjs:${100 + i} 第${i + 1}类走查完成` }));

function mkBundle(baseSha, candidateSha, over = {}) {
  return {
    base_sha: baseSha, candidate_sha: candidateSha, pr_title: 't', pr_body: 'b',
    touches_ui: false, matched_paths: [],
    ui_registry_config_hash: 'c'.repeat(64), pr_context_digest: 'd'.repeat(64), ...over
  };
}
function withAnchorPaths(findings) {
  return (findings ?? []).map((fd, i) => {
    let out = fd;
    if (!Array.isArray(out.anchor_paths)) {
      const stripped = String(out.anchor ?? '').replace(/:\d+(-\d+)?$/, '').trim();
      const looksPath = stripped && !/\s/.test(stripped) && !stripped.startsWith('/') && !stripped.includes('..');
      out = { ...out, anchor_paths: [looksPath ? stripped : 'src/_fixture.ts'] };
    }
    if (['blocker', 'major'].includes(out.severity)) {
      if (out.invariant === undefined) out = { ...out, invariant: `fixture-invariant-${out.id ?? i}` };
      if (out.family_id === undefined) out = { ...out, family_id: `fixture-family-${out.id ?? i}` };
    }
    return out;
  });
}
function mkVerdictFor(reviewer, bundleObj, over = {}) {
  const base = {
    schema_version: SCHEMA_VERSION, reviewer, run_status: 'ok', round: 1, attempt: 1,
    base_sha: bundleObj.base_sha, candidate_sha: bundleObj.candidate_sha,
    review_input_hash: computeReviewInputHash(bundleObj),
    faces: reviewer === 'upstream-preview' ? THIRD_FACES : FULL_FACES,
    findings: [], gate_checks: reviewer === 'upstream-preview' ? THIRD_GATES : [],
    verdict: 'APPROVED', closed_finding_ids: [],
    ...(reviewer === 'upstream-preview' ? {} : { hardening_coverage: FULL_HARDENING, checklist_version: HARDENING_CHECKLIST_VERSION }),
    ...over
  };
  base.findings = withAnchorPaths(base.findings);
  return base;
}
function consensusFor(bundleObj, overrides = [{}, {}, {}], gateOpts = {}) {
  const vs = [
    mkVerdictFor('claude-adversarial', bundleObj, overrides[0]),
    mkVerdictFor('codex-adversarial', bundleObj, overrides[1]),
    mkVerdictFor('upstream-preview', bundleObj, overrides[2])
  ];
  let changedPaths = gateOpts.changedPaths;
  if (!changedPaths && !gateOpts.repoDir) {
    changedPaths = new Set();
    for (const v of vs) for (const fd of v.findings ?? []) for (const p of fd.anchor_paths ?? []) changedPaths.add(p);
  }
  return { verdicts: vs, artifact: runConsensusGate(vs, { bundle: bundleObj, changedPaths, ...gateOpts }) };
}

// ========== SC-A1: gate_result 入 hash ==========
console.log('\n[SC-A1] gate_result 入 consensus_artifact_hash');
t('[SC-A1] gate_result 任意翻转 → recomputeArtifactHash 立即变化；baseline 自洽', () => {
  const bundle = mkBundle(SHA_A, SHA_B);
  const { artifact } = consensusFor(bundle);
  ok(artifact.gate_result === 'pass', 'baseline 应为 PASS: ' + JSON.stringify(artifact.fail_reasons ?? []));
  eq(recomputeArtifactHash(artifact), artifact.consensus_artifact_hash, 'baseline hash 应自洽');
  const before = recomputeArtifactHash(artifact);
  const flipped = { ...artifact, gate_result: 'fail' };
  const after = recomputeArtifactHash(flipped);
  ok(after !== before, 'gate_result 翻转后 hash 必须变化（SC-A1）');
});

// ========== SC-A2: 三消费入口拒 fail 源 artifact ==========
console.log('\n[SC-A2] 三消费入口拒 gate_result≠pass 源 artifact（各一正一反 + 反向变异隔离）');
const a2Bundle = mkBundle(SHA_A, SHA_B);
const { artifact: a2Pass } = consensusFor(a2Bundle);
if (a2Pass.gate_result !== 'pass') throw new Error('SC-A2 前提失败: a2Pass 未 PASS: ' + JSON.stringify(a2Pass.fail_reasons ?? []));
const a2Forged = { ...a2Pass, gate_result: 'fail' };
a2Forged.consensus_artifact_hash = recomputeArtifactHash(a2Forged);

t('[SC-A2-a] sc-coverage-gate.checkScCoverage 直接拒 gate_result≠pass 源 artifact', () => {
  const goodManifest = { schema_version: 'v2', consensus_artifact_hash: a2Pass.consensus_artifact_hash, scs: [] };
  const goodErrs = checkScCoverage({ manifest: goodManifest, artifact: a2Pass });
  ok(!goodErrs.some((e) => /gate_result/.test(e)), '正例: PASS 源不应报 gate_result 错误: ' + JSON.stringify(goodErrs));
  const badManifest = { schema_version: 'v2', consensus_artifact_hash: a2Forged.consensus_artifact_hash, scs: [] };
  const badErrs = checkScCoverage({ manifest: badManifest, artifact: a2Forged });
  ok(badErrs.some((e) => /gate_result=fail ≠ pass（issue #9 SC-A: SC 覆盖门只接受 PASS 共识）/.test(e)),
    '反例: fail 源必须精确报出该消息: ' + JSON.stringify(badErrs));
});

function mkPlanFor(artifact) {
  const plan = { schema_version: 'v1', consensus_artifact_hash: artifact.consensus_artifact_hash, capacity: 8, groups: [], waves: [], n_min_per_wave: [], parallelism_notes: [] };
  plan.fix_plan_hash = computeFixPlanHash(plan);
  return plan;
}
t('[SC-A2-b] fix-run.initRun 直接拒 gate_result≠pass 源 artifact', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'i9-run-'));
  const m = initRun({ stateDir, runId: 'i9-a2-ok', repoDir: '/nonexistent', plan: mkPlanFor(a2Pass), scManifest: {}, sourceArtifact: a2Pass });
  ok(m.source_artifact_hash === recomputeArtifactHash(a2Pass), '正例: PASS 源应成功创建 run');
  let threw = null;
  try { initRun({ stateDir, runId: 'i9-a2-bad', repoDir: '/nonexistent', plan: mkPlanFor(a2Forged), scManifest: {}, sourceArtifact: a2Forged }); }
  catch (e) { threw = e; }
  ok(threw && /gate_result=fail ≠ pass（issue #9 SC-A: initRun 只接受 PASS 共识作源）/.test(threw.message),
    '反例: fail 源必须精确 throw 该消息: ' + (threw ? threw.message : '(未抛错)'));
});

// push-guard: 需要真实 git 仓（HEAD/branch/remote/clean tree 校验）——最小可行搭建
const pgRepo = mkdtempSync(join(tmpdir(), 'i9-pg-'));
const pg = (...a) => execFileSync('git', ['-C', pgRepo, ...a], { encoding: 'utf8' }).trim();
pg('init', '-q', '-b', 'main');
pg('config', 'user.email', 'fx@test'); pg('config', 'user.name', 'fx');
writeFileSync(join(pgRepo, 'a.txt'), '1\n');
pg('add', '.'); pg('commit', '-qm', 'base');
const PG_BASE = pg('rev-parse', 'HEAD');
pg('remote', 'add', 'origin', 'https://github.com/o/r.git');
pg('checkout', '-qb', 'feat');
writeFileSync(join(pgRepo, 'b.txt'), '2\n');
pg('add', '.'); pg('commit', '-qm', 'feat');
const PG_HEAD = pg('rev-parse', 'HEAD');

const pgBundle = mkBundle(PG_BASE, PG_HEAD);
const { artifact: pgTerminal } = consensusFor(pgBundle);
if (pgTerminal.gate_result !== 'pass') throw new Error('SC-A2 前提失败: pgTerminal 未 PASS: ' + JSON.stringify(pgTerminal.fail_reasons ?? []));
const constitution = readJson(join(S, 'evolution', 'constitution-paths.json'));
const pgManifestBase = { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: PG_HEAD, purpose: 'feature', consensus_artifact_hash: pgTerminal.consensus_artifact_hash };

function callPushGuardWithSource(sourceArtifact) {
  const fo = {
    source_artifact_hash: 'placeholder-src', sc_manifest_hash: 'placeholder-sc',
    fix_plan_hash: 'placeholder-plan', dispatch_record_hash: 'placeholder-dispatch', run_manifest_hash: 'placeholder-run'
  };
  return checkPushGuard({
    repoDir: pgRepo,
    manifest: { ...pgManifestBase, fix_orchestration: fo },
    artifact: pgTerminal, bundle: pgBundle, constitution,
    sourceArtifact, scManifest: {}, fixPlan: { capacity: 8, fix_plan_hash: 'bogus' }, dispatchRecord: {}, runManifest: null
  });
}
t('[SC-A2-c] push-guard.checkPushGuard 的 fix_orchestration.sourceArtifact 拒 gate_result≠pass（消息文本与 a/b 互斥，供反向变异隔离）', () => {
  const rGood = callPushGuardWithSource(a2Pass);
  ok(!rGood.errors.some((e) => /fail 共识不得作为修复编排的源/.test(e)), '正例: PASS 源不应报 push-guard 自身的 gate_result 错误: ' + JSON.stringify(rGood.errors));
  const rBad = callPushGuardWithSource(a2Forged);
  ok(rBad.errors.some((e) => /源 consensus artifact gate_result=fail ≠ pass（issue #9 SC-A: fail 共识不得作为修复编排的源）/.test(e)),
    '反例: fail 源必须精确报出该消息: ' + JSON.stringify(rBad.errors));
});

// ---- 谱系真实 git 仓（issue #9 R3 blocker）----------------------------------------------
// parent 绑定新增两道内容校验：① base_sha 与当前 bundle 相同（纯字符串比对，SHA_A/SHA_B 这类
// 字面量足够）；② candidate_sha 必须是当前 candidate_sha 的**真实 git 祖先**（git merge-base
// --is-ancestor，字面量 SHA 无法满足——git 无法把 'bbbb...' 解析成一个真实的历史提交）。
// 凡是需要 round>=2 且期望 PASS 的正例，都必须构造在真实仓库的真实提交链上；round=1 的
// 用例（不触碰 parent 校验）继续用 SHA_A/SHA_B/SHA_C 字面量即可，无需改动。
// 线性提交 L0→L1→L2→L3，外加从 L0 分叉、不是 L1/L2/L3 祖先的 sibling 分支 LX（反例专用）。
const lRepo = mkdtempSync(join(tmpdir(), 'i9-lineage-'));
const lg = (...a) => execFileSync('git', ['-C', lRepo, ...a], { encoding: 'utf8' }).trim();
lg('init', '-q', '-b', 'main');
lg('config', 'user.email', 'fx@test'); lg('config', 'user.name', 'fx');
writeFileSync(join(lRepo, 'f0.txt'), '0\n'); lg('add', '.'); lg('commit', '-qm', 'L0');
const L0 = lg('rev-parse', 'HEAD');
writeFileSync(join(lRepo, 'f1.txt'), '1\n'); lg('add', '.'); lg('commit', '-qm', 'L1');
const L1 = lg('rev-parse', 'HEAD');
writeFileSync(join(lRepo, 'f2.txt'), '2\n'); lg('add', '.'); lg('commit', '-qm', 'L2');
const L2 = lg('rev-parse', 'HEAD');
writeFileSync(join(lRepo, 'f3.txt'), '3\n'); lg('add', '.'); lg('commit', '-qm', 'L3');
const L3 = lg('rev-parse', 'HEAD');
lg('checkout', '-qb', 'sibling', L0);
writeFileSync(join(lRepo, 'fx.txt'), 'x\n'); lg('add', '.'); lg('commit', '-qm', 'LX');
const LX = lg('rev-parse', 'HEAD');
lg('checkout', '-q', 'main');
function lineageConsensus(baseSha, candidateSha, overrides, extraOpts = {}) {
  return consensusFor(mkBundle(baseSha, candidateSha), overrides, { repoDir: lRepo, ...extraOpts });
}

// ========== SC-B1/B2: round 语义正例 ==========
console.log('\n[SC-B1/B2] round=「PASS 共识序号」: 非空 R1 → PASS(round=1)；R2+完整可信 parent → PASS');
const b1Bundle = mkBundle(SHA_A, SHA_B);
const b1Finding = { id: 'B1-F1', primary_face: 'A', severity: 'blocker', anchor: 'src/b1.ts:10', anchor_paths: ['src/b1.ts'], evidence: '发现的具体问题描述', status: 'closed', invariant: 'X 必须唯一写者', family_id: 'fam-b1' };
const { artifact: b1Artifact } = consensusFor(b1Bundle, [
  { findings: [b1Finding], closed_finding_ids: ['B1-F1'] },
  {},
  {}
]);
t('[SC-B1] 非空 R1（closed blocker finding + 七面覆盖 + APPROVED + 无 parent）→ PASS 且 round===1', () => {
  ok(b1Artifact.gate_result === 'pass', 'SC-B1 应 PASS: ' + JSON.stringify(b1Artifact.fail_reasons ?? []));
  eq(b1Artifact.round, 1, 'SC-B1: 首个可 PASS 的共识必须是 round=1');
  eq(b1Artifact.parent_artifact_hash, null, 'SC-B1: R1 的 parent_artifact_hash 必须为 null');
  eq(b1Artifact.canonical_findings.length, 1, 'SC-B1: canonical_findings 应含刚才那条 finding');
});

// SC-B2（issue #9 R3 blocker 后改写）: b1Artifact 的 base/candidate 是字面量 SHA_A/SHA_B，
// 无法通过新增的 candidate_sha 真祖先校验（git 无法解析字面量为真实提交）——round>=2 的正例
// 改用上方的真实谱系仓 lRepo（L0 为 base，L1 为其真实子提交）。
const { artifact: l1Artifact } = lineageConsensus(L0, L1, [{}, {}, {}]);
const { artifact: b2Artifact } = lineageConsensus(L0, L2, [
  { round: 2, attempt: 1 }, { round: 2, attempt: 1 }, { round: 2, attempt: 1 }
], { parentArtifact: l1Artifact });
t('[SC-B2] R2 携带完整可信 parent（gate_result=pass/round=1/hash 自洽/base 相同/candidate 真祖先）→ PASS，parent_artifact_hash 记录 exact parent', () => {
  ok(l1Artifact.gate_result === 'pass', '前提: l1Artifact（R1，真实仓 L0→L1）应先 PASS: ' + JSON.stringify(l1Artifact.fail_reasons ?? []));
  ok(b2Artifact.gate_result === 'pass', 'SC-B2 应 PASS: ' + JSON.stringify(b2Artifact.fail_reasons ?? []));
  eq(b2Artifact.round, 2, 'SC-B2: round 应为 2');
  eq(b2Artifact.parent_artifact_hash, l1Artifact.consensus_artifact_hash, 'SC-B2: parent_artifact_hash 必须等于 R1 的 hash');
});

// ========== SC-B3: 六种非法态，各自独立可分辨 ==========
console.log('\n[SC-B3] 六种非法态全部 fail，各自独立可分辨（反向变异恰好红 1 条）');
t('[SC-B3①] R1 携带 parent → fail（首个可 PASS 的共识必须是无谱系的根）', () => {
  const { artifact } = consensusFor(mkBundle(SHA_A, SHA_B), [{}, {}, {}], { parentArtifact: b1Artifact });
  ok(artifact.gate_result === 'fail' && artifact.fail_reasons.some((e) => /round=1 不得携带 parent/.test(e)),
    'SC-B3①: R1+parent 必须 fail 且精确报出该消息: ' + JSON.stringify(artifact.fail_reasons ?? []));
});
t('[SC-B3②] round>=2 未绑定 parent → fail', () => {
  const { artifact } = consensusFor(mkBundle(SHA_A, SHA_B), [{ round: 2 }, { round: 2 }, { round: 2 }]);
  ok(artifact.gate_result === 'fail' && artifact.fail_reasons.some((e) => /未绑定上一轮 artifact/.test(e)),
    'SC-B3②: round=2 缺 parent 必须 fail: ' + JSON.stringify(artifact.fail_reasons ?? []));
});
t('[SC-B3③] 三席 round 不一致 → fail（不再静默取最大值）', () => {
  const { artifact } = consensusFor(mkBundle(SHA_A, SHA_B), [{ round: 1 }, { round: 2 }, { round: 1 }]);
  ok(artifact.gate_result === 'fail' && artifact.fail_reasons.some((e) => /三席 round 不一致/.test(e)),
    'SC-B3③: round 不一致必须 fail: ' + JSON.stringify(artifact.fail_reasons ?? []));
});
t('[SC-B3④] 伪造 parent（自身 hash 与内容重算不符）→ fail', () => {
  const forgedParent = { ...b1Artifact, canonical_findings: [] }; // 改内容但不重算 hash
  const { artifact } = consensusFor(mkBundle(SHA_A, SHA_B), [{ round: 2 }, { round: 2 }, { round: 2 }], { parentArtifact: forgedParent });
  ok(artifact.gate_result === 'fail' && artifact.fail_reasons.some((e) => /parent artifact 自身 hash 与内容重算不符/.test(e)),
    'SC-B3④: 伪造 parent 必须 fail: ' + JSON.stringify(artifact.fail_reasons ?? []));
});
t('[SC-B3⑤] parent.round 跳号（当前 round=3，parent.round=1）→ fail', () => {
  const { artifact } = consensusFor(mkBundle(SHA_A, SHA_B), [{ round: 3 }, { round: 3 }, { round: 3 }], { parentArtifact: b1Artifact });
  ok(artifact.gate_result === 'fail' && artifact.fail_reasons.some((e) => /父 round 跳号被拦/.test(e)),
    'SC-B3⑤: parent round 跳号必须 fail: ' + JSON.stringify(artifact.fail_reasons ?? []));
});
t('[SC-B3⑥] parent 自身 gate_result≠pass（即便 hash 自洽）→ fail', () => {
  const failParent = { ...b1Artifact, gate_result: 'fail' };
  failParent.consensus_artifact_hash = recomputeArtifactHash(failParent);
  const { artifact } = consensusFor(mkBundle(SHA_A, SHA_B), [{ round: 2 }, { round: 2 }, { round: 2 }], { parentArtifact: failParent });
  ok(artifact.gate_result === 'fail' && artifact.fail_reasons.some((e) => /只有 PASS 共识才能作 parent/.test(e)),
    'SC-B3⑥: parent gate_result≠pass 必须 fail: ' + JSON.stringify(artifact.fail_reasons ?? []));
});

// ========== SC-B4: 三席 attempt 一致性 ==========
console.log('\n[SC-B4] 三席 attempt 必须完全一致');
t('[SC-B4] attempt 不一致 → fail；一致 → 不因此失败', () => {
  const { artifact: badArt } = consensusFor(mkBundle(SHA_A, SHA_B), [{ attempt: 1 }, { attempt: 2 }, { attempt: 1 }]);
  ok(badArt.gate_result === 'fail' && badArt.fail_reasons.some((e) => /三席 attempt 不一致/.test(e)),
    'SC-B4: attempt 不一致必须 fail: ' + JSON.stringify(badArt.fail_reasons ?? []));
  const { artifact: goodArt } = consensusFor(mkBundle(SHA_A, SHA_B), [{ attempt: 3 }, { attempt: 3 }, { attempt: 3 }]);
  eq(goodArt.gate_result, 'pass', 'SC-B4 正例应整体 PASS: ' + JSON.stringify(goodArt.fail_reasons ?? []));
});

// ========== SC-B5: 废弃参数名 opts.parentArtifactHash 必须 throw，不得静默降级 ==========
console.log('\n[SC-B5] opts.parentArtifactHash 已废弃 → 必须 throw（round=1/round>=2 两种形状都不得静默降级）');
t('[SC-B5] 误传旧参数名 parentArtifactHash → throw；round=1 不得静默降级为「无谱系的根」PASS，round>=2 不得退化成方向错误的「缺 parent」fail', () => {
  let threwR1 = null;
  try { consensusFor(mkBundle(SHA_A, SHA_B), [{}, {}, {}], { parentArtifactHash: 'f'.repeat(64) }); }
  catch (e) { threwR1 = e; }
  ok(threwR1 && /parentArtifactHash 已废弃/.test(threwR1.message),
    'round=1 传废弃参数必须 throw 且消息点名废弃参数: ' + (threwR1 ? threwR1.message : '(未抛错，疑似静默降级为 PASS)'));

  let threwR2 = null;
  try { consensusFor(mkBundle(SHA_A, SHA_B), [{ round: 2 }, { round: 2 }, { round: 2 }], { parentArtifactHash: 'f'.repeat(64) }); }
  catch (e) { threwR2 = e; }
  ok(threwR2 && /parentArtifactHash 已废弃/.test(threwR2.message),
    'round>=2 传废弃参数必须同样 throw（不是退化成「未绑定上一轮 artifact」）: ' + (threwR2 ? threwR2.message : '(未抛错)'));
});

// ========== SC-R2: 结构门（schema_version/round）独立于 hash 自洽 ==========
// issue #9 R2 blocker（单审席，pr#563 review）: 三消费入口 + parent 路径此前只验 hash 自洽
// 与 gate_result，从不检查 schema_version/round——克隆合法 PASS artifact 后改 schema_version
// (v3→v1) 或删 round，按 recomputeArtifactHash 当前公式重算 hash 即可自洽通过。真正的拒绝
// 只能来自独立于 hash 结果的显式结构校验（assertArtifactShape），下面逐一验证四处调用点。
console.log('\n[SC-R2] 结构门（schema_version/round）先于/独立于 hash 自洽——hash 自洽挡不住确定性重算攻击');

function forgeArtifact(base, mutate) {
  const forged = mutate({ ...base });
  forged.consensus_artifact_hash = recomputeArtifactHash(forged);
  return forged;
}

const r2Bundle = mkBundle(SHA_A, SHA_B);
const { artifact: r2Pass } = consensusFor(r2Bundle);
if (r2Pass.gate_result !== 'pass') throw new Error('SC-R2 前提失败: r2Pass 未 PASS: ' + JSON.stringify(r2Pass.fail_reasons ?? []));

// ---- SC-R2-1: schema_version v3→v1，按当前公式重算后仍自洽 ----
const r2SchemaForged = forgeArtifact(r2Pass, (a) => { a.schema_version = 'v1'; return a; });
t('[SC-R2-1-pre] schema_version v3→v1 后按当前公式重算 hash 仍自洽（证明 hash 自洽挡不住这类攻击，唯有独立结构门能拦）', () => {
  eq(recomputeArtifactHash(r2SchemaForged), r2SchemaForged.consensus_artifact_hash, 'schema_version 伪造后 hash 应仍自洽——这正是需要 assertArtifactShape 的原因');
});
t('[SC-R2-1-a] sc-coverage-gate.checkScCoverage 拒 schema_version≠v3 的源 artifact，报错点名 schema 版本而非 hash', () => {
  const manifest = { schema_version: 'v2', consensus_artifact_hash: r2SchemaForged.consensus_artifact_hash, scs: [] };
  const errs = checkScCoverage({ manifest, artifact: r2SchemaForged });
  ok(errs.some((e) => /schema_version/.test(e) && /v3/.test(e)), '必须点名 schema_version 问题: ' + JSON.stringify(errs));
  ok(!errs.some((e) => /hash 与内容重算不符/.test(e)), '不应报 hash 不符（hash 本就自洽，问题是结构）: ' + JSON.stringify(errs));
});
t('[SC-R2-1-b] fix-run.initRun throw 拒 schema_version≠v3 的源 artifact，消息点名 schema 版本', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'i9-run-r2schema-'));
  let threw = null;
  try { initRun({ stateDir, runId: 'i9-r2-schema', repoDir: '/nonexistent', plan: mkPlanFor(r2SchemaForged), scManifest: {}, sourceArtifact: r2SchemaForged }); }
  catch (e) { threw = e; }
  ok(threw && /schema_version/.test(threw.message) && /v3/.test(threw.message), '必须 throw 且点名 schema_version: ' + (threw ? threw.message : '(未抛错，疑似静默通过)'));
});
t('[SC-R2-1-c] push-guard.checkPushGuard 的 fix_orchestration.sourceArtifact 拒 schema_version≠v3，报错点名 schema 版本', () => {
  const r = callPushGuardWithSource(r2SchemaForged);
  ok(r.errors.some((e) => /schema_version/.test(e) && /v3/.test(e)), '必须点名 schema_version: ' + JSON.stringify(r.errors));
});
// 额外一处（不在 blocker 原文三入口之列，防御性加固）: push-guard 顶层 artifact 字段
// （purpose=feature，无 fix_orchestration 时的直通路径）同样必须过结构门。
t('[SC-R2-1-d(bonus)] push-guard.checkPushGuard 顶层 artifact 字段（purpose=feature 直通路径）拒 schema_version≠v3', () => {
  const forgedTerminal = forgeArtifact(pgTerminal, (a) => { a.schema_version = 'v1'; return a; });
  const r = checkPushGuard({
    repoDir: pgRepo,
    manifest: { ...pgManifestBase, consensus_artifact_hash: forgedTerminal.consensus_artifact_hash },
    artifact: forgedTerminal, bundle: pgBundle, constitution
  });
  ok(r.errors.some((e) => /schema_version/.test(e) && /v3/.test(e)), '必须点名 schema_version: ' + JSON.stringify(r.errors));
});

// ---- SC-R2-2: 删除 round ----
const r2RoundDeleted = { ...r2Pass };
delete r2RoundDeleted.round;
t('[SC-R2-2-pre] 删除 round 后 recomputeArtifactHash 直接 throw（不再静默产出"看起来合法"的 hash）', () => {
  let threw = null;
  try { recomputeArtifactHash(r2RoundDeleted); } catch (e) { threw = e; }
  ok(threw && /round/.test(threw.message), 'recomputeArtifactHash 必须 throw 且点名 round: ' + (threw ? threw.message : '(未抛错——静默产出了看似合法的 hash，正是 R2 blocker 的核心风险)'));
});
t('[SC-R2-2-a] sc-coverage-gate.checkScCoverage 拒删除 round 的源 artifact（不静默当 round:null 通过）', () => {
  const manifest = { schema_version: 'v2', consensus_artifact_hash: r2Pass.consensus_artifact_hash, scs: [] };
  const errs = checkScCoverage({ manifest, artifact: r2RoundDeleted });
  ok(errs.some((e) => /round/.test(e)), '必须点名 round 问题: ' + JSON.stringify(errs));
});
t('[SC-R2-2-b] fix-run.initRun throw 拒删除 round 的源 artifact', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'i9-run-r2round-'));
  let threw = null;
  try { initRun({ stateDir, runId: 'i9-r2-round', repoDir: '/nonexistent', plan: mkPlanFor(r2Pass), scManifest: {}, sourceArtifact: r2RoundDeleted }); }
  catch (e) { threw = e; }
  ok(threw && /round/.test(threw.message), '必须 throw 且点名 round: ' + (threw ? threw.message : '(未抛错)'));
});
t('[SC-R2-2-c] push-guard.checkPushGuard 的 fix_orchestration.sourceArtifact 拒删除 round 的源 artifact', () => {
  const r = callPushGuardWithSource(r2RoundDeleted);
  ok(r.errors.some((e) => /round/.test(e)), '必须点名 round: ' + JSON.stringify(r.errors));
});
t('[SC-R2-2-d(bonus)] push-guard.checkPushGuard 顶层 artifact 字段（purpose=feature 直通路径）拒删除 round', () => {
  const forgedTerminal = { ...pgTerminal };
  delete forgedTerminal.round;
  const r = checkPushGuard({
    repoDir: pgRepo,
    manifest: { ...pgManifestBase },
    artifact: forgedTerminal, bundle: pgBundle, constitution
  });
  ok(r.errors.some((e) => /round/.test(e)), '必须点名 round: ' + JSON.stringify(r.errors));
});

// ---- SC-R2-3: round>=2 的 parent 同样过结构门 ----
const r2ParentSchemaForged = forgeArtifact(r2Pass, (a) => { a.schema_version = 'v1'; return a; });
t('[SC-R2-3] round>=2 的 parent 结构门——parent.schema_version 被改成 v1（hash 重算自洽）→ 必拒，报错点名 schema 而非 hash', () => {
  const { artifact } = consensusFor(mkBundle(SHA_B, SHA_C), [{ round: 2 }, { round: 2 }, { round: 2 }], { parentArtifact: r2ParentSchemaForged });
  ok(artifact.gate_result === 'fail', 'round=2 携带 schema 非法的 parent 必须 fail: ' + JSON.stringify(artifact));
  ok(artifact.fail_reasons.some((e) => /schema_version/.test(e) && /v3/.test(e)), '必须点名 parent 的 schema_version 问题: ' + JSON.stringify(artifact.fail_reasons));
  ok(!artifact.fail_reasons.some((e) => /hash 与内容重算不符/.test(e)), '不应报 parent hash 不符（parent hash 本就自洽，问题是结构）: ' + JSON.stringify(artifact.fail_reasons));
});
t('[SC-R2-3-round] round>=2 的 parent 删除 round → 必拒，报错点名 round', () => {
  const parentRoundDeleted = { ...r2Pass };
  delete parentRoundDeleted.round;
  const { artifact } = consensusFor(mkBundle(SHA_B, SHA_C), [{ round: 2 }, { round: 2 }, { round: 2 }], { parentArtifact: parentRoundDeleted });
  ok(artifact.gate_result === 'fail' && artifact.fail_reasons.some((e) => /round/.test(e)),
    'parent 删除 round 必须 fail 且点名 round: ' + JSON.stringify(artifact.fail_reasons ?? []));
});

// ---- SC-R2-4: schema_version 已入 hash ----
t('[SC-R2-4] schema_version 已入 hash——仅翻转它（不重算）hash 必变', () => {
  const before = recomputeArtifactHash(r2Pass);
  const flipped = { ...r2Pass, schema_version: 'v1' };
  const after = recomputeArtifactHash(flipped);
  ok(after !== before, 'schema_version 翻转后 hash 必须变化（SC-R2-4）');
});

// ---- SC-R2-5: round 翻转变 hash；round 缺失不得静默产出"合法" hash ----
t('[SC-R2-5a] round 翻转（1→2）hash 必变', () => {
  const before = recomputeArtifactHash(r2Pass);
  const flipped = { ...r2Pass, round: 2 };
  const after = recomputeArtifactHash(flipped);
  ok(after !== before, 'round 翻转后 hash 必须变化（SC-R2-5）');
});
t('[SC-R2-5b] round 缺失时 recomputeArtifactHash 必须 throw，不得静默产出"合法" hash', () => {
  const missing = { ...r2Pass };
  delete missing.round;
  let threw = null;
  try { recomputeArtifactHash(missing); } catch (e) { threw = e; }
  ok(threw && /round/.test(threw.message), 'round 缺失必须 throw 且点名 round: ' + (threw ? threw.message : '(未抛错——静默产出了看似合法的 hash)'));
});

// ---- SC-R2-6: schema 文件 $id/title 升 v3 + parent_artifact_hash 已声明 ----
t('[SC-R2-6] schemas/consensus-artifact.schema.json 已升级为 v3 且声明 parent_artifact_hash（nullable 64-hex）', () => {
  const schema = readJson(join(S, '..', 'schemas', 'consensus-artifact.schema.json'));
  ok(/v3/.test(schema.$id), '$id 必须标注 v3: ' + schema.$id);
  ok(/v3/.test(schema.title), 'title 必须标注 v3: ' + schema.title);
  ok(schema.properties && schema.properties.parent_artifact_hash, 'properties 必须声明 parent_artifact_hash: ' + JSON.stringify(Object.keys(schema.properties ?? {})));
  const pah = schema.properties.parent_artifact_hash;
  const types = Array.isArray(pah.type) ? pah.type : [pah.type];
  ok(types.includes('string') && types.includes('null'), 'parent_artifact_hash 必须允许 string 或 null（nullable）: ' + JSON.stringify(pah.type));
  ok(typeof pah.pattern === 'string' && /64/.test(pah.pattern), 'parent_artifact_hash 必须声明 64-hex pattern: ' + JSON.stringify(pah.pattern));
});

// ========== SC-R3: parent 谱系绑定内容校验（base 相同 + candidate 真祖先）==========
// issue #9 R3 blocker（单审席，pr#563 review）: 谱系此前只验「这一跳」自身结构/hash 自洽/
// round 连续，从不验 parent 的内容是否与**当前这次评审**同源——伪造/跮 PR 的 parent（base/
// candidate 与当前评审完全不同）只要自身 hash 自洽、gate_result=pass、round=当前round-1
// 就能绑定成功，甚至能换成完全不相关的另一个 PR 的 base/candidate。
console.log('\n[SC-R3] parent 谱系绑定新增内容校验：base_sha 相同 + candidate_sha 真祖先（issue #9 R3 blocker）');

t('[SC-R3-2] 跮 PR 的伪 parent（base/candidate 与当前评审完全不同，自身完全自洽）→ 必拒，报错点名 base 不匹配', () => {
  const CROSS_BASE = 'e'.repeat(40), CROSS_CANDIDATE = 'f'.repeat(40);
  const forgedDraft = {
    schema_version: 'v3', review_input_hash: 'a'.repeat(64), parent_artifact_hash: 'f'.repeat(64),
    round: 2, base_sha: CROSS_BASE, candidate_sha: CROSS_CANDIDATE, canonical_findings: [],
    verdict_hashes: { 'claude-adversarial': '1'.repeat(64), 'codex-adversarial': '2'.repeat(64), 'upstream-preview': '3'.repeat(64) },
    created_at: new Date(0).toISOString(), gate_result: 'pass', fail_reasons: []
  };
  const forgedParent = { ...forgedDraft, consensus_artifact_hash: recomputeArtifactHash(forgedDraft) };
  const { artifact } = lineageConsensus(L0, L3, [{ round: 3, attempt: 1 }, { round: 3, attempt: 1 }, { round: 3, attempt: 1 }], { parentArtifact: forgedParent });
  ok(artifact.gate_result === 'fail' && artifact.fail_reasons.some((e) => /base_sha 与当前 bundle\.base_sha 不一致/.test(e)),
    'SC-R3-2: 跮 PR 的伪 parent 必须 fail 且精确点名 base 不匹配: ' + JSON.stringify(artifact.fail_reasons ?? []));
});

t('[SC-R3-3] parent.base_sha 相同但 candidate_sha 不是当前 candidate 的祖先（平行 sibling 分支）→ 必拒，报错点名非祖先关系', () => {
  const { artifact: siblingParent } = lineageConsensus(L0, LX, [{}, {}, {}]);
  ok(siblingParent.gate_result === 'pass', '前提: sibling 分支的 R1 artifact 应先 PASS: ' + JSON.stringify(siblingParent.fail_reasons ?? []));
  const { artifact } = lineageConsensus(L0, L2, [{ round: 2, attempt: 1 }, { round: 2, attempt: 1 }, { round: 2, attempt: 1 }], { parentArtifact: siblingParent });
  ok(artifact.gate_result === 'fail' && artifact.fail_reasons.some((e) => /不是当前 candidate_sha（.*）的祖先/.test(e)),
    'SC-R3-3: 同 base 但 candidate 非祖先必须 fail 且点名非祖先关系: ' + JSON.stringify(artifact.fail_reasons ?? []));
});

t('[SC-R3-4] 合法链（base 相同 + candidate 真祖先 + round 连续）三轮连续 → 均 PASS（正常路径不被新校验误拦）', () => {
  const { artifact: r1 } = lineageConsensus(L0, L1, [{}, {}, {}]);
  ok(r1.gate_result === 'pass', 'R1 应 PASS: ' + JSON.stringify(r1.fail_reasons ?? []));
  eq(r1.round, 1, 'R1: round 应为 1');
  const { artifact: r2 } = lineageConsensus(L0, L2, [{ round: 2, attempt: 1 }, { round: 2, attempt: 1 }, { round: 2, attempt: 1 }], { parentArtifact: r1 });
  ok(r2.gate_result === 'pass', 'R2 应 PASS: ' + JSON.stringify(r2.fail_reasons ?? []));
  eq(r2.round, 2, 'R2: round 应为 2');
  eq(r2.parent_artifact_hash, r1.consensus_artifact_hash, 'R2: parent_artifact_hash 应等于 R1 的 hash');
  const { artifact: r3 } = lineageConsensus(L0, L3, [{ round: 3, attempt: 1 }, { round: 3, attempt: 1 }, { round: 3, attempt: 1 }], { parentArtifact: r2 });
  ok(r3.gate_result === 'pass', 'R3 应 PASS: ' + JSON.stringify(r3.fail_reasons ?? []));
  eq(r3.round, 3, 'R3: round 应为 3');
  eq(r3.parent_artifact_hash, r2.consensus_artifact_hash, 'R3: parent_artifact_hash 应等于 R2 的 hash');
});

t('[SC-R3-5] consensus artifact 缺失/非法 gate_result → checkScCoverage 返回 errors 数组而不是抛异常（issue #9 R3 MAJOR2）', () => {
  const { artifact: baseArtifact } = lineageConsensus(L0, L1, [{}, {}, {}]);
  ok(baseArtifact.gate_result === 'pass', '前提: baseArtifact 应先 PASS: ' + JSON.stringify(baseArtifact.fail_reasons ?? []));
  const manifest = { schema_version: 'v2', consensus_artifact_hash: baseArtifact.consensus_artifact_hash, scs: [] };

  const noGateResult = { ...baseArtifact };
  delete noGateResult.gate_result;
  let threw = null, errs = null;
  try { errs = checkScCoverage({ manifest, artifact: noGateResult }); }
  catch (e) { threw = e; }
  ok(!threw, 'SC-R3-5a: 缺 gate_result 时 checkScCoverage 不得抛未捕获异常: ' + (threw ? threw.message : ''));
  ok(Array.isArray(errs) && errs.some((e) => /gate_result/.test(e)), 'SC-R3-5a: 必须返回点名 gate_result 的错误数组: ' + JSON.stringify(errs));

  const badGateResult = { ...baseArtifact, gate_result: 'maybe' };
  let threw2 = null, errs2 = null;
  try { errs2 = checkScCoverage({ manifest, artifact: badGateResult }); }
  catch (e) { threw2 = e; }
  ok(!threw2, 'SC-R3-5b: gate_result 非法值同样不得抛未捕获异常: ' + (threw2 ? threw2.message : ''));
  ok(Array.isArray(errs2) && errs2.some((e) => /gate_result/.test(e)), 'SC-R3-5b: 必须返回点名 gate_result 的错误数组: ' + JSON.stringify(errs2));
});

t('[SC-R3-6] REVIEWERS（verdict-validate.mjs 唯一权威席位名单）改动 → consensus-gate 的席位门跟着变（行为验证，非数据相等）', () => {
  const { artifact: before } = lineageConsensus(L0, L1, [{}, {}, {}]);
  ok(before.gate_result === 'pass', '基线（改名单前）三席合法 verdict 应 PASS: ' + JSON.stringify(before.fail_reasons ?? []));
  REVIEWERS.push('sentinel-seat');
  try {
    const { artifact: after } = lineageConsensus(L0, L1, [{}, {}, {}]);
    ok(after.gate_result === 'fail' && after.fail_reasons.some((e) => /缺少三席之一: sentinel-seat/.test(e)),
      'SC-R3-6: 席位名单加一席后，consensus-gate 的席位门必须跟着变、拒绝仍是旧三席的 verdict: ' + JSON.stringify(after.fail_reasons ?? []));
  } finally {
    REVIEWERS.pop();
  }
  const { artifact: restored } = lineageConsensus(L0, L1, [{}, {}, {}]);
  ok(restored.gate_result === 'pass', '还原名单后应恢复 PASS（确认测试未污染后续状态，且 REVIEWERS 已 pop 复位）: ' + JSON.stringify(restored.fail_reasons ?? []));
  eq(REVIEWERS.length, 3, 'SC-R3-6: 测试结束后 REVIEWERS 必须还原为 3 席（防止污染同进程内的其他测试）');
});

t('[SC-R3-7] 改 schemas/consensus-artifact.schema.json 的 schema_version 版本常量 → 产出端(draft.schema_version)与结构门(assertArtifactShape)两侧同步跟着变（子进程隔离验证，非数据比对）', () => {
  const schemaPath = join(S, '..', 'schemas', 'consensus-artifact.schema.json');
  const original = readFileSync(schemaPath, 'utf8');
  const PROBE_VERSION = 'v3-sc-r3-7-probe';
  try {
    const schemaObj = JSON.parse(original);
    ok(schemaObj.properties?.schema_version?.const === 'v3', '前提: 改动前版本应为 v3，得到: ' + JSON.stringify(schemaObj.properties?.schema_version?.const));
    schemaObj.properties.schema_version.const = PROBE_VERSION;
    writeFileSync(schemaPath, JSON.stringify(schemaObj, null, 2) + '\n');

    const probeSrc = `
import { runConsensusGate, assertArtifactShape, ARTIFACT_SCHEMA_VERSION } from ${JSON.stringify(join(S, 'consensus-gate.mjs'))};
import { SCHEMA_VERSION } from ${JSON.stringify(join(S, 'verdict-validate.mjs'))};
import { computeReviewInputHash } from ${JSON.stringify(join(S, 'review-input-hash.mjs'))};
import { HARDENING_CLASS_COUNT, HARDENING_CHECKLIST_VERSION } from ${JSON.stringify(join(S, 'lib', 'hardening-registry.mjs'))};
const FULL_FACES = ['A','B','C','D','E','F','G'].map((f) => ({ face: f, result: f === 'B' ? 'n_a' : 'pass', evidence: f + ' 面走查完成' }));
const THIRD_FACES = ['D','E','F','G'].map((f) => ({ face: f, result: 'pass', evidence: f + ' 面走查完成' }));
const THIRD_GATES = ['format-gate','rule-compliance','security-privacy-gate','product-arch-gate'].map((g) => ({ gate_id: g, result: 'pass', evidence: g + ' 走查完成' }));
const FULL_HARDENING = Array.from({ length: HARDENING_CLASS_COUNT }, (_, i) => ({ class_id: i + 1, result: 'covered', evidence: 'scripts/verdict-validate.mjs:' + (100 + i) + ' 第' + (i + 1) + '类走查完成' }));
const bundle = { base_sha: 'a'.repeat(40), candidate_sha: 'b'.repeat(40), pr_title: 't', pr_body: 'b', touches_ui: false, matched_paths: [], ui_registry_config_hash: 'c'.repeat(64), pr_context_digest: 'd'.repeat(64) };
function mkV(reviewer) {
  return {
    schema_version: SCHEMA_VERSION, reviewer, run_status: 'ok', round: 1, attempt: 1,
    base_sha: bundle.base_sha, candidate_sha: bundle.candidate_sha,
    review_input_hash: computeReviewInputHash(bundle),
    faces: reviewer === 'upstream-preview' ? THIRD_FACES : FULL_FACES,
    findings: [], gate_checks: reviewer === 'upstream-preview' ? THIRD_GATES : [],
    verdict: 'APPROVED', closed_finding_ids: [],
    ...(reviewer === 'upstream-preview' ? {} : { hardening_coverage: FULL_HARDENING, checklist_version: HARDENING_CHECKLIST_VERSION })
  };
}
const vs = ['claude-adversarial','codex-adversarial','upstream-preview'].map(mkV);
const artifact = runConsensusGate(vs, { bundle, changedPaths: new Set() });
const shapeErrsOld = assertArtifactShape({ ...artifact, schema_version: 'v3' });
const shapeErrsNew = assertArtifactShape(artifact);
process.stdout.write(JSON.stringify({ ARTIFACT_SCHEMA_VERSION, gate_result: artifact.gate_result, fail_reasons: artifact.fail_reasons, draft_schema_version: artifact.schema_version, shapeErrsOld, shapeErrsNew }));
`;
    const out = execFileSync('node', ['--input-type=module', '-e', probeSrc], { encoding: 'utf8' });
    const result = JSON.parse(out);
    eq(result.ARTIFACT_SCHEMA_VERSION, PROBE_VERSION, '产出端派生常量: 必须跟着 schema 文件变化，不是编译期定死的字面量');
    ok(result.gate_result === 'pass', 'probe 版本下的共识应仍 PASS: ' + JSON.stringify(result.fail_reasons));
    eq(result.draft_schema_version, PROBE_VERSION, '产出端: draft.schema_version 必须是新派生的版本，不是硬编码的 v3');
    ok(result.shapeErrsOld.some((e) => /schema_version/.test(e)), '结构门: 改版后旧版本号字面量 v3 必须被拒: ' + JSON.stringify(result.shapeErrsOld));
    ok(!result.shapeErrsNew.some((e) => /schema_version/.test(e)), '结构门: 改版后的新版本号必须放行: ' + JSON.stringify(result.shapeErrsNew));
  } finally {
    writeFileSync(schemaPath, original);
  }
  const restoredCheck = JSON.parse(readFileSync(schemaPath, 'utf8'));
  eq(restoredCheck.properties?.schema_version?.const, 'v3', 'SC-R3-7: schema 文件必须已还原为 v3（防止测试污染仓库文件）');
});

t('[版本字面量] 本文件 verdict 构造须用 SCHEMA_VERSION 派生，不得残留 verdict schema_version 字面量（照 [SC-12] 写法）', () => {
  // 2026-08-07: verdict schema 版本改从 verdict-validate.mjs 导出的 SCHEMA_VERSION 派生。
  // artifact schema 版本（SC-R2-1/2-3/2-6/3-2/3-7 的 B 类字面量）等 batch-txn 的
  // ARTIFACT_SCHEMA_VERSION 落地再改；sc_manifest/fix_plan 的 schema_version 是另一套协议，不在此列。
  const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  ok(/schema_version: SCHEMA_VERSION, reviewer/.test(own), '本文件 verdict 构造必须用 SCHEMA_VERSION 派生常量');
  const lit = "schema_version: 'v" + "[0-9]', reviewer";
  ok(!own.includes(lit), '本文件不得残留 verdict schema_version 字面量（须用 SCHEMA_VERSION 派生）');
});

console.log(`\n========== i9-core fixtures: ${pass} passed, ${failCount} failed ==========`);
if (failCount > 0) {
  console.log('\nFAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
