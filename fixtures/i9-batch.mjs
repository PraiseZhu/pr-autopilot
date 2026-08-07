#!/usr/bin/env node
// issue #9 SC 延伸（批次事务协议）回归 fixtures — worker: fix/i9-batch-txn
// 覆盖范围（lead 派工包 Task 1/3/4/5/6，自建独立文件）:
//   [i9-batch-1] 正例走通：init 冻结集 → 直接后继修复 → finalize → 闭合门 OK + push-guard OK
//                （批次校验段不误伤合法批次）
//   [i9-batch-2] 冻结集未闭合被拒：冻结 family 在终版 delta 审查中再次出现（同族复发）→
//                闭合门判据④拒收口
//   [i9-batch-3] 批次期间新 family 混入被拒：本批 SC 处置冻结集之外的 family → 闭合门判据⑤拒
//   [i9-batch-4] 跨批复发申报 recurrence 段（触发条件④命中时的补充载体）：齐全通过；
//                缺 prior_sc_missed_because / verdict enum 非法 / symptom 缺 locator /
//                family_key 不在本批 frozen / prior_sc_id 不在 sc manifest → 各拒（自洽）
//   [i9-batch-6] successor 不是直接后继被拒：frozen_at_sha..successor 恰 2 个 commit →
//                push-guard「恰好一个后继」拒（squash 记录齐全，只红批次判据，失败模式隔离）
//   [i9-batch-10] 缺 invariant 无法归族（判据⑥）：源共识/终版共识的 blocker/major 无
//                family_key → 拒（先归因再进批次）
// 反向变异：每条用例对应一个「挖空点」。各挖空点的实测红行记录在开发期 lead 报告中，
// 本树只有 [i9-batch-6c] 内的一条常驻反向测试（严格后代——该检查曾被误删，故单独钉住）。
// 其余挖空点未在树内固化，改动相关实现时请手工重做变异。
// 本文件独立可跑：`node fixtures/i9-batch.mjs`，不并入 run-fixtures.mjs / run-all.sh
// （lead 边界：run-fixtures.mjs / run-all.sh 由 lead 亲自接线，禁改）。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { computeReviewInputHash } from '../scripts/review-input-hash.mjs';
import { runConsensusGate, recomputeArtifactHash, familyKeyOf } from '../scripts/consensus-gate.mjs';
import { checkPushGuard } from '../scripts/push-guard.mjs';
import { checkScCoverage } from '../scripts/sc-coverage-gate.mjs';
import { checkDispatch } from '../scripts/fix-dispatch-gate.mjs';
import { validateVerdict, OUT_OF_SCOPE_NOTES_FIELD, SCHEMA_VERSION } from '../scripts/verdict-validate.mjs';
import { contractSpec } from '../scripts/dispatch-contract.mjs';
import { buildFixPlan } from '../scripts/fix-plan.mjs';
import { runManifestHash, initRun, RUN_MANIFEST_SCHEMA_VERSION } from '../scripts/fix-run.mjs';
import { computeFixPlanHash } from '../scripts/fix-plan.mjs';
import { checkBatchClosure } from '../scripts/batch-closure-gate.mjs';
import { readJson, hashObject } from '../scripts/lib/common.mjs';
import { HARDENING_CLASS_COUNT, HARDENING_CHECKLIST_VERSION } from '../scripts/lib/hardening-registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const S = join(HERE, '..', 'scripts');

