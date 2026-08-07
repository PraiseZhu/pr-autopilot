#!/usr/bin/env node
// issue #9 SC 延伸（批次事务协议）回归 fixtures — worker: fix/i9-batch-txn
// 覆盖范围（lead 派工包 Task 1/3/4/5/6，自建独立文件）:
//   [i9-batch-1] 正例走通：init 冻结集 → 直接后继修复 → finalize → 闭合门 OK + push-guard OK
//                （批次校验段不误伤合法批次）
//   [i9-batch-2] 冻结集未闭合被拒：冻结 family 在终版 delta 审查中再次出现（同族复发）→
//                闭合门判据④拒收口
//   [i9-batch-3] 批次期间新 family 混入被拒：本批 SC 处置冻结集之外的 family → 闭合门判据⑤拒
//   [i9-batch-4] 同族二次触发六件套：闭合门④检出复发（触发）→ lead 产出归因六件套 →
//                convergence-attribution-gate 通过（六项齐全 = 触发已兑现）
//   [i9-batch-5] 六件套缺项被拒：attribution 缺任一项 → convergence-attribution-gate 拒
//   [i9-batch-6] successor 不是直接后继被拒：frozen_at_sha..successor 恰 2 个 commit →
//                push-guard「恰好一个后继」拒（squash 记录齐全，只红批次判据，失败模式隔离）
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
import { checkPushGuard } from '../scripts/push-guard.mjs';
import { checkScCoverage } from '../scripts/sc-coverage-gate.mjs';
import { checkDispatch } from '../scripts/fix-dispatch-gate.mjs';
import { buildFixPlan } from '../scripts/fix-plan.mjs';
import { runManifestHash } from '../scripts/fix-run.mjs';
import { checkBatchClosure } from '../scripts/batch-closure-gate.mjs';
import { checkAttribution } from '../scripts/convergence-attribution-gate.mjs';
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
    ui_registry_config_hash: 'c'.repeat(64), pr_context_digest: 'd'.repeat(64), ...over
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

// ========== [i9-batch-4] 同族二次触发六件套（触发 + 产出闭环） ==========
console.log('\n[i9-batch-4] 同族二次触发六件套：闭合门④检出复发（触发）→ 归因六件套齐全 → 通过');
t('[i9-batch-4a] 触发：闭合门④必须拒（同 [i9-batch-2]，触发点即此交集）', () => {
  const errs = checkBatchClosure({ runManifest: recurRunManifest, sourceArtifact: srcArtifact, finalArtifact: termRecur, scManifest });
  ok(errs.some((e) => /同族复发/.test(e)), '触发点必须是闭合门④的同族复发判定: ' + JSON.stringify(errs));
});
t('[i9-batch-4b] 兑现：lead 产出归因六件套（六项全非空 + 归属正确）→ convergence-attribution-gate 通过', () => {
  const attribution = {
    family_key: FK1, batch_id: 'b1',
    items: {
      prev_fix: '上次修的是给 fix1 加取消保护（SC-1）',
      why_recurred: '取消路径修了，但迟到事件在 cancel 后仍走旧回调入口',
      why_sc_missed: 'SC-1 的 holds 只覆盖了同步取消路径，没写迟到事件的断言',
      fix_or_family_misclassified: '族归得对（同一不变量），是修错了（只修了一半）',
      root_or_symptom: '这次改的是症状（补入口判空），根因是状态机没有终态守卫',
      root_cause_and_issue: '根因在状态机终态守卫缺失，已开 issue #9999 跟踪'
    }
  };
  const errs = checkAttribution({ attribution, runManifest: recurRunManifest, familyKey: FK1 });
  eq(errs, [], '六项齐全的归因六件套应通过: ' + JSON.stringify(errs));
});

// ========== [i9-batch-5] 六件套缺项被拒 ==========
console.log('\n[i9-batch-5] 六件套缺项：任一项缺失 → convergence-attribution-gate 拒');
t('[i9-batch-5] 缺 ⑥ root_cause_and_issue → 拒（消息点名缺项标签）', () => {
  const incomplete = {
    family_key: FK1, batch_id: 'b1',
    items: {
      prev_fix: '上次修的是给 fix1 加取消保护',
      why_recurred: '迟到事件仍走旧入口',
      why_sc_missed: 'SC-1 没写迟到断言',
      fix_or_family_misclassified: '修错了',
      root_or_symptom: '症状',
      // root_cause_and_issue 缺失
    }
  };
  const errs = checkAttribution({ attribution: incomplete, runManifest: recurRunManifest, familyKey: FK1 });
  ok(errs.some((e) => /⑥若仍是症状，明确指出根因在哪并开 issue/.test(e)),
    '必须点名缺失的 ⑥ 项: ' + JSON.stringify(errs));
});
t('[i9-batch-5b] family_key 归属错（不是触发复发的族）→ 拒', () => {
  const wrongFamily = {
    family_key: FK2, batch_id: 'b1',
    items: {
      prev_fix: 'x', why_recurred: 'x', why_sc_missed: 'x',
      fix_or_family_misclassified: 'x', root_or_symptom: 'x', root_cause_and_issue: 'x'
    }
  };
  const errs = checkAttribution({ attribution: wrongFamily, runManifest: recurRunManifest, familyKey: FK1 });
  ok(errs.some((e) => /六件套必须针对复发的那一族/.test(e)),
    'family_key 错配必须被拦: ' + JSON.stringify(errs));
});

// ========== [i9-batch-6] successor 不是直接后继被拒 ==========
console.log('\n[i9-batch-6] successor 非直接后继：frozen_at_sha..successor 恰 2 个 commit → push-guard 拒');
// 再产出一个 commit L3（L1→L2→L3），把 L3 当 final candidate
writeFileSync(join(repo, 'src/fix2.ts'), 'export const fix2 = 2;\n');
g('add', '.'); g('commit', '-qm', 'L3 额外 commit（非直接后继场景）');
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
t('[i9-batch-6] L1..L3 两个 commit → push-guard「恰好一个后继」拒（squash 记录齐全，只红批次判据）', () => {
  const fo = {
    source_artifact_hash: recomputeArtifactHash(srcArtifact),
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: runManifestHash(twoStepRunManifest)
  };
  const r = checkPushGuard({
    repoDir: repo,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: L3, purpose: 'feature', consensus_artifact_hash: termTwoStep.consensus_artifact_hash, fix_orchestration: fo },
    artifact: termTwoStep, bundle: mkBundle(L0, L3), constitution,
    sourceArtifact: srcArtifact, scManifest, fixPlan: plan, dispatchRecord, runManifest: twoStepRunManifest
  });
  ok(r.errors.some((e) => /「恰好一个后继」失败: frozen_at_sha\.\.successor_sha 有 2 个 commit/.test(e)),
    '必须精确报出「恰好一个后继」错误: ' + JSON.stringify(r.errors));
  ok(!r.errors.some((e) => /未登记 commit/.test(e)), 'squash 记录齐全，不得先被 SC-R3-8 拦（失败模式隔离）: ' + JSON.stringify(r.errors));
});

console.log(`\n==== i9-batch.mjs: ${pass} passed, ${failCount} failed ====`);
if (failCount) {
  console.log('失败用例:', failures.join(', '));
  process.exit(1);
}
