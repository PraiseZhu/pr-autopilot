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
import { mkdtempSync, writeFileSync } from 'node:fs';
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
    schema_version: 'v3', reviewer, run_status: 'ok', round: 1, attempt: 1,
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

const b2Bundle = mkBundle(SHA_B, SHA_C);
const { artifact: b2Artifact } = consensusFor(b2Bundle, [
  { round: 2, attempt: 1 }, { round: 2, attempt: 1 }, { round: 2, attempt: 1 }
], { parentArtifact: b1Artifact });
t('[SC-B2] R2 携带完整可信 parent（gate_result=pass/round=1/hash 自洽）→ PASS，parent_artifact_hash 记录 exact parent', () => {
  ok(b2Artifact.gate_result === 'pass', 'SC-B2 应 PASS: ' + JSON.stringify(b2Artifact.fail_reasons ?? []));
  eq(b2Artifact.round, 2, 'SC-B2: round 应为 2');
  eq(b2Artifact.parent_artifact_hash, b1Artifact.consensus_artifact_hash, 'SC-B2: parent_artifact_hash 必须等于 R1 的 hash');
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

console.log(`\n========== i9-core fixtures: ${pass} passed, ${failCount} failed ==========`);
if (failCount > 0) {
  console.log('\nFAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