let pass = 0, failCount = 0;
const failures = [];
const pendingTests = [];
function t(name, fn) {
  const done = (err) => {
    if (err) { failCount++; failures.push(name); console.log(`FAIL  ${name}: ${err.message}`); }
    else { pass++; console.log(`  ok  ${name}`); }
  };
  let r;
  try { r = fn(); } catch (e) { done(e); return; }
  if (r && typeof r.then === 'function') pendingTests.push(Promise.resolve(r).then(() => done(null), done));
  else done(null);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg = '') {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg} expected=${jb} got=${ja}`);
}

// ---- 复刻 i9-core.mjs 的最小 verdict/共识构造 helper（独立实现，不 import run-fixtures.mjs）----
const FULL_FACES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((f) => ({ face: f, result: f === 'B' ? 'n_a' : 'pass', evidence: `${f} 面走查完成` }));
const THIRD_FACES = ['D', 'E', 'F', 'G'].map((f) => ({ face: f, result: 'pass', evidence: `${f} 面走查完成` }));
const THIRD_GATES = ['format-gate', 'rule-compliance', 'security-privacy-gate', 'product-arch-gate'].map((g) => ({ gate_id: g, result: 'pass', evidence: `${g} 走查完成` }));
const FULL_HARDENING = Array.from({ length: HARDENING_CLASS_COUNT }, (_, i) => ({ class_id: i + 1, result: 'covered', evidence: `scripts/verdict-validate.mjs:${100 + i} 第${i + 1}类走查完成` }));

function mkBundle(baseSha, candidateSha, over = {}) {
  return {
    base_sha: baseSha, candidate_sha: candidateSha, pr_title: 't', pr_body: 'b',
    touches_ui: false, matched_paths: [],
    ui_registry_config_hash: 'c'.repeat(64), pr_context_digest: 'd'.repeat(64),
    pr_number: over.pr_number !== undefined ? over.pr_number : null, // R4: 默认 null（无 PR 直跑三审合法），可覆盖
    ...over
  };
}
function withAnchorPaths(findings) {
  return (findings ?? []).map((fd) => {
    let out = fd;
    if (!Array.isArray(out.anchor_paths)) {
      const stripped = String(out.anchor ?? '').replace(/:\d+(-\d+)?$/, '').trim();
      out = { ...out, anchor_paths: [stripped] };
    }
    if (['blocker', 'major'].includes(out.severity)) {
      if (out.invariant === undefined) out = { ...out, invariant: `fixture-invariant-${out.id ?? 'x'}` };
      if (out.family_id === undefined) out = { ...out, family_id: `fixture-family-${out.id ?? 'x'}` };
    }
    return out;
  });
}
function mkVerdictFor(reviewer, bundleObj, findings, over = {}) {
  const closedIds = (findings ?? []).map((f) => f.id);
  return {
    schema_version: SCHEMA_VERSION, reviewer, run_status: 'ok', round: over.round ?? 1, attempt: over.attempt ?? 1,
    base_sha: bundleObj.base_sha, candidate_sha: bundleObj.candidate_sha,
    review_input_hash: computeReviewInputHash(bundleObj),
    faces: reviewer === 'upstream-preview' ? THIRD_FACES : FULL_FACES,
    findings: withAnchorPaths(findings),
    gate_checks: reviewer === 'upstream-preview' ? THIRD_GATES : [],
    verdict: 'APPROVED', closed_finding_ids: closedIds,
    ...(reviewer === 'upstream-preview' ? {} : { hardening_coverage: FULL_HARDENING, checklist_version: HARDENING_CHECKLIST_VERSION }),
    ...over
  };
}
function consensusFor(bundleObj, findingsByReviewer, over = {}) {
  const { repoDir, gateOpts = {}, ...verdictOver } = over; // repoDir/gateOpts 是共识参数，不是 verdict 字段
  const vs = [
    mkVerdictFor('claude-adversarial', bundleObj, findingsByReviewer[0], verdictOver),
    mkVerdictFor('codex-adversarial', bundleObj, findingsByReviewer[1], verdictOver),
    mkVerdictFor('upstream-preview', bundleObj, findingsByReviewer[2], verdictOver)
  ];
  return runConsensusGate(vs, { bundle: bundleObj, repoDir: repoDir ?? gateOpts.repoDir, ...gateOpts });
}

// ========== 场景搭建：真实 git 仓 + 真实共识链 ==========
const repo = mkdtempSync(join(tmpdir(), 'i9-batch-'));
const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
g('init', '-q', '-b', 'main');
g('config', 'user.email', 'fx@test'); g('config', 'user.name', 'fx');
writeFileSync(join(repo, 'a.txt'), '1\n');
g('add', '.'); g('commit', '-qm', 'L0 base');
const L0 = g('rev-parse', 'HEAD');
g('remote', 'add', 'origin', 'https://github.com/o/r.git');
g('checkout', '-qb', 'feat');
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src/fix1.ts'), 'export const fix1 = 1;\n');
writeFileSync(join(repo, 'src/fix2.ts'), 'export const fix2 = 1;\n');
writeFileSync(join(repo, 'README.md'), '# repo\n');
g('add', '.'); g('commit', '-qm', 'L1 candidate（批次起点）');
const L1 = g('rev-parse', 'HEAD');
// 直接后继（正例）：修 fix1
writeFileSync(join(repo, 'src/fix1.ts'), 'export const fix1 = 2;\n');
g('add', '.'); g('commit', '-qm', 'L2 successor（直接后继）');
const L2 = g('rev-parse', 'HEAD');

const constitution = readJson(join(S, 'evolution', 'constitution-paths.json'));
const FIX1_ANCHOR = 'src/fix1.ts:1', FIX2_ANCHOR = 'src/fix2.ts:1';
const I1 = '批次不变量A：取消后任何迟到的 start 不得重新激活';
const I2 = '批次不变量B：终态事件不得被发出两次';
const I3 = '批次期间新冒出的不变量C：控制事件不得当数据处理';
const FK1 = familyKeyOf(I1), FK2 = familyKeyOf(I2), FK3 = familyKeyOf(I3);
ok(FK1 && FK2 && FK3 && FK1 !== FK2 && FK1 !== FK3 && FK2 !== FK3, '三条不变量必须派生三个互异的 family_key（fixture 前提）');

// ---- 源共识（round 1 PASS，candidate=L1，含 F1/F2 两条 frozen 候选）----
const srcBundle = mkBundle(L0, L1);
const f1 = { id: 'f1', primary_face: 'A', severity: 'major', anchor: FIX1_ANCHOR, anchor_paths: ['src/fix1.ts'], evidence: 'fix1 缺取消保护', invariant: I1, family_id: 'fam-1', status: 'closed' };
const f2 = { id: 'f2', primary_face: 'A', severity: 'major', anchor: FIX2_ANCHOR, anchor_paths: ['src/fix2.ts'], evidence: 'fix2 终态可重发', invariant: I2, family_id: 'fam-2', status: 'closed' };
const srcArtifact = consensusFor(srcBundle, [[f1, f2], [f1, f2], [f1, f2]], { repoDir: repo });
if (srcArtifact.gate_result !== 'pass') throw new Error('fixture 前提失败: 源共识未 PASS: ' + JSON.stringify(srcArtifact.fail_reasons ?? []));
const cF1 = srcArtifact.canonical_findings.find((c) => c.family_key === FK1);
const cF2 = srcArtifact.canonical_findings.find((c) => c.family_key === FK2);
ok(cF1 && cF2, 'fixture 前提: 源共识必须包含 F1/F2 两条 canonical finding（含 family_key）');

// ---- SC manifest（SC-1 fix 覆盖 F1；SC-2 archive 覆盖 F2）----
const scManifest = {
  schema_version: 'v2', consensus_artifact_hash: srcArtifact.consensus_artifact_hash,
  scs: [
    { id: 'SC-1', kind: 'fix', finding_ids: [cF1.id], invariant: I1, family_key: FK1, change: '给 fix1 加取消保护', holds: 'fix1 取消后迟到 start 不激活', verify: { cmd: 'grep', args: ['-q', 'cancel', 'src/fix1.ts'] } },
    { id: 'SC-2', kind: 'archive', finding_ids: [cF2.id], invariant: I2, family_key: FK2, change: '把残余风险写进 README', holds: 'README 含约定文案', verify: { cmd: 'grep', args: ['-q', '残余', 'README.md'] } }
  ]
};
const covErrs = checkScCoverage({ manifest: scManifest, artifact: srcArtifact });
if (covErrs.length) throw new Error('fixture 前提失败: SC 覆盖门: ' + JSON.stringify(covErrs));

// ---- fix plan（真实重算）----
const built = buildFixPlan({ artifact: srcArtifact, manifest: scManifest, capacity: 8 });
if (built.degraded) throw new Error('fixture 前提失败: plan degraded: ' + JSON.stringify(built.reasons));
const plan = built.plan;
eq(JSON.stringify(plan.waves), JSON.stringify([['g1'], ['a1']]), 'fixture 前提: plan.waves 应为 fix 波 + archive 末波');

// ---- dispatch record（与 plan.waves 对应）----
const dispatchRecord = {
  fix_plan_hash: plan.fix_plan_hash,
  waves: [
    { dispatches: [{ group_id: 'g1', worker_session_id: 'w1', tip: L2, result: { status: 'PASS', sc_results: [{ sc_id: 'SC-1', status: 'PASS', evidence: 'fix1 修好' }] } }] },
    { dispatches: [{ group_id: 'a1', worker_session_id: 'w2', tip: L2, result: { status: 'PASS', sc_results: [{ sc_id: 'SC-2', status: 'PASS', evidence: '已登记' }] } }] }
  ]
};
const dErrs = checkDispatch({ plan, record: dispatchRecord });
if (dErrs.length) throw new Error('fixture 前提失败: 派发门: ' + JSON.stringify(dErrs));

// ---- run manifest 构造 helper（手工构造 + batch 段；调用方覆盖 waves/final_candidate/batch）----
// 2026-08-07: schema_version 改从 RUN_MANIFEST_SCHEMA_VERSION 派生（fix-run.mjs 导出）——
// 此前硬编码 'v3'，run manifest 版本线 bump 后会静默构造出生产端不再产生的形态。
function mkRunManifest(over = {}) {
  return {
    schema_version: RUN_MANIFEST_SCHEMA_VERSION, run_id: 'i9-batch-ok', repo_dir: repo,
    fix_plan_hash: plan.fix_plan_hash, sc_manifest_hash: hashObject(scManifest),
    source_artifact_hash: recomputeArtifactHash(srcArtifact), source_candidate: L1,
    feature_branch: 'feat', integration_branch: 'fix/i9-batch/integration',
    waves: [
      { wave_index: 0, base: L1, worktree_root: '/x', allocations: [], tips: [{ group_id: 'g1', tip: L2 }], integrated_tip: L2, replan: null, validation: { at: 't', ok: true, results: [] }, squash_commits: [L2] },
      { wave_index: 1, base: L2, worktree_root: '/x', allocations: [], tips: [{ group_id: 'a1', tip: L2 }], integrated_tip: L2, replan: null, validation: { at: 't', ok: true, results: [] }, squash_commits: [L2] }
    ],
    final_candidate: L2,
    batch: { batch_id: 'b1', frozen_at_sha: L1, frozen_families: [FK1, FK2].sort(), successor_sha: L2, status: 'closed' },
    events: [],
    ...over
  };
}

// ---- 终版（delta 轮 round 2 PASS）构造 helper：findingsByReviewer 三席 findings ----
function mkTerminal(candidateSha, findingsByReviewer) {
  const bundle = mkBundle(L0, candidateSha);
  return consensusFor(bundle, findingsByReviewer, { round: 2, attempt: 1, repoDir: repo, gateOpts: { parentArtifact: srcArtifact, repoDir: repo } });
}

// ========== [i9-batch-1] 正例走通 ==========
console.log('\n[i9-batch-1] 正例走通：闭合门 OK + push-guard OK（批次校验不误伤合法批次）');
const termEmpty = mkTerminal(L2, [[], [], []]);
if (termEmpty.gate_result !== 'pass') throw new Error('[i9-batch-1] 前提失败: delta 轮未 PASS: ' + JSON.stringify(termEmpty.fail_reasons ?? []));

const okRunManifest = mkRunManifest();
t('[i9-batch-1a] batch-closure-gate: 冻结集全处置（终版无复发）→ 通过', () => {
  const errs = checkBatchClosure({ runManifest: okRunManifest, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest });
  eq(errs, [], '正例闭合门应零错误: ' + JSON.stringify(errs));
});

t('[i9-batch-1b] push-guard: 合法批次（closed + 直接后继）→ 批次校验不误伤', () => {
  const fo = {
    source_artifact_hash: recomputeArtifactHash(srcArtifact),
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: runManifestHash(okRunManifest)
  };
  const r = checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: L2, purpose: 'feature', consensus_artifact_hash: termEmpty.consensus_artifact_hash, fix_orchestration: fo },
    artifact: termEmpty, bundle: mkBundle(L0, L2), constitution,
    sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: okRunManifest
  });
  const batchErrs = r.errors.filter((e) => /批次|batch|后继|successor/i.test(e));
  eq(batchErrs, [], '正例不应有任何批次校验错误: ' + JSON.stringify(r.errors));
  ok(!r.errors.some((e) => /恰好一个后继|批次未收口/.test(e)), '正例不应报「恰好一个后继/批次未收口」: ' + JSON.stringify(r.errors));
});

// ========== [i9-batch-2] 冻结集未闭合被拒 ==========
console.log('\n[i9-batch-2] 冻结集未闭合：冻结 family 在终版再次出现（同族复发）→ 闭合门拒收口');
// delta 轮审查席又挑出同 invariant（I1）的 finding → 同 family_key FK1 → 复发
const f1Recur = { id: 'f1r', primary_face: 'C', severity: 'major', anchor: FIX1_ANCHOR, anchor_paths: ['src/fix1.ts'], evidence: 'fix1 仍缺取消保护', invariant: I1, family_id: 'fam-1r', status: 'closed' };
const termRecur = mkTerminal(L2, [[f1Recur], [f1Recur], [f1Recur]]);
if (termRecur.gate_result !== 'pass') throw new Error('[i9-batch-2] 前提失败: 复发轮未 PASS: ' + JSON.stringify(termRecur.fail_reasons ?? []));
const recurRunManifest = mkRunManifest();
t('[i9-batch-1c] push-guard 闭合门接线：run manifest 含 batch 段且闭合门 errs 非空（复发）→ 拒 push（接线负例）', () => {
  // 2026-08-07（集成审查④）: batch-closure-gate 此前全仓只有 fixture 与它自己 CLI 调，
  // push 边界从不执行它——批次语义不变量在生产链静默缺席。接线后：run manifest 含 batch 段
  // 时 push-guard 调 checkBatchClosure，errs 非空即拒。用 recurRunManifest（冻结 FK1 复发）+
  // termRecur（终版含 FK1）构造：闭合门判据④必拒 → push-guard 必须报「批次闭合门」错误。
  const foRecur = {
    source_artifact_hash: recomputeArtifactHash(srcArtifact),
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: runManifestHash(recurRunManifest)
  };
  const rRecur = checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: L2, purpose: 'feature', consensus_artifact_hash: termRecur.consensus_artifact_hash, fix_orchestration: foRecur },
    artifact: termRecur, bundle: mkBundle(L0, L2), constitution,
    sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: recurRunManifest
  });
  ok(rRecur.errors.some((e) => /批次闭合门/.test(e)),
    '复发 run manifest（闭合门 errs 非空）必须被 push-guard 拒并点名批次闭合门: ' + JSON.stringify(rRecur.errors));
});
t('[i9-batch-2] 冻结集 family 在终版再次出现 → 闭合门④拒收口（消息点名复发 family）', () => {
  const errs = checkBatchClosure({ runManifest: recurRunManifest, sourceArtifact: srcArtifact, finalArtifact: termRecur, scManifest });
  ok(errs.some((e) => /冻结集 family_key .*再次出现（同族复发/.test(e)),
    '必须精确报出同族复发错误: ' + JSON.stringify(errs));
  ok(!errs.some((e) => /处置了冻结集之外/.test(e)), '判据⑤不得误报（本批 SC 没处置冻结集外 family）: ' + JSON.stringify(errs));
});

// ========== [i9-batch-3] 批次期间新 family 混入被拒 ==========
console.log('\n[i9-batch-3] 批次期间新 family 混入：本批 SC 处置冻结集之外的 family → 闭合门⑤拒');
const f3New = { id: 'f3', primary_face: 'D', severity: 'major', anchor: FIX2_ANCHOR, anchor_paths: ['src/fix2.ts'], evidence: 'fix2 新增控制事件问题', invariant: I3, family_id: 'fam-3', status: 'closed' };
const termNew = mkTerminal(L2, [[f3New], [f3New], [f3New]]);
if (termNew.gate_result !== 'pass') throw new Error('[i9-batch-3] 前提失败: 新 family 轮未 PASS: ' + JSON.stringify(termNew.fail_reasons ?? []));
const cF3 = termNew.canonical_findings.find((c) => c.family_key === FK3);
ok(cF3, '[i9-batch-3] 前提失败: 终版须含 F3（family_key=FK3）');
// 本批 SC manifest 混入一条处置 F3 的 SC（F3 不在冻结集）
const dirtyScManifest = {
  ...scManifest,
  scs: [...scManifest.scs, { id: 'SC-3', kind: 'fix', finding_ids: [cF3.id], invariant: I3, family_key: FK3, change: '修 fix2 控制事件', holds: 'fix2 控制事件不落数据', verify: { cmd: 'grep', args: ['-q', 'ctrl', 'src/fix2.ts'] } }]
};
t('[i9-batch-3] 本批 SC 处置冻结集外 family → 闭合门⑤拒（新 family 进下一批，不得混入本批）', () => {
  const errs = checkBatchClosure({ runManifest: mkRunManifest(), sourceArtifact: srcArtifact, finalArtifact: termNew, scManifest: dirtyScManifest });
  ok(errs.some((e) => /本批 SC SC-3 处置了冻结集之外的 family_key/.test(e)),
    '必须精确报出「处置冻结集外 family」错误: ' + JSON.stringify(errs));
  ok(!errs.some((e) => /再次出现（同族复发/.test(e)), '判据④不得误报（FK1/FK2 未在终版出现）: ' + JSON.stringify(errs));
});

// ========== [i9-batch-4] 跨批复发 → recurrence 段（触发条件④命中的补充载体） ==========
console.log('\n[i9-batch-4] 跨批复发申报 recurrence 段：齐全通过 / 残缺被拒（字段+enum+locator+自洽）');
// 场景：本批 frozen 含 FK1（上批处置过、又冒出来），本批修完终版无 FK1（这次修住了）→ 判据④通过；
// lead 申报 recurrence 段（触发条件④命中）→ 闭合门验形状与自洽（T1）。
t('[i9-batch-4a] 本批内同族复发（判据④：frozen family 在终版再次出现 = 没修住）→ 拒收口（与跨批触发区分）', () => {
  const errs = checkBatchClosure({ runManifest: recurRunManifest, sourceArtifact: srcArtifact, finalArtifact: termRecur, scManifest });
  ok(errs.some((e) => /同族复发/.test(e)), '判据④必须拒「本批没修住」: ' + JSON.stringify(errs));
});
const goodRecurrence = {
  family_key: FK1, prior_batch_id: 'b0', prior_candidate_sha: L2,
  prior_sc_id: 'SC-1',
  prior_sc_missed_because: 'SC-1 的 holds 只覆盖同步取消路径，没写迟到事件的断言',
  verdict: 'fix_was_wrong'
  // root_cause_locator: verdict ≠ symptom，不带
};
t('[i9-batch-4b] recurrence 齐全（跨批复发申报）→ 闭合门通过', () => {
  const errs = checkBatchClosure({ runManifest: recurRunManifest, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest, checkpoint: { recurrence: goodRecurrence } });
  eq(errs, [], '齐全 recurrence 应通过: ' + JSON.stringify(errs));
});
t('[i9-batch-4c] recurrence 缺 prior_sc_missed_because → 拒', () => {
  const bad = { ...goodRecurrence, prior_sc_missed_because: '' };
  const errs = checkBatchClosure({ runManifest: recurRunManifest, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest, checkpoint: { recurrence: bad } });
  ok(errs.some((e) => /prior_sc_missed_because 缺失或为空/.test(e)), '必须点名缺 prior_sc_missed_because: ' + JSON.stringify(errs));
});
t('[i9-batch-4d] recurrence.verdict 非法 enum → 拒', () => {
  const bad = { ...goodRecurrence, verdict: 'not_a_verdict' };
  const errs = checkBatchClosure({ runManifest: recurRunManifest, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest, checkpoint: { recurrence: bad } });
  ok(errs.some((e) => /recurrence\.verdict 非法/.test(e)), 'verdict enum 必须被拦: ' + JSON.stringify(errs));
});
t('[i9-batch-4e] verdict=fix_was_symptom 缺 root_cause_locator → 拒', () => {
  const bad = { ...goodRecurrence, verdict: 'fix_was_symptom', root_cause_locator: undefined };
  const errs = checkBatchClosure({ runManifest: recurRunManifest, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest, checkpoint: { recurrence: bad } });
  ok(errs.some((e) => /fix_was_symptom 必须携带 root_cause_locator/.test(e)), 'symptom 缺 locator 必须被拦: ' + JSON.stringify(errs));
});
t('[i9-batch-4f] recurrence.family_key 不在本批 frozen → 拒（自洽）', () => {
  const bad = { ...goodRecurrence, family_key: FK3 };
  const errs = checkBatchClosure({ runManifest: recurRunManifest, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest, checkpoint: { recurrence: bad } });
  ok(errs.some((e) => /不在本批 frozen_families 中/.test(e)), 'family_key 自洽必须被拦: ' + JSON.stringify(errs));
});
t('[i9-batch-4g] recurrence.prior_sc_id 不在 sc manifest → 拒（自洽）', () => {
  const bad = { ...goodRecurrence, prior_sc_id: 'SC-NOPE' };
  const errs = checkBatchClosure({ runManifest: recurRunManifest, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest, checkpoint: { recurrence: bad } });
  ok(errs.some((e) => /不在 sc manifest 中/.test(e)), 'prior_sc_id 自洽必须被拦: ' + JSON.stringify(errs));
});

// ========== [i9-batch-10] 缺 invariant 无法归族（判据⑥：blocker/major 必须带 family_key） ==========
console.log('\n[i9-batch-10] 缺 invariant 无法归族：blocker/major 无 family_key → 闭合门⑥拒');
// verdict 层已强制 actionable 带 invariant（verdict-validate SC-B1），但 consensus-gate 的
// family_key 注入是条件式——artifact 层独立检查防「verdict 校验被绕过/版本漂移」后缺口复活
// （T1 防漂移纵深）。此处手工构造缺族 artifact（合法结构 + hash 自洽），测闭合门判据⑥本身。
function mkNoFamilyArtifact(baseSha, candidateSha, over = {}) {
  const draft = {
    schema_version: readJson(join(S, '..', 'schemas', 'consensus-artifact.schema.json')).properties.schema_version.const,
    review_input_hash: computeReviewInputHash(mkBundle(baseSha, candidateSha)),
    parent_artifact_hash: null, round: 1, base_sha: baseSha, candidate_sha: candidateSha,
    canonical_findings: [{
      canonical_key: 'A|src/fix1.ts|x', id: 'hand1',
      origins: [{ reviewer: 'claude-adversarial', finding_id: 'f1' }],
      primary_face: 'A', severity: 'blocker', anchor: 'src/fix1.ts:1', anchor_paths: ['src/fix1.ts'],
      status: 'closed', origin_family_ids: []
      // 无 invariant → 无 family_key（缺归族）
    }],
    verdict_hashes: { 'claude-adversarial': 'x'.repeat(64), 'codex-adversarial': 'x'.repeat(64), 'upstream-preview': 'x'.repeat(64) },
    created_at: 't', gate_result: 'pass', fail_reasons: [], pr_number: null, ...over
  };
  return { ...draft, consensus_artifact_hash: recomputeArtifactHash(draft) };
}
const srcNoFam = mkNoFamilyArtifact(L0, L1); // 源共识：blocker 无 family_key
const finNoFam = mkNoFamilyArtifact(L0, L2); // 终版：blocker 无 family_key
t('[i9-batch-10a] 源共识 blocker 缺 invariant（无 family_key）→ 拒（先归因再进批次）', () => {
  const errs = checkBatchClosure({ runManifest: okRunManifest, sourceArtifact: srcNoFam, finalArtifact: termEmpty, scManifest });
  ok(errs.some((e) => /缺 invariant 无法归族/.test(e)), '源共识缺族必须被拦: ' + JSON.stringify(errs));
});
t('[i9-batch-10b] 终版共识 blocker 缺 invariant → 拒（下一批无法冻结它）', () => {
  const errs = checkBatchClosure({ runManifest: okRunManifest, sourceArtifact: srcArtifact, finalArtifact: finNoFam, scManifest });
  ok(errs.some((e) => /缺 invariant 无法归族/.test(e)), '终版缺族必须被拦: ' + JSON.stringify(errs));
});

// ========== [i9-batch-7] 批次未收口（status=open）被拒 ==========
console.log('\n[i9-batch-7] 批次未收口：batch.status=open → push-guard 拒 push');
const openRunManifest = mkRunManifest({
  batch: { batch_id: 'b1', frozen_at_sha: L1, frozen_families: [FK1, FK2].sort(), successor_sha: null, status: 'open' }
});
t('[i9-batch-7] batch.status=open → push-guard 报「批次未收口」', () => {
  const fo = {
    source_artifact_hash: recomputeArtifactHash(srcArtifact),
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: runManifestHash(openRunManifest)
  };
  const r = checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: L2, purpose: 'feature', consensus_artifact_hash: termEmpty.consensus_artifact_hash, fix_orchestration: fo },
    artifact: termEmpty, bundle: mkBundle(L0, L2), constitution,
    sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: openRunManifest
  });
  ok(r.errors.some((e) => /批次 .* status="open" ≠ closed（批次未收口，不得 push）/.test(e)),
    '必须精确报出「批次未收口」错误: ' + JSON.stringify(r.errors));
  ok(!r.errors.some((e) => /恰好一个后继/.test(e)), '未收口批次不得先撞「恰好一个后继」（失败模式隔离，successor 还没写）: ' + JSON.stringify(r.errors));
});

// ========== [i9-batch-8] 冻结集必须 ⊆ 源共识（initRun 与闭合门③同判据） ==========
console.log('\n[i9-batch-8] 冻结集真实：frozen_families 含源共识之外的 family → initRun throw / 闭合门③拒');
t('[i9-batch-8a] initRun 冻结集含外族 family_key → throw（fail-closed）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'i9-batch-run-'));
  const p = { schema_version: 'v1', consensus_artifact_hash: srcArtifact.consensus_artifact_hash, capacity: 8, groups: [], waves: [], n_min_per_wave: [], parallelism_notes: [] };
  p.fix_plan_hash = computeFixPlanHash(p);
  let threw = null;
  try { initRun({ stateDir, runId: 'i9-batch-bad', repoDir: repo, plan: p, scManifest: {}, sourceArtifact: srcArtifact, batch: { batch_id: 'b-bad', frozen_families: [FK1, FK3] } }); }
  catch (e) { threw = e; }
  ok(threw && /不在源共识 canonical_findings 中的 family_key/.test(threw.message),
    'initRun 必须精确 throw 外族冻结集错误: ' + (threw ? threw.message : '(未抛错)'));
});
t('[i9-batch-8b] 闭合门③同判据：frozen_families 含外族 → 拒（独立于 initRun 重验）', () => {
  const forgedRun = mkRunManifest({ batch: { batch_id: 'b1', frozen_at_sha: L1, frozen_families: [FK1, FK3].sort(), successor_sha: L2, status: 'closed' } });
  const errs = checkBatchClosure({ runManifest: forgedRun, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest });
  ok(errs.some((e) => /不在源共识中的 family_key/.test(e)),
    '闭合门必须独立重验冻结集真实性: ' + JSON.stringify(errs));
});

// ========== [i9-batch-9] 批次起点必须由 run 起点派生 ==========
console.log('\n[i9-batch-9] frozen_at_sha 不自报：≠ source_candidate → 闭合门②拒');
t('[i9-batch-9] batch.frozen_at_sha ≠ run 起点 → 闭合门②拒（起点 CAS 派生，不接受自报）', () => {
  const driftedRun = mkRunManifest({ batch: { batch_id: 'b1', frozen_at_sha: L0, frozen_families: [FK1, FK2].sort(), successor_sha: L2, status: 'closed' } });
  const errs = checkBatchClosure({ runManifest: driftedRun, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest });
  ok(errs.some((e) => /batch\.frozen_at_sha.*≠ run manifest source_candidate/.test(e)),
    'frozen_at_sha 漂移必须被拦: ' + JSON.stringify(errs));
});

// ========== [i9-batch-11] parent 同 SHA 铸造轮号被拒（issue #9 R4 修复②） ==========
console.log('\n[i9-batch-11] parent 同 SHA：`git merge-base --is-ancestor A A` 退出 0，同 SHA 的 R2 此前能通过 → 现在拒');
t('[i9-batch-11] R1(candidate=L2) 当 round=2 同 candidate 的 parent → 拒（同 SHA 无合法用途）', () => {
  const r1L2 = consensusFor(mkBundle(L0, L2), [[], [], []], { repoDir: repo }); // round 1 PASS，candidate=L2
  ok(r1L2.gate_result === 'pass', '[i9-batch-11] 前提失败: R1(L2) 未 PASS: ' + JSON.stringify(r1L2.fail_reasons ?? []));
  const r2SameSha = consensusFor(mkBundle(L0, L2), [[], [], []], {
    round: 2, attempt: 1, repoDir: repo,
    gateOpts: { parentArtifact: r1L2, repoDir: repo }
  });
  ok(r2SameSha.gate_result === 'fail', '[i9-batch-11] 同 SHA 的 R2 必须 fail: ' + JSON.stringify(r2SameSha.fail_reasons ?? []));
  ok((r2SameSha.fail_reasons ?? []).some((e) => /同 SHA 的 R2 无合法用途/.test(e)),
    '必须精确报出同 SHA 错误: ' + JSON.stringify(r2SameSha.fail_reasons ?? []));
});
t('[i9-batch-11b] 非祖先 parent 仍拒（与同 SHA 失败模式不重合）', () => {
  // 从 L0 分叉的 sibling LX（与 L2 平行）——真祖先链上不存在，is-ancestor=1
  const lRepo2 = mkdtempSync(join(tmpdir(), 'i9-batch-sibling-'));
  const g2 = (...a) => execFileSync('git', ['-C', lRepo2, ...a], { encoding: 'utf8' }).trim();
  g2('init', '-q', '-b', 'main');
  g2('config', 'user.email', 'fx@test'); g2('config', 'user.name', 'fx');
  writeFileSync(join(lRepo2, 'f0.txt'), '0\n'); g2('add', '.'); g2('commit', '-qm', 'L0');
  const Z0 = g2('rev-parse', 'HEAD');
  writeFileSync(join(lRepo2, 'f1.txt'), '1\n'); g2('add', '.'); g2('commit', '-qm', 'L1');
  const Z1 = g2('rev-parse', 'HEAD');
  g2('checkout', '-qb', 'sibling', Z0);
  writeFileSync(join(lRepo2, 'fx.txt'), 'x\n'); g2('add', '.'); g2('commit', '-qm', 'LX');
  const ZX = g2('rev-parse', 'HEAD');
  const r1Z1 = consensusFor(mkBundle(Z0, Z1), [[], [], []], { repoDir: lRepo2 }); // R1: candidate=Z1
  ok(r1Z1.gate_result === 'pass', '[i9-batch-11b] 前提失败: R1(Z1) 未 PASS: ' + JSON.stringify(r1Z1.fail_reasons ?? []));
  const r2Sibling = consensusFor(mkBundle(Z0, ZX), [[], [], []], {
    round: 2, attempt: 1, repoDir: lRepo2,
    gateOpts: { parentArtifact: r1Z1, repoDir: lRepo2 }
  });
  ok(r2Sibling.gate_result === 'fail', '[i9-batch-11b] 非祖先 parent 必须 fail: ' + JSON.stringify(r2Sibling.fail_reasons ?? []));
  ok((r2Sibling.fail_reasons ?? []).some((e) => /不是当前 candidate_sha.*的祖先/.test(e)),
    '非祖先必须报「不是祖先」而非「同 SHA」: ' + JSON.stringify(r2Sibling.fail_reasons ?? []));
});

// ========== [i9-batch-12] out_of_scope_notes 单一读取点旁路（R4 修复③，行为级钉住） ==========
console.log('\n[i9-batch-12] out_of_scope_notes 消费接线：产物字段名真正送进 validateVerdict，内容校验必须执行');
// 用 dispatch-contract 的产物字段名（out_of_scope_channel = OUT_OF_SCOPE_NOTES_FIELD）构造
// verdict——「把产物真正送进 validator」，不是只检查 contractSpec() 的返回值。
// 背景（审查席实测）：validator 的 D3 内容校验此前硬读 `v.out_of_scope_notes` 字面量，
// 字段名一旦在 schema 改名，TOP_LEVEL_KEYS（schema 派生）接受新名、本段读旧名读 undefined
// → 内容校验整段静默跳过（可选通道改名 = 静默丢数据，SC-R3-F2 判据要治的那类）。
const SPEC_CHANNEL = contractSpec({ seat: 'claude-adversarial', round: 1 }).out_of_scope_channel;
ok(SPEC_CHANNEL === OUT_OF_SCOPE_NOTES_FIELD, '[i9-batch-12] 前提: 产物通道名 == validator 常量');
function verdictWithNotes(notes, over = {}) {
  const fd = { id: 'f1', primary_face: 'A', severity: 'major', anchor: FIX1_ANCHOR, anchor_paths: ['src/fix1.ts'], evidence: 'x', invariant: I1, family_id: 'fam-1', status: 'closed' };
  const v = mkVerdictFor('claude-adversarial', mkBundle(L0, L1), [fd], over);
  if (notes !== null) v[SPEC_CHANNEL] = notes; // 用产物字段名（动态，跟常量走）
  return v;
}
t('[i9-batch-12a] 合法 out_of_scope_notes（产物字段名）→ validateVerdict 零 D3 错误', () => {
  const v = verdictWithNotes([{ id: 'n1', note: '范围外真问题', evidence: '证据', suggested_issue_title: '标题' }]);
  const errs = validateVerdict(v);
  eq(errs, [], '合法 note 应整体零错误（正例必须验整体通过，不能只查「无 D3 报错」——别的错误照绿 = 弱断言）: ' + JSON.stringify(errs));
});
t('[i9-batch-12b] 内容校验真实执行：note id 与 finding id 撞号 → validateVerdict 必须拦（走常量读取点）', () => {
  const v = verdictWithNotes([{ id: 'f1', note: '撞号', evidence: '证据', suggested_issue_title: '标题' }]); // id='f1' 撞 finding id
  const errs = validateVerdict(v);
  ok(errs.some((e) => /out_of_scope_note id「f1」与 finding id 撞号/.test(e)),
    '撞号必须被 D3 内容校验拦下（若读取点被旁路，本段读 undefined 静默跳过 = 洞）: ' + JSON.stringify(errs));
});
t('[i9-batch-12c] 可选通道改名不能静默：typo 字段名（out_of_scope_note 单数）→ 未知顶层字段被拦', () => {
  const v = verdictWithNotes(null);
  v['out_of_scope_note'] = [{ id: 'n1', note: 'x', evidence: 'y', suggested_issue_title: 'z' }];
  const errs = validateVerdict(v);
  ok(errs.some((e) => /verdict 存在未知顶层字段: out_of_scope_note/.test(e)),
    'typo 字段名必须被 TOP_LEVEL_KEYS 拦（fail loud，不得静默放走内容）: ' + JSON.stringify(errs));
});
// B 类钉住 harness（lead 2026-08-07）：钉「validator 必须跟着常量走」（常量变则行为跟着变，
// 防未来漂移）。两个不变量共用同一套「拷贝 + 改常量 + 动态 import」：
//   · 12d：改 OUT_OF_SCOPE_NOTES_FIELD 值 → 新字段名承载 note 送进拷贝 validateVerdict
//          → 硬读旧名则读 undefined 内容校验整段跳过（撞号静默通过=断言失败）；走常量跟新名（报错=通过）
//   · 12e：改 FACES 为 8 面 → 送 8 面对抗席 verdict → 硬抄 7 则拒（断言失败）；走 FACES.length 跟着变（通过）
// 通用 harness：拷 verdict-validate.mjs + review-verdict.schema.json 到 scripts/ 临时文件
// （保留相对 import——/tmp 下相对路径 import 实测失败；schema 也拷贝因为 TOP_LEVEL_KEYS 从
// schema 派生），applySrcPatch / applySchemaPatch 各自应用，动态 import，跑完 finally 清理。
async function withPatchedValidator({ srcPatch, schemaPatch, run }) {
  const { readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(join(S, 'verdict-validate.mjs'), 'utf8');
  let patchedSrc = srcPatch(src);
  // 唯一文件后缀（每次调用独立，避免 12d/12e 并发共享同名文件竞态——t 的 async 支持让它们并行）
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const schemaCopyPath = join(S, `.i9-batch-vv-schema-${uid}.json`);
  const schemaSrc = readFileSync(join(S, '..', 'schemas', 'review-verdict.schema.json'), 'utf8');
  writeFileSync(schemaCopyPath, schemaPatch(schemaSrc));
  const copyPath = join(S, `.i9-batch-vv-copy-${uid}.mjs`);
  patchedSrc = patchedSrc.replace(
    "join(HERE, '../schemas/review-verdict.schema.json')",
    `join(HERE, '.i9-batch-vv-schema-${uid}.json')`
  );
  writeFileSync(copyPath, patchedSrc);
  try {
    const copy = await import('file://' + copyPath + '?t=' + Date.now());
    await run(copy);
  } finally {
    rmSync(copyPath, { force: true });
    rmSync(schemaCopyPath, { force: true });
  }
}
t('[i9-batch-12d] B 类：validator 跟着常量走——改名后内容校验不脱节（临时拷贝动态 import）', async () => {
  const NEW_NAME = 'oos_notes_v2';
  await withPatchedValidator({
    srcPatch: (src) => src.replace(
      "export const OUT_OF_SCOPE_NOTES_FIELD = 'out_of_scope_notes';",
      `export const OUT_OF_SCOPE_NOTES_FIELD = '${NEW_NAME}';`
    ),
    schemaPatch: (sch) => sch.replace(/"out_of_scope_notes"/g, `"${NEW_NAME}"`),
    run: async (copy) => {
      ok(copy.OUT_OF_SCOPE_NOTES_FIELD === NEW_NAME, '拷贝的常量值应为新名');
      // 构造用新字段名的 verdict（新名承载 note，撞 finding id f1）→ 拷贝的 validateVerdict 必须拦
      const v = verdictWithNotes(null);
      v[NEW_NAME] = [{ id: 'f1', note: '撞号', evidence: '证据', suggested_issue_title: '标题' }];
      const errs = copy.validateVerdict(v);
      ok(errs.some((e) => /与 finding id 撞号/.test(e)),
        '走常量则跟新名 → 撞号必须被拦（若硬读旧名则读 undefined 静默跳过 = B 洞）: ' + JSON.stringify(errs));
    }
  });
});
t('[i9-batch-12e] B 类：validator 跟着常量走——FACES 改 8 面后 8 面 verdict 不被拒（防 FACES.length 漂移）', async () => {
  await withPatchedValidator({
    srcPatch: (src) => src.replace(
      "export const FACES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];",
      "export const FACES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];"
    ),
    schemaPatch: (sch) => sch, // FACES 不在 schema 里（verdict-validate 硬编码数组），schema 不用改
    run: async (copy) => {
      ok(copy.FACES.length === 8, '拷贝的 FACES 应为 8 面');
      // 送 8 面的对抗席 verdict → 若 validator 硬抄 7 则拒（面数≠7 断言失败）；走 FACES.length 跟着变（通过）
      const faces8 = ['A','B','C','D','E','F','G','H'].map((f) => ({ face: f, result: f === 'B' ? 'n_a' : 'pass', evidence: f + '面' }));
      const fd = { id: 'f1', primary_face: 'A', severity: 'major', anchor: FIX1_ANCHOR, anchor_paths: ['src/fix1.ts'], evidence: 'x', invariant: I1, family_id: 'fam-1', status: 'closed' };
      const v = mkVerdictFor('claude-adversarial', mkBundle(L0, L1), [fd], { faces: faces8 });
      const errs = copy.validateVerdict(v);
      ok(!errs.some((e) => /faces 数量/.test(e)),
        'FACES.length 跟着 8 面走 → 不得因「面数≠7」拒（若硬抄 7 则拒 = 漂移）: ' + JSON.stringify(errs));
    }
  });
});

// ========== [i9-batch-13] pr_number PR 身份绑定（R4 修复①，审查席精确形状） ==========
console.log('\n[i9-batch-13] pr_number 跨 PR 张冠李戴被拦（parent 有 PR 号时 ≠ bundle 即拒）');
// 审查席实测形状：bundle A（PR-A, candidate=L1）生成 R1；bundle B（PR-B, candidate=L2，L1 是 L2 祖先、base 相同）
// 拿 A 当 B 的 R2 parent——此前 pass 且 fail_reasons=[]。现在 parent.pr_number=PR-A ≠ bundle.pr_number=PR-B → 拒。
const prASrc = consensusFor(mkBundle(L0, L1, { pr_number: 101 }), [[f1, f2], [f1, f2], [f1, f2]], { repoDir: repo });
ok(prASrc.gate_result === 'pass', '[i9-batch-13] 前提失败: PR-A R1 未 PASS: ' + JSON.stringify(prASrc.fail_reasons ?? []));
t('[i9-batch-13a] 反例：base 相同 + candidate 真祖先 + pr_number 不同 → 拒（张冠李戴）', () => {
  const r2Cross = consensusFor(mkBundle(L0, L2, { pr_number: 202 }), [[], [], []], {
    round: 2, attempt: 1, repoDir: repo,
    gateOpts: { parentArtifact: prASrc, repoDir: repo }
  });
  ok(r2Cross.gate_result === 'fail', '[i9-batch-13a] 跨 PR 的 R2 必须 fail: ' + JSON.stringify(r2Cross.fail_reasons ?? []));
  ok((r2Cross.fail_reasons ?? []).some((e) => /parent artifact pr_number=101 ≠ 当前 bundle\.pr_number=202/.test(e)),
    '必须精确报出 pr_number 不符: ' + JSON.stringify(r2Cross.fail_reasons ?? []));
});
t('[i9-batch-13b] 正例：同 PR（R1=PR-A 101 → R2=PR-A 101）→ 通过', () => {
  const r2Same = consensusFor(mkBundle(L0, L2, { pr_number: 101 }), [[], [], []], {
    round: 2, attempt: 1, repoDir: repo,
    gateOpts: { parentArtifact: prASrc, repoDir: repo }
  });
  ok(r2Same.gate_result === 'pass', '同 PR 的 R2 应 PASS: ' + JSON.stringify(r2Same.fail_reasons ?? []));
});
t('[i9-batch-13c] 合法演进：R1 无 PR（null）→ R2 有 PR（201）→ 通过（不误伤）', () => {
  const r1NoPr = consensusFor(mkBundle(L0, L1), [[f1, f2], [f1, f2], [f1, f2]], { repoDir: repo }); // pr_number=null
  ok(r1NoPr.gate_result === 'pass', '[i9-batch-13c] 前提失败: 无 PR R1 未 PASS: ' + JSON.stringify(r1NoPr.fail_reasons ?? []));
  ok(r1NoPr.pr_number === null, 'R1 无 PR 时 artifact.pr_number 应为 null');
  const r2WithPr = consensusFor(mkBundle(L0, L2, { pr_number: 201 }), [[], [], []], {
    round: 2, attempt: 1, repoDir: repo,
    gateOpts: { parentArtifact: r1NoPr, repoDir: repo }
  });
  ok(r2WithPr.gate_result === 'pass', '无 PR R1 → 有 PR R2 是合法演进，应 PASS: ' + JSON.stringify(r2WithPr.fail_reasons ?? []));
});
t('[i9-batch-13d] 裁决 2 行为钉住：pr_number 不入 review_input_hash（null→N 不改 hash = 建 PR 不成整轮失效触发器）', () => {
  const bNull = mkBundle(L0, L1);                       // pr_number=null（无 PR 直跑）
  const bN = mkBundle(L0, L1, { pr_number: 301 });      // 建了 draft PR 后同 candidate
  eq(computeReviewInputHash(bNull), computeReviewInputHash(bN),
    'pr_number 必须不进 review_input_hash——否则「建 PR」动作让同一 candidate 的 hash 变、三份 verdict 全失效、整轮重跑（裁决 2 防的正是这个）');
  // 但 pr_number 必须烙进 artifact hash（裁决 1：被抓 parent 的 pr_number 改不动、伪造不了自洽）
  const aNull = consensusFor(bNull, [[], [], []], { repoDir: repo });
  const aN = consensusFor(bN, [[], [], []], { repoDir: repo });
  ok(aNull.consensus_artifact_hash !== aN.consensus_artifact_hash,
    'pr_number 必须入 consensus_artifact_hash（null 与 301 的 artifact hash 必须不同）');
});

// ========== [i9-batch-14] 判据④ ARCHIVE 出口（R4 查证+实测定论） ==========
console.log('\n[i9-batch-14] 判据④ ARCHIVE 出口：带 archive SC 放行 / 无出口仍拒');
// 背景：ARCHIVE 的 finding 留在 findings[] 且进终版 canonical（SKILL.md:507），status=closed
// ≠ 不进 canonical。判据④原会拒 → 合法 ARCHIVE 收不了口（洞，R4 实测定论）。修复：④给
// ARCHIVE 留出口，判据三段（SC-T3T4 一致化，2026-08-08）：① finding_ids 指向本族 canonical
// （family_key 匹配，源或终版均可）② SC 在某 wave allocations ③ 该 wave validation.results 含
// {sc_id, status:'PASS'} 逐项证据——结果导向，不是自报「已处置」标志位。
// 构造：终版含 FK1（复发）+ 一个带 FK1 的 archive SC → ④应放行；无该 archive SC → 拒。
const termRecurArch = mkTerminal(L2, [[f1Recur], [f1Recur], [f1Recur]]); // 终版仍含 FK1
if (termRecurArch.gate_result !== 'pass') throw new Error('[i9-batch-14] 前提失败: 复发轮未 PASS: ' + JSON.stringify(termRecurArch.fail_reasons ?? []));
const scManifestWithArchFK1 = {
  ...scManifest,
  scs: [...scManifest.scs, { id: 'SC-ARCH-FK1', kind: 'archive', finding_ids: [cF1.id], invariant: I1, family_key: FK1, change: '登记 FK1 残余', holds: 'README 含 FK1 文案', verify: { cmd: 'grep', args: ['-q', 'FK1', 'README.md'] } }]
};
t('[i9-batch-14a] 冻结 family 被 ARCHIVE 处置（终版有该族 + 带 archive SC 且有 PASS 台账记录）→ 判据④放行（出口生效）', () => {
  // 2026-08-07 收紧（集成审查）+ 2026-08-08 一致化（SC-T3T4）+ FIX-2 措辞降级：出口判据三段——
  // 该 archive SC 的 finding_ids 指向本族 canonical + 出现在某 wave allocations + 该 wave
  // validation.results 含 {sc_id, status:'PASS'} 逐项记录（台账记录非执行证明，不依赖
  // validation.ok 自报摘要；空 results 上 every 恒 true）。
  // 构造：recurRunManifest 的 wave0 加 SC-ARCH-FK1 的 allocation + results 逐项 PASS。
  const executedRunManifest = {
    ...recurRunManifest,
    waves: (recurRunManifest.waves ?? []).map((w, i) => (i === 0
      ? { ...w, allocations: [{ group_id: 'arch', sc_ids: ['SC-ARCH-FK1'], worktree: '/x', anchor_paths: ['README.md'] }], validation: { at: 't', ok: true, results: [{ sc_id: 'SC-ARCH-FK1', status: 'PASS' }] } }
      : w))
  };
  const errs = checkBatchClosure({ runManifest: executedRunManifest, sourceArtifact: srcArtifact, finalArtifact: termRecurArch, scManifest: scManifestWithArchFK1 });
  ok(!errs.some((e) => /同族复发/.test(e)), '带 FK1 的 archive SC 且有 PASS 台账记录 → FK1 复发应被出口放行: ' + JSON.stringify(errs));
  // 反向：archive SC 存在但未出现在任何 wave allocations（无分配台账）→ 出口不成立，仍拒
  const notExecuted = { ...recurRunManifest, waves: (recurRunManifest.waves ?? []).map((w) => ({ ...w, allocations: [], validation: { at: 't', ok: true, results: [] } })) };
  const errsNotExec = checkBatchClosure({ runManifest: notExecuted, sourceArtifact: srcArtifact, finalArtifact: termRecurArch, scManifest: scManifestWithArchFK1 });
  ok(errsNotExec.some((e) => /同族复发/.test(e)), 'archive SC 无 PASS 台账记录（allocations 空）→ 出口不成立，仍拒: ' + JSON.stringify(errsNotExec));
  // 2026-08-07 复核 major 负例①：validation {ok:true, results:[]}（空 results——fix-run:643 的
  // results.every 空数组恒 true，ok:true 是自报摘要）→ 该 archive SC 无 PASS 台账记录 → 出口不成立
  const emptyResults = { ...recurRunManifest, waves: (recurRunManifest.waves ?? []).map((w, i) => (i === 0
    ? { ...w, allocations: [{ group_id: 'arch', sc_ids: ['SC-ARCH-FK1'], worktree: '/x', anchor_paths: ['README.md'] }], validation: { at: 't', ok: true, results: [] } }
    : w)) };
  const errsEmpty = checkBatchClosure({ runManifest: emptyResults, sourceArtifact: srcArtifact, finalArtifact: termRecurArch, scManifest: scManifestWithArchFK1 });
  ok(errsEmpty.some((e) => /同族复发/.test(e)), 'validation {ok:true, results:[]}（空 results 无逐项证据）→ 出口不成立，仍拒: ' + JSON.stringify(errsEmpty));
  // 负例②：results 含该 SC 但 status=FAIL → 逐项证据不通过 → 出口不成立
  const failResult = { ...recurRunManifest, waves: (recurRunManifest.waves ?? []).map((w, i) => (i === 0
    ? { ...w, allocations: [{ group_id: 'arch', sc_ids: ['SC-ARCH-FK1'], worktree: '/x', anchor_paths: ['README.md'] }], validation: { at: 't', ok: true, results: [{ sc_id: 'SC-ARCH-FK1', status: 'FAIL' }] } }
    : w)) };
  const errsFail = checkBatchClosure({ runManifest: failResult, sourceArtifact: srcArtifact, finalArtifact: termRecurArch, scManifest: scManifestWithArchFK1 });
  ok(errsFail.some((e) => /同族复发/.test(e)), 'results 含该 SC 但 status=FAIL → 出口不成立，仍拒: ' + JSON.stringify(errsFail));
});
t('[i9-batch-14b] 无该族 archive SC（终版有该族）→ 判据④仍拒（出口三条件之一的必要条件缺失，故必拒）', () => {
  const errs = checkBatchClosure({ runManifest: recurRunManifest, sourceArtifact: srcArtifact, finalArtifact: termRecurArch, scManifest });
  ok(errs.some((e) => /同族复发/.test(e)), 'FK1 复发但无 FK1 的 archive SC → 必须仍拒: ' + JSON.stringify(errs));
});

// ========== [i9-batch-6] 批次严格后代语义（lead 撤回「直接后继」后） ==========
console.log('\n[i9-batch-6] 批次严格后代：多 commit 合法 / 非后代拒 / 零推进拒');
// 再产出一个 commit L3（L1→L2→L3），把 L3 当 final candidate
writeFileSync(join(repo, 'src/fix2.ts'), 'export const fix2 = 2;\n');
g('add', '.'); g('commit', '-qm', 'L3 额外 commit（多 commit 分步修复场景）');
const L3 = g('rev-parse', 'HEAD');
const termTwoStep = mkTerminal(L3, [[], [], []]);
if (termTwoStep.gate_result !== 'pass') throw new Error('[i9-batch-6] 前提失败: L3 轮未 PASS: ' + JSON.stringify(termTwoStep.fail_reasons ?? []));
const twoStepRunManifest = mkRunManifest({
  waves: [
    { wave_index: 0, base: L1, worktree_root: '/x', allocations: [], tips: [{ group_id: 'g1', tip: L2 }], integrated_tip: L2, replan: null, validation: { at: 't', ok: true, results: [] }, squash_commits: [L2] },
    { wave_index: 1, base: L2, worktree_root: '/x', allocations: [], tips: [{ group_id: 'a1', tip: L3 }], integrated_tip: L3, replan: null, validation: { at: 't', ok: true, results: [] }, squash_commits: [L3] }
  ],
  final_candidate: L3,
  batch: { batch_id: 'b1', frozen_at_sha: L1, frozen_families: [FK1, FK2].sort(), successor_sha: L3, status: 'closed' }
});
function pgCallWith(runManifest, expectedSha, terminal, branch = 'feat') {
  const fo = {
    source_artifact_hash: recomputeArtifactHash(srcArtifact),
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: runManifestHash(runManifest)
  };
  return checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch, expected_sha: expectedSha, purpose: 'feature', consensus_artifact_hash: terminal.consensus_artifact_hash, fix_orchestration: fo },
    artifact: terminal, bundle: mkBundle(L0, expectedSha), constitution,
    sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest
  });
}
// 本条只验合法多 commit 放行（lead 2026-08-07 撤回「直接后继」后的正确语义）。
// 非后代的负例不在此处：完整链上「expected_sha 绑定」+「SC-3 终版 artifact 的 parent 祖先
// 绑定」曾声明 by construction 保证终版 candidate 是 source_candidate 的严格后代——但
// 2026-08-07 集成审查席构造出兄弟提交反例推翻该声明（见下方 [i9-batch-6c]），守卫已恢复，
// 负例在此处独立构造。
t('[i9-batch-6a] L1..L3 两个 commit（多 commit 分步修复）→ 批次校验通过（严格后代，任意距离）', () => {
  const r = pgCallWith(twoStepRunManifest, L3, termTwoStep);
  eq(r.errors, [], '多 commit（L1..L3）应整体放行（正例必须验整体通过，不能只查「无批次类报错」——别的门失败照绿 = 弱断言）: ' + JSON.stringify(r.errors));
});
t('[i9-batch-6c] 兄弟提交（共同 base B、source S=B+X、兄弟 T=B+Y）→ 严格后代拒（rev-list 非空 ≠ 祖先，集合一致性双向通过也拦不住）', async () => {
  // 审查席构造的失效路径：共同 base B、source S=B+X、兄弟 T=B+Y——rev-list S..T 返回 {Y} 非空、
  // Y 已登记时集合一致检查双向通过，但 S 不是 T 的祖先。构造：T 从 L1 分叉（sibling 分支）加 Y，
  // 伪造自洽终版 artifact（candidate=T、parent=srcArtifact hash）+ run manifest（source=L1、
  // final=T、T 登记为 squash）+ expected_sha=T → 只有严格后代检查（is-ancestor + 不等）能拦。
  // 审查席场景：source S=B+X、兄弟 T=B+Y（互不为祖先）。本仓 L0 是 base B，L1=S=B+X（已含，
  // 是 srcArtifact.candidate），T 从 L0 分叉加 Y——L1 与 T 是兄弟（共同 base L0，互不为祖先）。
  // rev-list L1..T = {T} 非空且 T 已登记 → 集合一致性双向通过；只有严格后代检查
  // （is-ancestor(L1,T)=false）能拦。source_candidate=L1 与 srcArtifact.candidate_sha 一致，
  // 不触发起点漂移。
  const branchName = 'sibling-scd';
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', branchName, L0]); // T 从 L0（base）分叉
  mkdirSync(join(repo, 'src'), { recursive: true }); // L0 分支没有 src/（src 是 L1 建的）
  writeFileSync(join(repo, 'src/sibling.ts'), 'export const sibling = 1;\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'T 兄弟提交（B+Y，与 S=B+X 互不为祖先）']);
  const T = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // 留在 sibling 分支（HEAD=T）：push-guard 的 SHA 绑定要求 HEAD == expected_sha，若切回 feat
  // HEAD=L3 ≠ expected=T 会先报 SHA 漂移、测不到严格后代检查。分支名传 sibling-scd。
  // 伪造自洽终版 artifact（candidate=T、parent=srcArtifact hash——SC-3 会过因为 parent hash 对；
  // review_input_hash 也要改成 T 对应的值，否则 bundle 重算的 review_input_hash ≠ artifact 记录值
  // 会先报、测不到严格后代检查）
  const forgedTerminal = { ...termEmpty, candidate_sha: T, review_input_hash: computeReviewInputHash(mkBundle(L0, T)), parent_artifact_hash: recomputeArtifactHash(srcArtifact) };
  forgedTerminal.consensus_artifact_hash = recomputeArtifactHash(forgedTerminal);
  // 2 波（与 plan 波数一致，避免「波数 ≠ plan」先拦、测不到严格后代）：
  // wave0 base=L1 集成 T（兄弟提交），wave1 base=T 空波（无新修复）
  const siblingRunManifest = mkRunManifest({
    waves: [
      { wave_index: 0, base: L1, worktree_root: '/x', allocations: [], tips: [{ group_id: 'g1', tip: T }], integrated_tip: T, replan: null, validation: { at: 't', ok: true, results: [] }, squash_commits: [T] },
      { wave_index: 1, base: T, worktree_root: '/x', allocations: [], tips: [{ group_id: 'a1', tip: T }], integrated_tip: T, replan: null, validation: { at: 't', ok: true, results: [] }, squash_commits: [T] }
    ],
    final_candidate: T,
    batch: { batch_id: 'b1', frozen_at_sha: L1, frozen_families: [FK1, FK2].sort(), successor_sha: T, status: 'closed' }
  });
  const r = pgCallWith(siblingRunManifest, T, forgedTerminal, branchName);
  ok(r.errors.some((e) => /严格后代|祖先后代/.test(e)),
    '兄弟提交必须被严格后代检查拒（rev-list S..T 非空 ≠ 祖先，集合一致性拦不住）: ' + JSON.stringify(r.errors));
  execFileSync('git', ['-C', repo, 'checkout', '-q', 'feat']); // 切回 feat（后续测试依赖 L3 为 HEAD）
  execFileSync('git', ['-C', repo, 'reset', '--hard', '-q', L3]); // 保险：确保 HEAD=L3（防 sibling 分支 checkout 污染）
  // 常驻反向变异（审查席验证覆盖空白，2026-08-07）：把 push-guard 的 :411 isAncestorCommit 调用
  // 挖掉后，同一兄弟提交场景必须**放行**——证明 6c 是有效检测器（该检查一旦消失，兄弟提交就
  // 通过）。临时副本在 scripts/ 下（保留相对 import），用完 finally 清理；push-guard.mjs 本体不动。
  {
    const { readFileSync: rf, writeFileSync: wf, rmSync: rm } = await import('node:fs');
    const pgSrc = rf(join(S, 'push-guard.mjs'), 'utf8');
    const ancestryCall = 'isStrict = isAncestorCommit({ repoDir, ancestorSha: runManifest.source_candidate, descendantSha: finalTip });';
    ok(pgSrc.includes(ancestryCall), '前置: push-guard 源码须含 isAncestorCommit 调用（探针按此定位变异点）');
    // 挖空 = 让 isStrict 恒 true（「是祖先」→ 不报错 → 放行）——证明检查一旦消失兄弟提交即通过。
    // 若恒 false 则检查恒报「不是祖先」= 还在拦，测不到「消失后放行」。
    const patched = pgSrc.replace(ancestryCall, 'isStrict = true; // MUTATION: ancestry 检查挖空（常驻反向变异，证明 6c 有效）');
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pgCopy = join(S, `.i9-batch-pg-copy-${uid}.mjs`);
    wf(pgCopy, patched);
    try {
      const copy = await import('file://' + pgCopy + '?t=' + Date.now());
      const foNoAnc = {
        source_artifact_hash: recomputeArtifactHash(srcArtifact),
        sc_manifest_hash: hashObject(scManifest),
        fix_plan_hash: plan.fix_plan_hash,
        dispatch_record_hash: hashObject(dispatchRecord),
        run_manifest_hash: runManifestHash(siblingRunManifest)
      };
      execFileSync('git', ['-C', repo, 'checkout', '-q', branchName]); // 切到 sibling 分支（HEAD=T，SHA 绑定要求 HEAD == expected_sha）
      let rNoAnc;
      try {
        rNoAnc = copy.checkPushGuard({
          repoDir: repo,
          manifest: { repo: 'o/r', remote: 'origin', branch: branchName, expected_sha: T, purpose: 'feature', consensus_artifact_hash: forgedTerminal.consensus_artifact_hash, fix_orchestration: foNoAnc },
          artifact: forgedTerminal, bundle: mkBundle(L0, T), constitution,
          sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: siblingRunManifest
        });
      } finally {
        execFileSync('git', ['-C', repo, 'checkout', '-q', 'feat']); // 切回 feat（后续测试依赖）
        execFileSync('git', ['-C', repo, 'reset', '--hard', '-q', L3]);
      }
      ok(rNoAnc.errors.length === 0,
        '常驻反向变异: isAncestorCommit 被挖空后兄弟提交必须放行（证明 [i9-batch-6c] 是有效检测器——该检查一旦消失，兄弟提交即通过）: ' + JSON.stringify(rNoAnc.errors));
    } finally {
      rm(pgCopy, { force: true });
    }
  }
  // 反向变异见上方常驻测试（2026-08-07，审查席验证覆盖空白）：挖空 push-guard 的
  // isAncestorCommit（临时副本）后兄弟提交会放行，证明本用例是有效检测器——树内有执行证据，
  // 不是「开发期手工做过一次」的聊天记录声明。
});
t('[i9-batch-6d] pr_number 绑定：bundle.pr_number ≠ artifact.pr_number → 拒（同 candidate 自洽拼接被拦）', () => {
  // 同 candidate 的 artifact(pr=101) 与 bundle(pr=202) 可自洽拼接（不经 runConsensusGate 产出）
  // ——push-guard 三方绑定此前只比 review_input_hash/base/candidate，不比 pr_number。
  const art101 = { ...termTwoStep, pr_number: 101 };
  art101.consensus_artifact_hash = recomputeArtifactHash(art101);
  const b202 = mkBundle(L0, L3, { pr_number: 202 });
  const fo202 = {
    source_artifact_hash: recomputeArtifactHash(srcArtifact),
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: runManifestHash(twoStepRunManifest)
  };
  const r = checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: L3, purpose: 'feature', consensus_artifact_hash: art101.consensus_artifact_hash, fix_orchestration: fo202 },
    artifact: art101, bundle: b202, constitution,
    sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: twoStepRunManifest
  });
  ok(r.errors.some((e) => /pr_number/.test(e) && /101.*202|202.*101/.test(e)),
    'pr_number 不匹配必须拒（artifact=101 bundle=202）: ' + JSON.stringify(r.errors));
  // 反向：两边都 null（无 PR 直跑三审）→ 放行
  const artNull = { ...termTwoStep, pr_number: null };
  artNull.consensus_artifact_hash = recomputeArtifactHash(artNull);
  const bNull = mkBundle(L0, L3, { pr_number: null });
  const foNull = { ...fo202, run_manifest_hash: runManifestHash(twoStepRunManifest) };
  const rNull = checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: L3, purpose: 'feature', consensus_artifact_hash: artNull.consensus_artifact_hash, fix_orchestration: foNull },
    artifact: artNull, bundle: bNull, constitution,
    sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: twoStepRunManifest
  });
  eq(rNull.errors, [], '两边 null（无 PR 直跑）应整体放行（正例必须验整体通过，不能只查「无 pr_number 报错」——别的门失败照绿 = 弱断言）: ' + JSON.stringify(rNull.errors));
});
t('[i9-batch-6e] run manifest 版本比较：schema_version 不符 → 拒（旧 v2 按当前公式重算 hash 仍过）', () => {
  // 2026-08-07 修正（失败模式隔离）：staleRm 必须**无 batch 段**——若带 batch，checkBatchClosure
  // 的 :61-62 也有 RUN_MANIFEST_SCHEMA_VERSION 比较，会把 v2 拦下、掩盖 push-guard 版本比较
  // 被挖空的变异（6e 断言的是 push-guard 的 :327，不是闭合门的）。去掉 batch 段后，只有
  // push-guard 版本比较能拦，变异 C（挖空 :327）实测使 6e 变红（开发期手工验证，记录见 lead 报告）；
  // 本树无该条的常驻反向测试。
  const staleRm = { ...twoStepRunManifest, schema_version: 'v2', batch: undefined }; // 旧版 run manifest（hash 自洽，无 batch）
  const foStale = {
    source_artifact_hash: recomputeArtifactHash(srcArtifact),
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: runManifestHash(staleRm)
  };
  const r = checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: L3, purpose: 'feature', consensus_artifact_hash: termTwoStep.consensus_artifact_hash, fix_orchestration: foStale },
    artifact: termTwoStep, bundle: mkBundle(L0, L3), constitution,
    sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: staleRm
  });
  ok(r.errors.some((e) => /schema_version/.test(e) && /run manifest/.test(e)),
    '旧 v2 run manifest 必须被版本比较拒（hash 自洽挡不住）: ' + JSON.stringify(r.errors));
  // 2026-08-07（lead 补充派工）：缺该字段同样必须拒——`v:` 是常量 tag 不绑 m.schema_version，
  // 缺字段重算 hash 仍自洽，只有显式比较能拦。构造缺 schema_version 的 run manifest（无 batch）。
  const missingVer = { ...twoStepRunManifest, batch: undefined };
  delete missingVer.schema_version;
  const foMissing = {
    source_artifact_hash: recomputeArtifactHash(srcArtifact),
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: runManifestHash(missingVer)
  };
  const rMissing = checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: L3, purpose: 'feature', consensus_artifact_hash: termTwoStep.consensus_artifact_hash, fix_orchestration: foMissing },
    artifact: termTwoStep, bundle: mkBundle(L0, L3), constitution,
    sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: missingVer
  });
  ok(rMissing.errors.some((e) => /schema_version/.test(e) && /run manifest/.test(e)),
    '缺 schema_version 字段的 run manifest 必须被版本比较拒（hash 自洽挡不住）: ' + JSON.stringify(rMissing.errors));
});

// ===== 版本字面量自检（2026-08-07）=====
t('[版本字面量] 本文件 verdict 构造须用 SCHEMA_VERSION 派生、run manifest 构造须用 RUN_MANIFEST_SCHEMA_VERSION 派生，不得残留两条线字面量（照 [SC-12] 写法）', () => {
  const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  ok(/schema_version: SCHEMA_VERSION, reviewer/.test(own), '本文件 verdict 构造必须用 SCHEMA_VERSION 派生常量');
  ok(/schema_version: RUN_MANIFEST_SCHEMA_VERSION, run_id/.test(own), '本文件 run manifest 构造必须用 RUN_MANIFEST_SCHEMA_VERSION 派生常量');
  // 反向: 两种签名都不得残留字面量（正则拼接构造防自引用）
  const vLit = "schema_version: 'v" + "[0-9]', reviewer";
  const rmLit = "schema_version: 'v" + "[0-9]', run_id";
  ok(!new RegExp(vLit).test(own), '本文件不得残留 verdict schema_version 字面量（须用 SCHEMA_VERSION 派生）');
  ok(!new RegExp(rmLit).test(own), '本文件不得残留 run manifest schema_version 字面量（须用 RUN_MANIFEST_SCHEMA_VERSION 派生）');
});

// ========== [SC-T1a] init CLI --batch opt-in（2026-08-08 派工） ==========
console.log('\n[SC-T1a] init CLI --batch opt-in：显式传才生效 / 坏输入 fail-closed / 非 batch 对照组');
function cliInit(batchJson, { expectFail = false } = {}) {
  // 真实 CLI：写 plan/sc-manifest/source-artifact 临时 JSON，execFileSync node fix-run.mjs init
  const dT1 = mkdtempSync(join(tmpdir(), 't1a-'));
  const stateDir = join(dT1, 'state'); mkdirSync(stateDir, { recursive: true });
  const writeJson = (name, obj) => { const p = join(dT1, name); writeFileSync(p, JSON.stringify(obj)); return p; };
  const planP = writeJson('plan.json', plan);
  const scmP = writeJson('scm.json', scManifest);
  const srcP = writeJson('src.json', srcArtifact);
  const argv = ['--state-dir', stateDir, '--run-id', 't1a-run', '--repo-dir', repo, '--plan', planP, '--sc-manifest', scmP, '--source-artifact', srcP];
  if (batchJson !== undefined) argv.push('--batch', batchJson);
  try {
    const out = execFileSync('node', [join(S, 'fix-run.mjs'), 'init', ...argv], { encoding: 'utf8' });
    return { ok: true, out, stateDir };
  } catch (e) {
    if (!expectFail) throw e;
    return { ok: false, err: String(e.stderr ?? e.message) };
  }
}
t('[SC-T1a-1] CLI init --batch 正常：manifest 带 batch 字段 + run-init 事件带 batch + stdout schema 不变', () => {
  const r = cliInit(JSON.stringify({ batch_id: 't1a-b', frozen_families: [FK1, FK2].sort() }));
  ok(r.ok, 'CLI init 应成功');
  const parsed = JSON.parse(r.out);
  eq(JSON.stringify(Object.keys(parsed).sort()), JSON.stringify(['ok', 'run_id', 'source_candidate'].sort()), 'stdout schema 必须不变（ok/run_id/source_candidate）');
  const m = readJson(join(r.stateDir, 'run-t1a-run.json'));
  ok(m.batch && m.batch.batch_id === 't1a-b' && m.batch.status === 'open', 'manifest 必须带 batch 字段（status=open 未收口）');
  ok(m.events.some((e) => e.kind === 'run-init' && e.batch_id === 't1a-b' && e.frozen_families === 2), 'run-init 事件必须带 batch 字段（扁平 batch_id + frozen_families 数）');
});
t('[SC-T1a-2] CLI init --batch 坏输入逐项 fail-closed：JSON 解析失败 / 非对象 / frozen_families 缺失 / 空 / 未知键', () => {
  const badInputs = [
    { json: '{bad json', why: 'JSON 解析失败' },
    { json: JSON.stringify([]), why: '非对象（数组）' },
    { json: JSON.stringify({ batch_id: 'b' }), why: 'frozen_families 缺失' },
    { json: JSON.stringify({ batch_id: 'b', frozen_families: [] }), why: 'frozen_families 空' },
    { json: JSON.stringify({ batch_id: 'b', frozen_families: [FK1], unknown_key: 1 }), why: '未知键' }
  ];
  for (const bi of badInputs) {
    const r = cliInit(bi.json, { expectFail: true });
    ok(!r.ok, `${bi.why} 必须 fail-closed: ${bi.json}`);
  }
});
t('[SC-T1a-3] 非 batch 对照组：不传 --batch → manifest 无 batch 字段、run-init 事件无 batch、stdout 不变', () => {
  const r = cliInit(undefined);
  ok(r.ok, '不传 --batch 应成功');
  const parsed = JSON.parse(r.out);
  eq(JSON.stringify(Object.keys(parsed).sort()), JSON.stringify(['ok', 'run_id', 'source_candidate'].sort()), 'stdout schema 不变');
  const m = readJson(join(r.stateDir, 'run-t1a-run.json'));
  ok(!('batch' in m), 'manifest 必须无 batch 字段（opt-in 未传 = 两道门整体跳过）');
  ok(!m.events.some((e) => e.kind === 'run-init' && e.batch), 'run-init 事件必须无 batch 字段');
});

// ========== [SC-T1b] 真实 CLI 全链负例（2026-08-08 派工） ==========
console.log('\n[SC-T1b] 真实 CLI 全链：init --batch → allocate → integrate → validate → finalize → push-guard');
function cliRun(...a) {
  try { return execFileSync('node', [join(S, 'fix-run.mjs'), ...a], { encoding: 'utf8' }); }
  catch (e) { throw new Error(`fix-run CLI 失败 (${a[0]}): stderr=${JSON.stringify(String(e.stderr ?? ''))} stdout=${JSON.stringify(String(e.stdout ?? ''))}`); }
}
function cliPg(...a) {
  try { return execFileSync('node', [join(S, 'push-guard.mjs'), ...a], { encoding: 'utf8' }); }
  catch (e) { throw new Error(`push-guard CLI 失败: ${String(e.stderr ?? e.message).slice(0, 400)}`); }
}
// CLI 全链 helper：init --batch → 遍历 plan.waves 逐波 allocate→integrate→validate → 最后一波完成后 finalize
// 返回 { stateDir, runManifest, finalCandidate }；worktree 写文件由调用方提供 fn(wt)
function cliFullChain(batchJson, { wtWrite, expectInitOk = true, initCliPath = null } = {}) {
  const dTb = mkdtempSync(join(tmpdir(), 't1b-'));
  const stateDir = join(dTb, 'state'); mkdirSync(stateDir, { recursive: true });
  const wtRoot = join(dTb, 'wt'); mkdirSync(wtRoot, { recursive: true });
  // runId 唯一（共享 repo：allocateWave 的 worktree 分支名 fix/<runId>/<group> 撞名会 fail-closed）
  const runId = `t1b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const writeJson = (name, obj) => { const p = join(dTb, name); writeFileSync(p, JSON.stringify(obj)); return p; };
  const planP = writeJson('plan.json', plan);
  const scmP = writeJson('scm.json', scManifest);
  const srcP = writeJson('src.json', srcArtifact);
  // feature-branch 唯一（finalize 对 feature branch ff-only 前推——共享 repo 的 feat 已被
  // 既有测试推进到 L3，用共享名会因分叉 ff-only 失败）
  const featBranch = `feat-${runId}`;
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', featBranch, L1]);
  const initArgv = ['init', '--state-dir', stateDir, '--run-id', runId, '--repo-dir', repo, '--plan', planP, '--sc-manifest', scmP, '--source-artifact', srcP, '--feature-branch', featBranch];
  if (batchJson !== undefined) initArgv.push('--batch', batchJson);
  if (initCliPath) execFileSync('node', [initCliPath, ...initArgv], { encoding: 'utf8' });
  else cliRun(...initArgv);
  // FIX-1（2026-08-08）：遍历 plan.waves 逐波 allocate→integrate→validate（此前只跑 wave 0，
  // 导致 push-guard 报「run manifest 波数 1 ≠ plan 波数 2」混入非目标错误）。最后一波完成后才 finalize。
  for (let wi = 0; wi < plan.waves.length; wi++) {
    const allocOut = JSON.parse(cliRun('allocate', '--state-dir', stateDir, '--run-id', runId, '--plan', planP, '--wave', String(wi), '--worktree-root', wtRoot, '--artifact', srcP, '--sc-manifest', scmP));
    for (const a of allocOut.allocations) {
      for (const f of a.anchor_paths ?? []) {
        mkdirSync(dirname(join(a.worktree, f)), { recursive: true });
        if (wtWrite) wtWrite(join(a.worktree, f), a);
        else writeFileSync(join(a.worktree, f), f.includes('fix1') ? 'cancel 保护已加\n' : (f.includes('README') ? '残余 风险已登记\n' : 'fixed\n'));
      }
      execFileSync('git', ['-C', a.worktree, 'add', '.']);
      execFileSync('git', ['-C', a.worktree, 'commit', '-qm', `fix ${a.group_id}`]);
    }
    const intOut = JSON.parse(cliRun('integrate', '--state-dir', stateDir, '--run-id', runId, '--plan', planP, '--wave', String(wi)));
    if (!intOut.ok) throw new Error(`integrate wave${wi} 失败: ` + JSON.stringify(intOut.errors));
    const valOut = JSON.parse(cliRun('validate', '--state-dir', stateDir, '--run-id', runId, '--sc-manifest', scmP, '--wave', String(wi)));
    if (!valOut.ok) throw new Error(`validate wave${wi} 失败: ` + JSON.stringify(valOut.results));
  }
  const finOut = JSON.parse(cliRun('finalize', '--state-dir', stateDir, '--run-id', runId));
  const runManifest = readJson(join(stateDir, `run-${runId}.json`));
  return { stateDir, runManifest, finalCandidate: finOut.final_candidate, wtRoot, dTb, featBranch, runId };
}
t('[SC-T1b-closure] 真实 CLI 全链（init --batch → allocate → integrate → validate → finalize → push-guard）：同族复发负例 → push-guard 错误文本含「批次闭合门」', () => {
  // 冻结 FK1/FK2；终版 consensus 用 termRecur（含 FK1 复发）→ 闭合门判据④拒 → push-guard 必须报「批次闭合门」
  const { runManifest, finalCandidate, dTb, featBranch } = cliFullChain(JSON.stringify({ batch_id: 't1b-b', frozen_families: [FK1, FK2].sort() }));
  const writeJson = (name, obj) => { const p = join(dTb, name); writeFileSync(p, JSON.stringify(obj)); return p; };
  // 终版 consensus 用 termRecur（含 FK1 复发）改造为匹配 finalCandidate：
  // candidate_sha/review_input_hash/parent 都对 finalCandidate——canonical_findings 仍含 FK1（复发）
  const forgedRecur = { ...termRecur, candidate_sha: finalCandidate, review_input_hash: computeReviewInputHash(mkBundle(L0, finalCandidate)), parent_artifact_hash: recomputeArtifactHash(srcArtifact) };
  forgedRecur.consensus_artifact_hash = recomputeArtifactHash(forgedRecur);
  const termRecurJson = writeJson('term-recur.json', forgedRecur);
  const bundleJson = writeJson('bundle.json', mkBundle(L0, finalCandidate));
  const srcJson = writeJson('src.json', srcArtifact);
  const scmJson = writeJson('scm.json', scManifest);
  const planJson = writeJson('plan.json', plan);
  const recJson = writeJson('rec.json', dispatchRecord);
  const rmJson = writeJson('rm.json', runManifest);
  const fo = {
    source_artifact_hash: recomputeArtifactHash(srcArtifact),
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: runManifestHash(runManifest)
  };
  const mJson = writeJson('m.json', { repo: 'o/r', remote: 'origin', branch: featBranch, expected_sha: finalCandidate, purpose: 'feature', consensus_artifact_hash: forgedRecur.consensus_artifact_hash, fix_orchestration: fo });
  let pgOut = '';
  let pgCode = 0;
  try { pgOut = cliPg('--repo-dir', repo, '--manifest', mJson, '--artifact', termRecurJson, '--bundle', bundleJson, '--source-artifact', srcJson, '--sc-manifest', scmJson, '--fix-plan', planJson, '--dispatch-record', recJson, '--run-manifest', rmJson); }
  catch (e) { pgCode = e.status ?? 1; pgOut = String(e.stderr ?? e.message); }
  ok(pgCode !== 0, 'push-guard 必须非零退出（同族复发被拒）');
  ok(pgOut.includes('批次闭合门'), '错误文本必须含「批次闭合门」（绑定到该门自己的消息）: ' + pgOut.slice(0, 300));
});
t('[SC-T1b-ancestry] 隔离副本 sibling 提交场景（manifest 由真实 CLI init 产出后在隔离路径改造）→ 严格后代门自己的错误消息', () => {
  // CLI init 产出 run manifest（带 batch——严格后代检查在 push-guard 的 batch 段内，无 batch 不触发）；
  // 隔离路径：T 从 L0 分叉（兄弟），run manifest 的 source_candidate 保持 L1（=srcArtifact.candidate），
  // final_candidate 改为 T——sibling 不能经正常 integrate 链到达（fix-run 血统检查先拒），
  // 故在隔离路径改造 manifest 后直调 push-guard。
  const { runManifest, dTb } = cliFullChain(JSON.stringify({ batch_id: 't1b-anc', frozen_families: [FK1, FK2].sort() }));
  const branchName = 'sibling-t1b';
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', branchName, L0]);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/sib.ts'), 'sib\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'T sibling']);
  const T = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // 隔离改造：run manifest 的 final_candidate → T，waves 相应改（T 登记为 squash），
  // 源 artifact candidate 保持 L1（兄弟提交 rev-list L1..T={T} 非空但 L1 非 T 祖先）
  const forgedRm = { ...runManifest, final_candidate: T, waves: [{ wave_index: 0, base: L1, worktree_root: '/x', allocations: [], tips: [{ group_id: 'g1', tip: T }], integrated_tip: T, replan: null, validation: { at: 't', ok: true, results: [{ sc_id: 'SC-1', status: 'PASS' }] }, squash_commits: [T] }, { wave_index: 1, base: T, worktree_root: '/x', allocations: [], tips: [{ group_id: 'a1', tip: T }], integrated_tip: T, replan: null, validation: { at: 't', ok: true, results: [{ sc_id: 'SC-2', status: 'PASS' }] }, squash_commits: [T] }] };
  // 伪造自洽终版 artifact（candidate=T、parent=srcArtifact hash、review_input_hash 对应 T）
  const forgedTerminal = { ...termEmpty, candidate_sha: T, review_input_hash: computeReviewInputHash(mkBundle(L0, T)), parent_artifact_hash: recomputeArtifactHash(srcArtifact) };
  forgedTerminal.consensus_artifact_hash = recomputeArtifactHash(forgedTerminal);
  const writeJson = (name, obj) => { const p = join(dTb, name); writeFileSync(p, JSON.stringify(obj)); return p; };
  const rmJson = writeJson('rm-sib.json', forgedRm);
  const termJson = writeJson('term-sib.json', forgedTerminal);
  const bundleJson = writeJson('bundle-sib.json', mkBundle(L0, T));
  const srcJson = writeJson('src-sib.json', srcArtifact);
  const scmJson = writeJson('scm-sib.json', scManifest);
  const planJson = writeJson('plan-sib.json', plan);
  const recJson = writeJson('rec-sib.json', dispatchRecord);
  const fo = {
    source_artifact_hash: recomputeArtifactHash(srcArtifact),
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: runManifestHash(forgedRm)
  };
  const mJson = writeJson('m-sib.json', { repo: 'o/r', remote: 'origin', branch: branchName, expected_sha: T, purpose: 'feature', consensus_artifact_hash: forgedTerminal.consensus_artifact_hash, fix_orchestration: fo });
  let pgOut = '';
  let pgCode = 0;
  try { pgOut = cliPg('--repo-dir', repo, '--manifest', mJson, '--artifact', termJson, '--bundle', bundleJson, '--source-artifact', srcJson, '--sc-manifest', scmJson, '--fix-plan', planJson, '--dispatch-record', recJson, '--run-manifest', rmJson); }
  catch (e) { pgCode = e.status ?? 1; pgOut = String(e.stderr ?? e.message); }
  ok(pgCode !== 0, 'push-guard 必须非零退出（兄弟提交被拒）');
  ok(pgOut.includes('严格后代') || pgOut.includes('祖先后代'), '必须报严格后代门自己的错误消息: ' + pgOut.slice(0, 300));
  execFileSync('git', ['-C', repo, 'checkout', '-q', 'feat']);
  execFileSync('git', ['-C', repo, 'reset', '--hard', '-q', L3]);
});

