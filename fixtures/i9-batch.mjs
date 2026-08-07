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
// 反向变异：每条用例对应一个「挖空点」，变异后只有该用例红、其余保持绿（消息文本互斥支撑隔离）。
// 本文件独立可跑：`node fixtures/i9-batch.mjs`，不并入 run-fixtures.mjs / run-all.sh
// （lead 边界：run-fixtures.mjs / run-all.sh 由 lead 亲自接线，禁改）。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { computeReviewInputHash } from '../scripts/review-input-hash.mjs';
import { runConsensusGate, recomputeArtifactHash, familyKeyOf } from '../scripts/consensus-gate.mjs';
import { checkPushGuard, isStrictDescendant } from '../scripts/push-guard.mjs';
import { checkScCoverage } from '../scripts/sc-coverage-gate.mjs';
import { checkDispatch } from '../scripts/fix-dispatch-gate.mjs';
import { validateVerdict, OUT_OF_SCOPE_NOTES_FIELD } from '../scripts/verdict-validate.mjs';
import { contractSpec } from '../scripts/dispatch-contract.mjs';
import { buildFixPlan } from '../scripts/fix-plan.mjs';
import { runManifestHash, initRun } from '../scripts/fix-run.mjs';
import { computeFixPlanHash } from '../scripts/fix-plan.mjs';
import { checkBatchClosure } from '../scripts/batch-closure-gate.mjs';
import { readJson, hashObject } from '../scripts/lib/common.mjs';
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
    schema_version: 'v3', reviewer, run_status: 'ok', round: over.round ?? 1, attempt: over.attempt ?? 1,
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

// ---- run manifest 构造 helper（手工构造 v3 + batch 段；调用方覆盖 waves/final_candidate/batch）----
function mkRunManifest(over = {}) {
  return {
    schema_version: 'v3', run_id: 'i9-batch-ok', repo_dir: repo,
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
  ok(!errs.some((e) => /out_of_scope|D3/.test(e)), '合法 note 不应报 D3 错误: ' + JSON.stringify(errs));
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
t('[i9-batch-6a] L1..L3 两个 commit（多 commit 分步修复）→ 批次校验通过（严格后代，任意距离）', () => {
  const r = pgCallWith(twoStepRunManifest, L3, termTwoStep);
  ok(!r.errors.some((e) => /批次|严格后代|零推进/i.test(e)), '多 commit 不应报任何批次错误: ' + JSON.stringify(r.errors));
});
// 6b/6c 诚实说明（如实声明）：完整 checkPushGuard 链上，「expected_sha 绑定」+「SC-3 终版
// artifact 的 parent 祖先绑定」已前置保证终版 candidate 必是 source_candidate 的后代——
// 「非后代/零推进」在完整链上必然被前置检查先拦，无法独立构造触发。因此这两个失败模式
// 直接单测 push-guard 导出的 isStrictDescendant 纯函数（push-guard 批次段调用它，6a 的
// 完整链通过即验证接线未断）。
t('[i9-batch-6b] isStrictDescendant：非后代（L1 之前的 L0）→ false（push-guard 批次段据此拒）', () => {
  ok(isStrictDescendant({ repoDir: repo, ancestorSha: L1, descendantSha: L0 }) === false,
    'L0 不是 L1 的后代必须判 false');
});
t('[i9-batch-6c] isStrictDescendant：相等（零推进）→ false（push-guard 批次段据此报「批次零推进」）', () => {
  ok(isStrictDescendant({ repoDir: repo, ancestorSha: L1, descendantSha: L1 }) === false,
    '同 SHA 必须判 false（严格不等，git merge-base --is-ancestor A A 会退出 0，必须显式排除）');
});
t('[i9-batch-6d] isStrictDescendant：严格后代（任意距离 L1→L3）→ true（多 commit 分步修复合法）', () => {
  ok(isStrictDescendant({ repoDir: repo, ancestorSha: L1, descendantSha: L3 }) === true,
    'L3 是 L1 的严格后代（隔 2 个 commit）必须判 true——任意距离，不要求直接子 commit');
});

console.log(`\n==== i9-batch.mjs: ${pass} passed, ${failCount} failed ====`);
if (failCount) {
  console.log('失败用例:', failures.join(', '));
  process.exit(1);
}