// ========== [SC-T1c] 两条反向变异各带控制组（2026-08-08 派工） ==========
console.log('\n[SC-T1c] 反向变异：变异 A 挖 CLI --batch 透传 / 变异 B 6c 常驻确认仍绿');
t('[SC-T1c-A] 变异 A：temp-copy 挖掉 CLI --batch 透传 → closure 复发负例 errors 不再含「批次闭合门」（控制组：未变异时含）', async () => {
  const { readFileSync: rf, writeFileSync: wf, rmSync: rm } = await import('node:fs');
  const frSrc = rf(join(S, 'fix-run.mjs'), 'utf8');
  const batchLine = "batch: batchArg });";
  ok(frSrc.includes(batchLine), '前置: fix-run CLI init 须含 batch 透传（探针按此定位变异点）');
  const patched = frSrc.replace(batchLine, 'batch: undefined }); // MUTATION: CLI --batch 透传挖空（SC-T1c 变异 A）');
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const frCopy = join(S, `.i9-batch-fr-copy-${uid}.mjs`);
  wf(frCopy, patched);
  try {
    // 变异 A 组：副本 init（--batch 被忽略）→ 原 CLI 全链余下 → push-guard errors 不含「批次闭合门」
    const { runManifest: rmMut, finalCandidate: fcMut, dTb: dMut, featBranch: fbMut } = cliFullChain(JSON.stringify({ batch_id: 't1c-m', frozen_families: [FK1, FK2].sort() }), { initCliPath: frCopy });
    const wj = (name, obj) => { const p = join(dMut, name); writeFileSync(p, JSON.stringify(obj)); return p; };
    const forgedMut = { ...termRecur, candidate_sha: fcMut, review_input_hash: computeReviewInputHash(mkBundle(L0, fcMut)), parent_artifact_hash: recomputeArtifactHash(srcArtifact) };
    forgedMut.consensus_artifact_hash = recomputeArtifactHash(forgedMut);
    const foMut = { source_artifact_hash: recomputeArtifactHash(srcArtifact), sc_manifest_hash: hashObject(scManifest), fix_plan_hash: plan.fix_plan_hash, dispatch_record_hash: hashObject(dispatchRecord), run_manifest_hash: runManifestHash(rmMut) };
    const mMut = wj('m-mut.json', { repo: 'o/r', remote: 'origin', branch: fbMut, expected_sha: fcMut, purpose: 'feature', consensus_artifact_hash: forgedMut.consensus_artifact_hash, fix_orchestration: foMut });
    let pgOutMut = '', pgCodeMut = 0;
    try { cliPg('--repo-dir', repo, '--manifest', mMut, '--artifact', wj('t-mut.json', forgedMut), '--bundle', wj('b-mut.json', mkBundle(L0, fcMut)), '--source-artifact', wj('s-mut.json', srcArtifact), '--sc-manifest', wj('sc-mut.json', scManifest), '--fix-plan', wj('p-mut.json', plan), '--dispatch-record', wj('r-mut.json', dispatchRecord), '--run-manifest', wj('rm-mut.json', rmMut)); }
    catch (e) { pgCodeMut = e.status ?? 1; pgOutMut = String(e.stderr ?? e.message); }
    ok(!pgOutMut.includes('批次闭合门'), '变异 A：挖掉 CLI --batch 透传后，closure 复发负例 errors 不得含「批次闭合门」（manifest 无 batch → 闭合门整体跳过）: ' + pgOutMut.slice(0, 200));
    // 控制组：未变异（原 CLI init）→ errors 含「批次闭合门」（与 SC-T1b-closure 同场景）
    const { runManifest: rmCtl, finalCandidate: fcCtl, dTb: dCtl, featBranch: fbCtl } = cliFullChain(JSON.stringify({ batch_id: 't1c-c', frozen_families: [FK1, FK2].sort() }));
    const wj2 = (name, obj) => { const p = join(dCtl, name); writeFileSync(p, JSON.stringify(obj)); return p; };
    const forgedCtl = { ...termRecur, candidate_sha: fcCtl, review_input_hash: computeReviewInputHash(mkBundle(L0, fcCtl)), parent_artifact_hash: recomputeArtifactHash(srcArtifact) };
    forgedCtl.consensus_artifact_hash = recomputeArtifactHash(forgedCtl);
    const foCtl = { source_artifact_hash: recomputeArtifactHash(srcArtifact), sc_manifest_hash: hashObject(scManifest), fix_plan_hash: plan.fix_plan_hash, dispatch_record_hash: hashObject(dispatchRecord), run_manifest_hash: runManifestHash(rmCtl) };
    const mCtl = wj2('m-ctl.json', { repo: 'o/r', remote: 'origin', branch: fbCtl, expected_sha: fcCtl, purpose: 'feature', consensus_artifact_hash: forgedCtl.consensus_artifact_hash, fix_orchestration: foCtl });
    let pgOutCtl = '';
    try { cliPg('--repo-dir', repo, '--manifest', mCtl, '--artifact', wj2('t-ctl.json', forgedCtl), '--bundle', wj2('b-ctl.json', mkBundle(L0, fcCtl)), '--source-artifact', wj2('s-ctl.json', srcArtifact), '--sc-manifest', wj2('sc-ctl.json', scManifest), '--fix-plan', wj2('p-ctl.json', plan), '--dispatch-record', wj2('r-ctl.json', dispatchRecord), '--run-manifest', wj2('rm-ctl.json', rmCtl)); }
    catch (e) { pgOutCtl = String(e.stderr ?? e.message); }
    ok(pgOutCtl.includes('批次闭合门'), '控制组（未变异）：errors 必须含「批次闭合门」（变异 A 生效的对照）: ' + pgOutCtl.slice(0, 200));
  } finally {
    rm(frCopy, { force: true });
  }
});
// FIX-5（2026-08-08）：删除 [SC-T1c-B] ok(true) 空断言——严格后代的真实常驻反向变异
// 在 [i9-batch-6c] :737-774 已有效（挖 isAncestorCommit 恒 true → 兄弟提交放行），
// 不需要包装项（空断言 = 恒真，无验证价值）。

// ========== [SC-T2] finalizeRun reader 侧硬化（2026-08-08 派工） ==========
console.log('\n[SC-T2] finalizeRun 读到持久化 manifest {ok:true, results:[]} 时拒绝');
t('[SC-T2-1] CLI 全链正常 finalize 通过（对照组：results 非空逐项证据）', () => {
  const { runManifest } = cliFullChain(undefined);
  ok(runManifest.waves.every((w) => w.validation && w.validation.ok === true && (w.validation.results ?? []).length > 0),
    '正常路径 waves validation 必须 ok:true 且 results 非空（逐 SC 记录）');
});
t('[SC-T2-2] 持久化篡改：validation 改为 {ok:true, results:[]} → finalizeRun 拒绝（文案限定该形状）', () => {
  // CLI 全链跑到 validate 后（validation 已写入 results 非空），持久化篡改 manifest：
  // 把 wave0 的 validation.results 清空（ok 保持 true——自报摘要形态）→ finalizeRun 必须拒
  const dT2 = mkdtempSync(join(tmpdir(), 't2-'));
  const stateDir = join(dT2, 'state'); mkdirSync(stateDir, { recursive: true });
  const wtRoot = join(dT2, 'wt'); mkdirSync(wtRoot, { recursive: true });
  const runId = `t2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const writeJson = (name, obj) => { const p = join(dT2, name); writeFileSync(p, JSON.stringify(obj)); return p; };
  const planP = writeJson('plan.json', plan);
  const scmP = writeJson('scm.json', scManifest);
  const srcP = writeJson('src.json', srcArtifact);
  const featBranch = `feat-${runId}`;
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', featBranch, L1]);
  cliRun('init', '--state-dir', stateDir, '--run-id', runId, '--repo-dir', repo, '--plan', planP, '--sc-manifest', scmP, '--source-artifact', srcP, '--feature-branch', featBranch);
  const allocOut = JSON.parse(cliRun('allocate', '--state-dir', stateDir, '--run-id', runId, '--plan', planP, '--wave', '0', '--worktree-root', wtRoot, '--artifact', srcP, '--sc-manifest', scmP));
  for (const a of allocOut.allocations) {
    for (const f of a.anchor_paths ?? []) {
      mkdirSync(dirname(join(a.worktree, f)), { recursive: true });
      writeFileSync(join(a.worktree, f), f.includes('fix1') ? 'cancel 保护已加\n' : (f.includes('README') ? '残余 风险已登记\n' : 'fixed\n'));
    }
    execFileSync('git', ['-C', a.worktree, 'add', '.']);
    execFileSync('git', ['-C', a.worktree, 'commit', '-qm', `fix ${a.group_id}`]);
  }
  const intOut = JSON.parse(cliRun('integrate', '--state-dir', stateDir, '--run-id', runId, '--plan', planP, '--wave', '0'));
  if (!intOut.ok) throw new Error('integrate 失败: ' + JSON.stringify(intOut.errors));
  const valOut = JSON.parse(cliRun('validate', '--state-dir', stateDir, '--run-id', runId, '--sc-manifest', scmP, '--wave', '0'));
  if (!valOut.ok) throw new Error('validate 失败: ' + JSON.stringify(valOut.results));
  // 持久化篡改：wave0 validation.results 清空（ok 保持 true）
  const mPath = join(stateDir, `run-${runId}.json`);
  const m = readJson(mPath);
  m.waves[0].validation.results = [];
  writeFileSync(mPath, JSON.stringify(m));
  let finErr = '';
  try { cliRun('finalize', '--state-dir', stateDir, '--run-id', runId); }
  catch (e) { finErr = String(e.message); }
  ok(finErr.includes('finalizeRun 读到该形状时拒绝'), 'finalizeRun 必须拒绝 {ok:true, results:[]} 并点名该形状: ' + finErr);
});

// ========== [SC-T8] 批次强制 + 冻结族精确全覆盖（2026-08-08 派工，lead 转授 SC-T8 契约） ==========
console.log('\n[SC-T8] 修复编排路径 batch 强制（SC-1）+ frozen_families 精确全覆盖（SC-2）');
// 测试所需分支/HEAD 状态：push-guard 的 SHA 绑定要求 HEAD == expected_sha 且 branch ref 也是，
// 文件尾部 HEAD 已不在 feat 上（[SC-T2-2] 停在自建分支），每个用例自建指向目标 sha 的分支。
const mkBranch = (name, sha) => { execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', name, sha]); };
const noBatchRunManifest = mkRunManifest({ batch: undefined }); // 无 batch 段（批次强制负例载体）
const BATCH_REQUIRED_RE = /批次协议/;

t('[SC-T8-1] 修复编排 + 源 artifact 含 actionable findings + run manifest 无 batch → push-guard 拒（批次强制，本门自己的消息）', () => {
  mkBranch('sc-t8-1', L2);
  const r = pgCallWith(noBatchRunManifest, L2, termEmpty, 'sc-t8-1');
  ok(r.errors.some((e) => BATCH_REQUIRED_RE.test(e) && /缺 batch 段/.test(e)),
    '必须报本门自己的批次强制错误（点名批次协议 + 缺 batch 段）: ' + JSON.stringify(r.errors));
  ok(!r.errors.some((e) => /批次闭合门/.test(e)),
    '无 batch 时闭合门不得误报（无 batch 段 = 闭合门整体跳过，只有批次强制这一道门在拦）: ' + JSON.stringify(r.errors));
});

t('[SC-T8-2] 部分冻结（缺 FK2，少冻结）→ 闭合门判据③拒「缺源共识族」+ push-guard 传导', () => {
  const partialRun = mkRunManifest({ batch: { batch_id: 'b1', frozen_at_sha: L1, frozen_families: [FK1], successor_sha: L2, status: 'closed' } });
  const errs = checkBatchClosure({ runManifest: partialRun, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest });
  ok(errs.some((e) => /缺源共识族/.test(e)),
    '少冻结必须报「缺源共识族」（点名漏冻结的族）: ' + JSON.stringify(errs));
  ok(!errs.some((e) => /不在源共识中的 family_key/.test(e)),
    '部分冻结不得误报外族（FK1 在源共识内）: ' + JSON.stringify(errs));
  mkBranch('sc-t8-2', L2);
  const r = pgCallWith(partialRun, L2, termEmpty, 'sc-t8-2');
  ok(r.errors.some((e) => /批次闭合门/.test(e) && /缺源共识族/.test(e)),
    'push-guard 必须传导闭合门的缺族错误: ' + JSON.stringify(r.errors));
});

t('[SC-T8-3] 额外外族（frozen 含 FK3，多冻结）→ 闭合门判据③拒「不在源共识」+ push-guard 传导', () => {
  const extraRun = mkRunManifest({ batch: { batch_id: 'b1', frozen_at_sha: L1, frozen_families: [FK1, FK2, FK3], successor_sha: L2, status: 'closed' } });
  const errs = checkBatchClosure({ runManifest: extraRun, sourceArtifact: srcArtifact, finalArtifact: termEmpty, scManifest });
  ok(errs.some((e) => /不在源共识中的 family_key/.test(e)),
    '外族必须被拒（点名外族 family_key）: ' + JSON.stringify(errs));
  ok(!errs.some((e) => /缺源共识族/.test(e)),
    '外族场景不得误报缺族（FK1/FK2 都在冻结集内）: ' + JSON.stringify(errs));
  mkBranch('sc-t8-3', L2);
  const r = pgCallWith(extraRun, L2, termEmpty, 'sc-t8-3');
  ok(r.errors.some((e) => /批次闭合门/.test(e) && /不在源共识中的 family_key/.test(e)),
    'push-guard 必须传导闭合门的外族错误: ' + JSON.stringify(r.errors));
});

t('[SC-T8-4] 精确覆盖正向全链：CLI init --batch（frozen = 源 artifact 全部唯一 family_key）→ push-guard 整体通过', () => {
  const { runManifest, finalCandidate, featBranch } = cliFullChain(JSON.stringify({ batch_id: 't8-4', frozen_families: [FK1, FK2].sort() }));
  // 终版 artifact：delta 轮对 finalCandidate（candidate=finalCandidate、parent=srcArtifact、无 findings）
  const forgedTerm = { ...termEmpty, candidate_sha: finalCandidate, review_input_hash: computeReviewInputHash(mkBundle(L0, finalCandidate)), parent_artifact_hash: recomputeArtifactHash(srcArtifact) };
  forgedTerm.consensus_artifact_hash = recomputeArtifactHash(forgedTerm);
  // HEAD 已在 featBranch（cliFullChain 内部创建并停留，finalize 后 tip == finalCandidate）
  const r = pgCallWith(runManifest, finalCandidate, forgedTerm, featBranch);
  eq(r.errors, [], '精确覆盖应整体零错误（正例必须验整体通过，不能只查「无批次类报错」）: ' + JSON.stringify(r.errors));
});

t('[SC-T8-5] 普通旧路径不变：首轮零 finding 无 parent 无编排 → push-guard 整体通过（不强制批次）', () => {
  const r1Clean = consensusFor(mkBundle(L0, L1), [[], [], []], { repoDir: repo });
  ok(r1Clean.gate_result === 'pass', '[SC-T8-5] 前提失败: 首轮零 finding 未 PASS: ' + JSON.stringify(r1Clean.fail_reasons ?? []));
  mkBranch('sc-t8-5', L1);
  const r = checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'sc-t8-5', expected_sha: L1, purpose: 'feature', consensus_artifact_hash: r1Clean.consensus_artifact_hash },
    artifact: r1Clean, bundle: mkBundle(L0, L1), constitution
  });
  eq(r.errors, [], '零 finding 无编排直通 PR 应整体通过（批次协议不约束普通路径）: ' + JSON.stringify(r.errors));
});

t('[SC-T8-6] 单 SC actionable 强制：源 artifact 仅 1 条 actionable finding → 无 batch 仍拒（判定看 actionable findings，不按 SC 数量）', () => {
  // 单 finding 源共识（f1 一条 major）+ 单 SC manifest + 单组 plan + 无 batch run manifest
  const singleSrc = consensusFor(mkBundle(L0, L1), [[f1], [f1], [f1]], { repoDir: repo });
  ok(singleSrc.gate_result === 'pass', '[SC-T8-6] 前提失败: 单 finding 源共识未 PASS: ' + JSON.stringify(singleSrc.fail_reasons ?? []));
  const cS1 = singleSrc.canonical_findings.find((c) => c.family_key === FK1);
  ok(cS1, '[SC-T8-6] 前提失败: 单 finding 源共识须含 FK1 canonical');
  const singleScManifest = { schema_version: 'v2', consensus_artifact_hash: singleSrc.consensus_artifact_hash, scs: [{ id: 'SC-1', kind: 'fix', finding_ids: [cS1.id], invariant: I1, family_key: FK1, change: '给 fix1 加取消保护', holds: 'fix1 取消后迟到 start 不激活', verify: { cmd: 'grep', args: ['-q', 'cancel', 'src/fix1.ts'] } }] };
  const sCov = checkScCoverage({ manifest: singleScManifest, artifact: singleSrc });
  eq(sCov, [], '[SC-T8-6] 前提失败: SC 覆盖门: ' + JSON.stringify(sCov));
  const sBuilt = buildFixPlan({ artifact: singleSrc, manifest: singleScManifest, capacity: 8 });
  ok(!sBuilt.degraded, '[SC-T8-6] 前提失败: plan degraded: ' + JSON.stringify(sBuilt.reasons));
  const singlePlan = sBuilt.plan;
  eq(JSON.stringify(singlePlan.waves), JSON.stringify([['g1']]), '[SC-T8-6] 前提失败: 单 SC plan 应为单 fix 波');
  const singleDispatch = { fix_plan_hash: singlePlan.fix_plan_hash, waves: [{ dispatches: [{ group_id: 'g1', worker_session_id: 'w1', tip: L2, result: { status: 'PASS', sc_results: [{ sc_id: 'SC-1', status: 'PASS', evidence: 'fix1 修好' }] } }] }] };
  const sDisp = checkDispatch({ plan: singlePlan, record: singleDispatch });
  eq(sDisp, [], '[SC-T8-6] 前提失败: 派发门: ' + JSON.stringify(sDisp));
  const singleTerm = consensusFor(mkBundle(L0, L2), [[], [], []], { round: 2, attempt: 1, repoDir: repo, gateOpts: { parentArtifact: singleSrc, repoDir: repo } });
  ok(singleTerm.gate_result === 'pass', '[SC-T8-6] 前提失败: 单 finding 终版未 PASS: ' + JSON.stringify(singleTerm.fail_reasons ?? []));
  const singleRun = {
    schema_version: RUN_MANIFEST_SCHEMA_VERSION, run_id: 'sc-t8-single', repo_dir: repo,
    fix_plan_hash: singlePlan.fix_plan_hash, sc_manifest_hash: hashObject(singleScManifest),
    source_artifact_hash: recomputeArtifactHash(singleSrc), source_candidate: L1,
    feature_branch: 'feat', integration_branch: 'x',
    waves: [{ wave_index: 0, base: L1, worktree_root: '/x', allocations: [], tips: [{ group_id: 'g1', tip: L2 }], integrated_tip: L2, replan: null, validation: { at: 't', ok: true, results: [] }, squash_commits: [L2] }],
    final_candidate: L2, events: []
  };
  const foSingle = {
    source_artifact_hash: recomputeArtifactHash(singleSrc),
    sc_manifest_hash: hashObject(singleScManifest),
    fix_plan_hash: singlePlan.fix_plan_hash,
    dispatch_record_hash: hashObject(singleDispatch),
    run_manifest_hash: runManifestHash(singleRun)
  };
  mkBranch('sc-t8-6', L2);
  const r = checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'sc-t8-6', expected_sha: L2, purpose: 'feature', consensus_artifact_hash: singleTerm.consensus_artifact_hash, fix_orchestration: foSingle },
    artifact: singleTerm, bundle: mkBundle(L0, L2), constitution,
    sourceArtifact: singleSrc, scManifest: singleScManifest, fixPlan: singlePlan, dispatchRecord: singleDispatch, runManifest: singleRun
  });
  ok(r.errors.some((e) => BATCH_REQUIRED_RE.test(e) && /缺 batch 段/.test(e)),
    '单 SC actionable 无 batch 必须被批次强制拒（不按 SC 数量判断，判定只看源 artifact 的 actionable findings）: ' + JSON.stringify(r.errors));
  ok(!r.errors.some((e) => /批次闭合门/.test(e)), '无 batch 时闭合门不得误报: ' + JSON.stringify(r.errors));
});

t('[SC-T8-7] 常驻反向变异：挖掉 push-guard batch-required 接线 → 无 batch 负例不再报本门消息（控制组未变异必报；不用笼统 errors.length）', async () => {
  // 与 [i9-batch-6c] 同一模式：临时拷贝 push-guard.mjs 到 scripts/（保留相对 import）、
  // 挖空变异点、动态 import；变异组证明检测器有效（接线一旦消失负例即放行），控制组
  // 证明未变异时必须拦（防止「变异组放行是因为别的原因」的误读）。
  const { readFileSync: rf, writeFileSync: wf, rmSync: rm } = await import('node:fs');
  const pgSrc = rf(join(S, 'push-guard.mjs'), 'utf8');
  const probe = 'if (srcActionable.length > 0 && !runManifest.batch) {';
  ok(pgSrc.includes(probe), '前置: push-guard 源码须含 batch-required 接线（探针按此定位变异点）');
  const patched = pgSrc.replace(probe, 'if (false && srcActionable.length > 0 && !runManifest.batch) { // MUTATION: batch-required 接线挖空（SC-T8-7 常驻反向变异）');
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pgCopy = join(S, `.i9-batch-pg-t8-${uid}.mjs`);
  wf(pgCopy, patched);
  try {
    const fo = {
      source_artifact_hash: recomputeArtifactHash(srcArtifact),
      sc_manifest_hash: hashObject(scManifest),
      fix_plan_hash: plan.fix_plan_hash,
      dispatch_record_hash: hashObject(dispatchRecord),
      run_manifest_hash: runManifestHash(noBatchRunManifest)
    };
    // HEAD 竞态防护（实测踩坑，2026-08-08）：本文件多个 async 测试（[i9-batch-6c] 等）在
    // 恢复阶段会操作共享 repo 的 HEAD。变异组注册时的 mkBranch 在 await import 之前执行，
    // 恢复后 HEAD 可能已被其他 async 测试改走 → checkPushGuard 先报 SHA 漂移、测不到本门。
    // 修复：checkout 与 checkPushGuard 放进同一个原子同步块（await 之后、调用之前重新
    // checkout；同步块之间不交错，谁先恢复谁后恢复都自洽）。
    const ensureHead = (branch) => { execFileSync('git', ['-C', repo, 'checkout', '-q', branch]); };
    mkBranch('sc-t8-7a', L2); // 注册阶段先建分支（分支创建与 HEAD 绑定不在恢复段）
    mkBranch('sc-t8-7b', L2);
    const copy = await import('file://' + pgCopy + '?t=' + Date.now());
    // 变异组：临时副本 → 无 batch 负例 errors 不得含本门「批次协议」消息（且整体放行——
    // 若 errors 非空是别的门在拦，说明变异没测到本门，变异无效）
    ensureHead('sc-t8-7a');
    const rMut = copy.checkPushGuard({
      repoDir: repo,
      manifest: { repo: 'o/r', remote: 'origin', branch: 'sc-t8-7a', expected_sha: L2, purpose: 'feature', consensus_artifact_hash: termEmpty.consensus_artifact_hash, fix_orchestration: fo },
      artifact: termEmpty, bundle: mkBundle(L0, L2), constitution,
      sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: noBatchRunManifest
    });
    ok(!rMut.errors.some((e) => BATCH_REQUIRED_RE.test(e)) && rMut.errors.length === 0,
      '变异组：挖掉接线后无 batch 负例必须放行（不得再报本门「批次协议」消息；errors 非空 = 别的门在拦 = 变异无效）: ' + JSON.stringify(rMut.errors));
    // 控制组：未变异原模块 → 必报本门消息（同一原子同步块内，HEAD 不受其他 async 测试影响）
    ensureHead('sc-t8-7b');
    const rCtl = checkPushGuard({
      repoDir: repo,
      manifest: { repo: 'o/r', remote: 'origin', branch: 'sc-t8-7b', expected_sha: L2, purpose: 'feature', consensus_artifact_hash: termEmpty.consensus_artifact_hash, fix_orchestration: fo },
      artifact: termEmpty, bundle: mkBundle(L0, L2), constitution,
      sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: noBatchRunManifest
    });
    ok(rCtl.errors.some((e) => BATCH_REQUIRED_RE.test(e)),
      '控制组（未变异）：必须报本门「批次协议」消息（变异生效的对照）: ' + JSON.stringify(rCtl.errors));
  } finally {
    rm(pgCopy, { force: true });
  }
});

// 等所有 async 测试完成后再出汇总（t 的 async 支持：主流程不等 Promise 会提前打印）
await Promise.allSettled(pendingTests);
console.log(`\n==== i9-batch.mjs: ${pass} passed, ${failCount} failed ====`);
if (failCount) {
  console.log('失败用例:', failures.join(', '));
  process.exit(1);
}
