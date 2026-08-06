#!/usr/bin/env node
// pr-autopilot 回归 fixtures v3 — 审③后更新（对账用例全部固化）
// 每条用例前缀 [计划条款/审次编号]；末尾 SKIPPED 清单如实列出仓内验不了的项。
// 模拟密钥一律运行时拼接（静态文件不含完整 token/赋值形态）。
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, utimesSync, rmSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const S = join(HERE, '..', 'scripts');
const W = join(HERE, '..', 'deploy', 'wrappers');

import { computeReviewInputHash } from '../scripts/review-input-hash.mjs';
import { evaluateIntent, buildMarkerBlock, extractIntentMarker, fallbackIntentFromBody } from '../scripts/intent-check.mjs';
import { computeSizeReport, evaluateSize, loadSizeGateConfig, exemptionInvalidReason } from '../scripts/size-gate.mjs';
import { validateVerdict } from '../scripts/verdict-validate.mjs';
import { runConsensusGate, recomputeArtifactHash, familyKeyOf } from '../scripts/consensus-gate.mjs';
import { checkPushGuard, matchAny, directionCheck, jsonSubset, fastSignaturePayload } from '../scripts/push-guard.mjs';
import { ciReadiness } from '../scripts/ci-readiness.mjs';
import { matchUiPaths } from '../scripts/ui-paths/match.mjs';
import { registerPr, unregisterPr, checkReceipt, stateFileName } from '../scripts/pr-watch/register.mjs';
import { evaluate, emptyCursors } from '../scripts/pr-watch/gate.mjs';
import { runEngine } from '../scripts/pr-watch/engine.mjs';
import { ackDispatch, cancelDispatch } from '../scripts/pr-watch/ack.mjs';
import { checkFinalize, receiptPath } from '../scripts/pr-watch/finalize.mjs';
import { checkCompletion } from '../scripts/pr-watch/complete.mjs';
import { reserveBudget, releaseReserve, recordCost, spentToday, budgetCheck } from '../scripts/pr-watch/budget.mjs';
import { route } from '../scripts/pr-watch/notify-router.mjs';
import { signMarker, verifyMarker } from '../scripts/pr-watch/provenance.mjs';
import { withLock, acquireLock } from '../scripts/lib/state-lock.mjs';
import { validateRemoteBranch } from '../scripts/lib/git-checks.mjs';
import { collect } from '../scripts/inbox-digest/collect.mjs';
import { validateRender, fallbackRender, lintSentence } from '../scripts/inbox-digest/render-validate.mjs';
import { runDigest } from '../scripts/inbox-digest/runner.mjs';
import { appendLedger } from '../scripts/evolution/ledger-append.mjs';
import { clusterLedger, signConfirm } from '../scripts/evolution/cluster.mjs';
import { checkScCoverage } from '../scripts/sc-coverage-gate.mjs';
import { buildFixPlan, computeFixPlanHash, hubViolations } from '../scripts/fix-plan.mjs';
import * as FP from '../scripts/fix-plan.mjs';
import { buildInvariantsSection, upsertInvariantsSection, SECTION_START, SECTION_END, buildCheckpointSection, upsertCheckpointSection, CHECKPOINT_SECTION_START, CHECKPOINT_SECTION_END } from '../scripts/pr-body.mjs';
import { normalizeRepoPath } from '../scripts/lib/common.mjs';
import { recoverFromReceipt } from '../scripts/pr-watch/finalize.mjs';
import { foldDispatchStates } from '../scripts/pr-watch/budget.mjs';
import { secretLint } from '../scripts/evolution/secret-lint.mjs';
import { classifyEscapes } from '../scripts/evolution/escape-classify.mjs';
import { checkLeases, alertWithFallback } from '../scripts/health/lease-check.mjs';
import { readJson, hashObject, canonicalJson } from '../scripts/lib/common.mjs';
import { HARDENING_CLASS_COUNT, HARDENING_CHECKLIST_VERSION } from '../scripts/lib/hardening-registry.mjs';
import { contractSpec, contractDigest, emitContract, requiredLiterals, checkDispatchPackage, SEATS, ALL_FACES } from '../scripts/dispatch-contract.mjs';
import { loadFormatConfig, evaluateFormat, formatConfigHash, hasSection, EMPTY_FORMAT_CONFIG,
  titleTypeRe as titleTypeReRef, TITLE_VAGUE_RE as TITLE_VAGUE_RE_REF } from '../scripts/pr-format-gate.mjs';
import { DEFAULT_REQUIREMENTS } from '../scripts/verdict-validate.mjs';

let pass = 0, failCount = 0;
const failures = [];
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { pass++; console.log(`  ok  ${name}`); })
        .catch((e) => { failCount++; failures.push(name); console.log(`FAIL  ${name}: ${e.message}`); }));
    } else { pass++; console.log(`  ok  ${name}`); }
  } catch (e) { failCount++; failures.push(name); console.log(`FAIL  ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg} expected=${jb} got=${ja}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40);
const HMAC_KEY = 'fixture-key-not-a-secret';
const FAST_KEY = 'fixture-fast-key';
const mkFakeGhToken = () => ['g', 'h', 'p', '_'].join('') + 'Ab1'.repeat(10);
const mkFakeBearer = () => ['Bea', 'rer'].join('') + ' ' + 'deadbeef'.repeat(3);
const mkFakePrivKey = () => ['-----BEGIN RSA PRIV', 'ATE KEY-----'].join('');
const mkFakeEnv = () => ['MY_SECRET', '_TOKEN'].join('') + '=' + 'sk-' + 'x1y2z3'.repeat(4);
const mkFakeAuthHeader = () => ['Author', 'ization:'].join('') + ' ' + mkFakeBearer();
const mkFakeSk = () => ['sk-', 'proj-'].join('') + '1234567890abcdef';
const mkCredAssign = () => ['creden', 'tial='].join('') + mkFakeSk();
const mkQuerySecret = () => 'https://a.b/c?' + ['tok', 'en='].join('') + 'abcdef123456789';
// SC-R3-4（D2）: 结构化 verify 配方 helper——不再有自由文本 verify
const VF = (cmd = 'true', args = []) => ({ cmd, args });

// ========== 1. hash / verdict / 共识门 ==========
console.log('\n[1] ⑨⑩ + 审②F1/F2 + 审③F4-R: hash·verdict·共识门');
const FULL_FACES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((f) => ({ face: f, result: f === 'B' ? 'n_a' : 'pass', evidence: `${f} 面走查完成` }));
const THIRD_FACES = ['D', 'E', 'F', 'G'].map((f) => ({ face: f, result: 'pass', evidence: `${f} 面走查完成` }));
const THIRD_GATES = ['format-gate', 'rule-compliance', 'security-privacy-gate', 'product-arch-gate'].map((g) => ({ gate_id: g, result: 'pass', evidence: `${g} 走查完成` }));
// R10-A3/SC-B4: 加固清单十类默认全 covered——两对抗席 R1 verdict 的默认 hardening_coverage
// （长度从 HARDENING_CLASS_COUNT 派生，不手抄数字——第 7 类「文档/校验/schema/fixture 不得
// 四处手抄数字」的要求延伸到 fixture 自身）。
const FULL_HARDENING = Array.from({ length: HARDENING_CLASS_COUNT }, (_, i) => ({ class_id: i + 1, result: 'covered', evidence: `第${i + 1}类走查完成` }));

function mkBundle(baseSha, candidateSha, over = {}) {
  return {
    base_sha: baseSha, candidate_sha: candidateSha, pr_title: 't', pr_body: 'b',
    touches_ui: false, matched_paths: [],
    ui_registry_config_hash: 'c'.repeat(64), pr_context_digest: 'd'.repeat(64), ...over
  };
}
// v2: 每条 finding 需 anchor_paths（机器分组字段）。测试 finding 未显式给时，
// 从 anchor 派生（去 :行号 后取路径部分；不像路径则回退占位），减少逐条改动。
// SC-B1: actionable（blocker/major）finding 还需 invariant/family_id——测试未显式给时，
// 默认补一个「自成一族」的值（用 id/下标当 family key，各不相同，等价于「本轮只有一处
// 表现」的合法态）；显式提供了就不覆盖，用于测试「共享 family」「归因错配」等场景。
// D8-4: 原文写「篡改归因」——本仓保证等级只到 T1（防疏忽/防漂移），归因写错是**填错**
// 不是伪造；「篡改」读起来像在防恶意，属超卖。真防伪造要宿主级签名回执，本仓做不到。
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
    schema_version: 'v2', reviewer, run_status: 'ok', round: 1,
    base_sha: bundleObj.base_sha, candidate_sha: bundleObj.candidate_sha,
    review_input_hash: computeReviewInputHash(bundleObj),
    faces: reviewer === 'upstream-preview' ? THIRD_FACES : FULL_FACES,
    findings: [], gate_checks: reviewer === 'upstream-preview' ? THIRD_GATES : [],
    verdict: 'APPROVED', closed_finding_ids: [],
    // R10-A3: 默认给两对抗席一份齐全的 hardening_coverage——不关心该字段的既有 fixture
    // 不必逐条改；专门测该字段的用例通过 over.hardening_coverage 覆盖/摘除。
    // SC-B4: 同理默认给两对抗席当前 checklist_version——专门测版本迁移的用例通过
    // over.checklist_version 覆盖/摘除（如摘除模拟「旧 9 项 verdict 没有这个字段」）。
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
  // R5-P1: 共识门 fail-closed 要求实改集在场。fixture 的 bundle 多为合成 SHA，
  // 默认把 verdict 锚点并集当作实改集（模拟「finding 都锚在被审 diff 上」的合法态）；
  // 需要测污染场景的用例显式传 gateOpts.changedPaths / repoDir 覆盖。
  let changedPaths = gateOpts.changedPaths;
  if (!changedPaths && !gateOpts.repoDir) {
    changedPaths = new Set();
    for (const v of vs) for (const fd of v.findings ?? []) for (const p of fd.anchor_paths ?? []) changedPaths.add(p);
  }
  return { verdicts: vs, artifact: runConsensusGate(vs, { bundle: bundleObj, changedPaths, ...gateOpts }) };
}

const bundle = mkBundle(SHA_A, SHA_B);
const RIH = computeReviewInputHash(bundle);
const THREE = () => consensusFor(bundle).verdicts;

t('[⑩] hash 确定性 + pr_context_digest 入锅 + 缺字段抛错', () => {
  eq(computeReviewInputHash(bundle), computeReviewInputHash({ ...bundle }));
  ok(RIH !== computeReviewInputHash({ ...bundle, pr_context_digest: 'e'.repeat(64) }));
  let threw = false; try { computeReviewInputHash({ ...bundle, touches_ui: undefined }); } catch { threw = true; }
  ok(threw);
});
t('[审②F1] 空 faces/缺面/重复面/fail+APPROVED/第三席缺 gate/taxonomy_gap → 全拒', () => {
  const empty = THREE().map((v) => ({ ...v, faces: [], gate_checks: [] }));
  eq(runConsensusGate(empty, { bundle }).gate_result, 'fail');
  ok(validateVerdict(mkVerdictFor('claude-adversarial', bundle, { faces: FULL_FACES.slice(0, 6) })).length > 0);
  ok(validateVerdict(mkVerdictFor('claude-adversarial', bundle, { faces: [...FULL_FACES.slice(0, 6), FULL_FACES[0]] })).length > 0);
  const faces = FULL_FACES.map((f) => f.face === 'A' ? { ...f, result: 'fail' } : f);
  ok(validateVerdict(mkVerdictFor('claude-adversarial', bundle, { faces })).length > 0);
  ok(validateVerdict(mkVerdictFor('upstream-preview', bundle, { gate_checks: THIRD_GATES.slice(0, 2) })).length > 0);
  const v = mkVerdictFor('claude-adversarial', bundle, {
    findings: [{ id: 'X', primary_face: 'taxonomy_gap', severity: 'blocker', anchor: 'a', evidence: 'e', status: 'open' }]
  });
  ok(validateVerdict(v).length > 0);
});
t('[e2e-consensus 缺口] 重复 finding id → degraded（一次 close 不得覆盖多条）', () => {
  const dup = { id: 'DUP-1', primary_face: 'A', severity: 'major', anchor: 'a', evidence: 'e', status: 'closed' };
  const v = mkVerdictFor('claude-adversarial', bundle, { findings: [dup, { ...dup, anchor: 'b' }], closed_finding_ids: ['DUP-1'] });
  ok(validateVerdict(v).length > 0, '重复 id 应拒');
});
t('[⑫] touches_ui=true 而对抗席 B=n_a → 拒', () => {
  const uiBundle = mkBundle(SHA_A, SHA_B, { touches_ui: true, matched_paths: ['src/app/x.tsx'] });
  ok(validateVerdict(mkVerdictFor('claude-adversarial', uiBundle), { bundle: uiBundle }).length > 0);
});
t('[R10-A3] R1 两对抗席 hardening_coverage 机器强制: 缺失/缺项/重复 class_id → fail；10 项齐全 → pass；round2/第三席不强制', () => {
  // ① 完全不带 hardening_coverage（复现 MUST-FIX-2 报告场景）→ 必须 fail-closed
  const missingCov = (over = {}) => mkVerdictFor('claude-adversarial', bundle, { hardening_coverage: undefined, ...over });
  ok(validateVerdict(missingCov()).some((e) => /hardening_coverage/.test(e)), 'R1 对抗席缺 hardening_coverage 必须报错');
  const missingAll = [missingCov(), mkVerdictFor('codex-adversarial', bundle, { hardening_coverage: undefined }), mkVerdictFor('upstream-preview', bundle)];
  eq(runConsensusGate(missingAll, { bundle }).gate_result, 'fail',
    '端到端: 三份 round:1 verdict 完全不带 hardening_coverage 必须 fail（此前 gate_result 会误判 pass，MUST-FIX-2 核心）');

  // ② 缺 3 项（只给 7/10）→ fail
  const short = mkVerdictFor('claude-adversarial', bundle, { hardening_coverage: FULL_HARDENING.slice(0, 7) });
  ok(validateVerdict(short).some((e) => /hardening_coverage/.test(e)), '缺项必须报 hardening_coverage 错误');

  // ③ class_id 重复（10 项但漏 10、重复 1）→ fail
  const dupCov = [...FULL_HARDENING.slice(0, 9), { class_id: 1, result: 'covered', evidence: '重复项' }];
  const dup = mkVerdictFor('claude-adversarial', bundle, { hardening_coverage: dupCov });
  ok(validateVerdict(dup).some((e) => /重复/.test(e)), 'class_id 重复必须报错');

  // ④ 10 项齐全 → pass（默认值本身即是这一形状，显式再断言一次）
  eq(validateVerdict(mkVerdictFor('claude-adversarial', bundle)).length, 0, '10 项齐全的 R1 对抗席应过');

  // ⑤ round>=2 不强制（即便完全不带）
  eq(validateVerdict(mkVerdictFor('claude-adversarial', bundle, { round: 2, hardening_coverage: undefined, checklist_version: undefined })).length, 0,
    'round>=2 不强制 hardening_coverage/checklist_version（复核轮不重扫穷举面）');

  // ⑥ 第三席不强制（即便完全不带）
  eq(validateVerdict(mkVerdictFor('upstream-preview', bundle)).length, 0, '第三席不强制 hardening_coverage/checklist_version');
});

t('[SC-B4/D5] checklist_version 9→10 迁移: 旧 9 项 verdict 必须报「清单版本过期需重审」而非缺项；新 10 项完整 verdict 必须过', () => {
  // 旧形态复刻：checklist_version 缺失（旧协议没有这个字段）+ hardening_coverage 恰好 9 项
  // （class_id 1〜9，每项本身合法——旧清单的「完整」形态）。D5 要求：这必须被识别成「版本不符
  // 需重审」，不能被静默当成「凑巧缺了 1 项」的普通计数错误。
  const OLD_NINE = Array.from({ length: 9 }, (_, i) => ({ class_id: i + 1, result: 'covered', evidence: `旧第${i + 1}类核对完成` }));
  const oldStyle = mkVerdictFor('claude-adversarial', bundle, { checklist_version: undefined, hardening_coverage: OLD_NINE });
  const oldErrs = validateVerdict(oldStyle);
  ok(oldErrs.some((e) => /清单版本过期需重审/.test(e)), '旧 9 项 verdict 必须显式报「清单版本过期需重审」: ' + JSON.stringify(oldErrs));
  ok(oldErrs.some((e) => /checklist_version/.test(e)), '错误信息必须点名 checklist_version 字段本身');

  // 显式携带旧版本号（而不是缺失该字段）同样必须被拒——版本号本身不等于当前值就是不符
  const explicitOld = mkVerdictFor('claude-adversarial', bundle, { checklist_version: HARDENING_CHECKLIST_VERSION - 1, hardening_coverage: OLD_NINE });
  ok(validateVerdict(explicitOld).some((e) => /清单版本过期需重审/.test(e)), '显式旧版本号同样必须报版本不符');

  // 端到端: 三份都是旧 9 项 verdict → consensus-gate 必须 fail（不得被 gate_result:pass 放过）
  const oldAll = [oldStyle, mkVerdictFor('codex-adversarial', bundle, { checklist_version: undefined, hardening_coverage: OLD_NINE }), mkVerdictFor('upstream-preview', bundle)];
  eq(runConsensusGate(oldAll, { bundle }).gate_result, 'fail', '三份旧 9 项 verdict 必须端到端 fail（9→10 是 exact 集合变更，D5）');

  // 新 10 项完整（默认值本身就是当前版本 + 10 项）→ 必须过，且不得混入版本错误
  const newStyle = mkVerdictFor('claude-adversarial', bundle);
  eq(newStyle.checklist_version, HARDENING_CHECKLIST_VERSION);
  eq(newStyle.hardening_coverage.length, HARDENING_CLASS_COUNT);
  const newErrs = validateVerdict(newStyle);
  eq(newErrs.length, 0, '新 10 项 + 当前 checklist_version 的 verdict 必须零错误: ' + JSON.stringify(newErrs));
});
t('[⑥/审③F4-R] 全绿 → pass；artifact hash 含 base/candidate（只改 SHA 即失效）', () => {
  const { artifact } = consensusFor(bundle);
  eq(artifact.gate_result, 'pass', JSON.stringify(artifact.fail_reasons));
  eq(recomputeArtifactHash(artifact), artifact.consensus_artifact_hash);
  const tampered = { ...artifact, base_sha: SHA_B };
  ok(recomputeArtifactHash(tampered) !== artifact.consensus_artifact_hash, '改 base_sha 必须使 hash 失效');
});
t('[conjunct①] hash 不一致 / 三席合谋伪 hash 被 bundle 重算拦', () => {
  const bad = THREE(); bad[1] = { ...bad[1], review_input_hash: hashObject({ x: 1 }) };
  eq(runConsensusGate(bad, { bundle }).gate_result, 'fail');
  const forged = THREE().map((v) => ({ ...v, review_input_hash: hashObject({ f: 1 }) }));
  eq(runConsensusGate(forged, { bundle }).gate_result, 'fail');
});
t('[审②F2] 一席 closed 另一席同簇 open → fail；都 closed → pass 且 origins 双席', () => {
  const f1 = { id: 'C1', primary_face: 'A', severity: 'blocker', anchor: 'src/x.ts:10', evidence: '同一个竞态问题描述', status: 'closed' };
  const f2open = { id: 'X9', primary_face: 'A', severity: 'blocker', anchor: 'src/x.ts:12', evidence: '同一个竞态问题描述', status: 'open' };
  let r = consensusFor(bundle, [{ findings: [f1], closed_finding_ids: ['C1'] }, { findings: [f2open] }, {}]).artifact;
  eq(r.gate_result, 'fail');
  ok(r.fail_reasons.some((s) => s.includes('X9')));
  const f2closed = { ...f2open, status: 'closed' };
  r = consensusFor(bundle, [{ findings: [f1], closed_finding_ids: ['C1'] }, { findings: [f2closed], closed_finding_ids: ['X9'] }, {}]).artifact;
  eq(r.gate_result, 'pass', JSON.stringify(r.fail_reasons));
  eq(r.canonical_findings.length, 1);
  eq(r.canonical_findings[0].origins.length, 2);
});
t('[⑦/conjunct③④] degraded/缺席/REQUIRES_CHANGES/gate-fail 谎报 → 全 fail', () => {
  const d = THREE(); d[0] = { ...d[0], run_status: 'degraded' };
  eq(runConsensusGate(d, { bundle }).gate_result, 'fail');
  eq(runConsensusGate(THREE().slice(0, 2), { bundle }).gate_result, 'fail');
  const rc = THREE(); rc[1] = { ...rc[1], verdict: 'REQUIRES_CHANGES' };
  eq(runConsensusGate(rc, { bundle }).gate_result, 'fail');
  const liar = THREE();
  liar[2] = { ...liar[2], gate_checks: THIRD_GATES.map((g) => g.gate_id === 'format-gate' ? { ...g, result: 'fail' } : g) };
  eq(runConsensusGate(liar, { bundle }).gate_result, 'fail');
});

// ========== 2. push-guard ==========
console.log('\n[2] SP-3/⑩/R 系 + 审③F3-R/F4-R/F11-R/I6: push-guard（真实 git 仓）');
const repo = mkdtempSync(join(tmpdir(), 'pg-'));
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'fx@test'); git('config', 'user.name', 'fx');
writeFileSync(join(repo, 'a.txt'), '1\n'); git('add', '.'); git('commit', '-qm', 'base');
const BASE = git('rev-parse', 'HEAD');
git('remote', 'add', 'origin', 'https://github.com/o/r.git');
git('remote', 'add', 'upstream', 'https://github.com/up/stream.git');
git('remote', 'add', 'evilhost', 'https://evil.example/o/r.git');
git('update-ref', 'refs/remotes/origin/main', BASE); // fast merge-base 用
git('checkout', '-qb', 'feat');
writeFileSync(join(repo, 'b.txt'), '2\n'); git('add', '.'); git('commit', '-qm', 'feat');
const HEAD = git('rev-parse', 'HEAD');
const constitution = { ...readJson(join(S, 'evolution/constitution-paths.json')) };

// 全量共识流水线（bundle→verdicts→artifact），供各 SHA 变体使用
function pipelineFor(candidateSha, bundleOver = {}) {
  const b = mkBundle(BASE, candidateSha, bundleOver);
  const { artifact } = consensusFor(b);
  const manifest = {
    repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: candidateSha, purpose: 'feature',
    consensus_artifact_hash: artifact.consensus_artifact_hash
  };
  return { bundle: b, artifact, manifest };
}
const P = pipelineFor(HEAD);

t('[SP-3] bundle+artifact+manifest 三方绑定齐备 → PASS，固定 argv 普通 refspec', () => {
  const r = checkPushGuard({ repoDir: repo, manifest: P.manifest, artifact: P.artifact, bundle: P.bundle, constitution });
  ok(r.ok, r.errors.join(';'));
  eq(r.pushArgv, ['git', '-C', repo, 'push', 'origin', `${HEAD}:refs/heads/feat`], 'refspec 源必须钉死为被批 SHA（审④-F1）');
});
t('[F3-R] git config 注册的 -f remote / upstream 冒充 / option branch → 全拒', () => {
  git('config', 'remote.-f.url', 'https://example.invalid/o/r.git'); // 攻击: 注册名为 -f 的 remote
  try {
    ok(git('remote').includes('-f'), '前提: -f 已在 remote 列表');
    for (const bad of [{ remote: '-f' }, { remote: '--mirror' }, { remote: 'notconfigured' }, { branch: '+feat' }, { branch: '-feat' }, { branch: '--delete' }]) {
      ok(!checkPushGuard({ repoDir: repo, manifest: { ...P.manifest, ...bad }, artifact: P.artifact, bundle: P.bundle, constitution }).ok, `应拒: ${JSON.stringify(bad)}`);
    }
    // upstream 已配置但 URL 不指向 o/r → 拒（cindy 只推 fork 的机制保证）
    const r = checkPushGuard({ repoDir: repo, manifest: { ...P.manifest, remote: 'upstream' }, artifact: P.artifact, bundle: P.bundle, constitution });
    ok(!r.ok && r.errors.some((e) => e.includes('push URL 不是')), r.errors.join(';'));
    // 审④-F1: 野 host（evil.example/o/r.git 同 path）→ 拒
    const rEvil = checkPushGuard({ repoDir: repo, manifest: { ...P.manifest, remote: 'evilhost' }, artifact: P.artifact, bundle: P.bundle, constitution });
    ok(!rEvil.ok && rEvil.errors.some((e) => e.includes('push URL 不是')), '野 host 应拒');
    // 审④-F1: pushurl 分离攻击——fetch URL 合法但 pushurl 指向别处
    git('config', 'remote.origin.pushurl', 'https://github.com/attacker/elsewhere.git');
    try {
      const rPush = checkPushGuard({ repoDir: repo, manifest: P.manifest, artifact: P.artifact, bundle: P.bundle, constitution });
      ok(!rPush.ok && rPush.errors.some((e) => e.includes('push URL 不是')), 'pushurl 分离应拒');
    } finally { execFileSync('git', ['-C', repo, 'config', '--unset', 'remote.origin.pushurl']); }
  } finally {
    execFileSync('git', ['-C', repo, 'config', '--remove-section', 'remote.-f']);
  }
});
t('[F4-R] 缺 bundle / bundle 被换 / 伪 artifact / 改 artifact SHA → 全拒', () => {
  ok(!checkPushGuard({ repoDir: repo, manifest: P.manifest, artifact: P.artifact, bundle: null, constitution }).ok, '缺 bundle 应拒');
  const swapped = mkBundle(BASE, HEAD, { pr_title: '被换过的标题' });
  ok(!checkPushGuard({ repoDir: repo, manifest: P.manifest, artifact: P.artifact, bundle: swapped, constitution }).ok, 'bundle 被换应拒');
  const forged = { ...P.artifact, consensus_artifact_hash: 'f'.repeat(64) };
  ok(!checkPushGuard({ repoDir: repo, manifest: { ...P.manifest, consensus_artifact_hash: 'f'.repeat(64) }, artifact: forged, bundle: P.bundle, constitution }).ok);
  const shaSwap = { ...P.artifact, base_sha: HEAD }; // 改 base 但 hash 不重算 → 重算拦
  ok(!checkPushGuard({ repoDir: repo, manifest: P.manifest, artifact: shaSwap, bundle: P.bundle, constitution }).ok, '改 artifact.base_sha 应被重算拦');
});
t('[F4-R] base=HEAD 藏 CI diff 的全变体被堵（含拿到新 candidate 共识的变体）', () => {
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/x.yml'), 'on: push\n');
  git('add', '.'); git('commit', '-qm', 'ci');
  const h2 = git('rev-parse', 'HEAD');
  // 变体1: 旧 artifact + 新 expected → candidate 绑定拦
  let r = checkPushGuard({ repoDir: repo, manifest: { ...P.manifest, expected_sha: h2 }, artifact: P.artifact, bundle: P.bundle, constitution });
  ok(!r.ok, '变体1 应拒');
  // 变体2: 为 h2 走完整共识（base 仍是 artifact 的 BASE）→ CI 路径照样被 diff 看见
  const P2 = pipelineFor(h2);
  r = checkPushGuard({ repoDir: repo, manifest: P2.manifest, artifact: P2.artifact, bundle: P2.bundle, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('CI 路径')), r.errors.join(';'));
  git('reset', '-q', '--hard', HEAD);
});
t('[⑩] SHA 漂移 / 脏工作区 → 拦', () => {
  ok(!checkPushGuard({ repoDir: repo, manifest: { ...P.manifest, expected_sha: BASE }, artifact: P.artifact, bundle: P.bundle, constitution }).ok);
  writeFileSync(join(repo, 'dirty.txt'), 'x');
  const r = checkPushGuard({ repoDir: repo, manifest: P.manifest, artifact: P.artifact, bundle: P.bundle, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('不 clean')));
  execFileSync('rm', [join(repo, 'dirty.txt')]);
});
function fastSig(m, key = FAST_KEY) {
  return createHmac('sha256', key).update(fastSignaturePayload(m)).digest('hex');
}
function mkFastManifest(over = {}, atOver = {}) {
  const ledgerF = join(mkdtempSync(join(tmpdir(), 'fl-')), 'fast-ledger.jsonl');
  const m = {
    repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: HEAD, purpose: 'fast',
    base_branch: 'main',
    fast_attestation: {
      reason: '紧急热修', ledger_file: ledgerF,
      expires_at: new Date(Date.now() + 600000).toISOString(), signature: '', ...atOver
    },
    ...over
  };
  m.fast_attestation.signature = fastSig(m);
  return m;
}
t('[审④F2] fast v2 全字段签名: 无 key 拒 / 逐字段 mutation 拒 / 过期拒 / 正签放行且 base 自算+自写 ledger / CI 守卫不跳', () => {
  const fastM = mkFastManifest({ base: SHA_A }); // 自报 base 应被忽略
  ok(!checkPushGuard({ repoDir: repo, manifest: fastM, constitution, fastKey: null }).ok, '无 key（自动会话）应拒');
  // 逐字段 mutation: 签完再改任一受保护字段 → 拒
  for (const mut of [
    { remote: 'upstream' }, { base_branch: 'feat' },
  ]) {
    const m2 = { ...mkFastManifest(), ...mut };
    ok(!checkPushGuard({ repoDir: repo, manifest: m2, constitution, fastKey: FAST_KEY }).ok, `签后改 ${JSON.stringify(mut)} 应拒`);
  }
  for (const atMut of [{ reason: '被改的理由' }, { ledger_file: '/tmp/elsewhere.jsonl' }]) {
    const m3 = mkFastManifest();
    Object.assign(m3.fast_attestation, atMut); // 签完再改 attestation 字段
    ok(!checkPushGuard({ repoDir: repo, manifest: m3, constitution, fastKey: FAST_KEY }).ok, `签后改 ${JSON.stringify(atMut)} 应拒`);
  }
  // 过期 attestation
  const expired = mkFastManifest({}, { expires_at: new Date(Date.now() - 1000).toISOString() });
  ok(!checkPushGuard({ repoDir: repo, manifest: expired, constitution, fastKey: FAST_KEY }).ok, '过期应拒');
  // 正签放行（审⑤-I2: 宪法必须钉 fast_ledger_path 且与 manifest 一致才可能放行）
  const cWithFast = { ...constitution, fast_ledger_path: fastM.fast_attestation.ledger_file };
  const r = checkPushGuard({ repoDir: repo, manifest: fastM, constitution: cWithFast, fastKey: FAST_KEY });
  ok(r.ok, r.errors.join(';'));
  eq(r.changed, ['b.txt'], 'base 必须来自守卫自算的 merge-base（自报 SHA_A 无效）');
  ok(readFileSync(fastM.fast_attestation.ledger_file, 'utf8').includes('fast-bypass'), '守卫自写 ledger');
  // 审⑤-I2: constitution 缺 fast_ledger_path → fail-closed（不再静默跳过固定校验）
  const cNoFast = { ...constitution }; delete cNoFast.fast_ledger_path;
  const rNo = checkPushGuard({ repoDir: repo, manifest: fastM, constitution: cNoFast, fastKey: FAST_KEY });
  ok(!rNo.ok && rNo.errors.some((e) => e.includes('缺 fast_ledger_path')), '宪法缺 fast_ledger_path 应拒');
  // 审④-F2: constitution 固定 fast ledger 路径时，别处 ledger 拒
  const otherLedger = mkFastManifest();
  ok(!checkPushGuard({ repoDir: repo, manifest: otherLedger, constitution: cWithFast, fastKey: FAST_KEY }).ok, '非固定 ledger 路径应拒');
  // CI 路径守卫不跳
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/y.yml'), 'on: push\n');
  git('add', '.'); git('commit', '-qm', 'ci2');
  const h3 = git('rev-parse', 'HEAD');
  const fastM2 = mkFastManifest({ expected_sha: h3 });
  const r2 = checkPushGuard({ repoDir: repo, manifest: fastM2, constitution: { ...constitution, fast_ledger_path: fastM2.fast_attestation.ledger_file }, fastKey: FAST_KEY });
  ok(!r2.ok && r2.errors.some((e) => e.includes('CI 路径')), 'fast 不得跳 CI 守卫');
  git('reset', '-q', '--hard', HEAD);
});
t('[审④F1] branch ref 分叉（审 A 推 B）→ 拒', () => {
  // 把 feat ref 悄悄指到 BASE，HEAD 仍在原 commit（detached 场景近似）
  git('checkout', '-q', '--detach', HEAD);
  git('branch', '-f', 'feat', BASE);
  const r = checkPushGuard({ repoDir: repo, manifest: P.manifest, artifact: P.artifact, bundle: P.bundle, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('branch ref 分叉')), r.errors.join(';'));
  git('branch', '-f', 'feat', HEAD);
  git('checkout', '-q', 'feat');
});

// evolution（专用 worktree）
const evoWt = join(mkdtempSync(join(tmpdir(), 'evwt-')), 'wt');
git('worktree', 'add', '-q', '-b', 'evolve-t', evoWt, BASE);
const gitW = (...a) => execFileSync('git', ['-C', evoWt, ...a], { encoding: 'utf8' }).trim();
const PL_DIR = mkdtempSync(join(tmpdir(), 'pl-'));
const PROPOSAL_LEDGER = join(PL_DIR, 'proposal-ledger.jsonl');
const ESCAPE_LEDGER = join(PL_DIR, 'escape-ledger.jsonl');
constitution.proposal_ledger_path = PROPOSAL_LEDGER; // fixture 注入固定路径
constitution.escape_ledger_path = ESCAPE_LEDGER; // 洞B: escape 台账源同样固定
// 造两条真实台账条目供 ledger_ids 引用
const led1 = appendLedger({ ledgerFile: ESCAPE_LEDGER, entry: { channel: 'E2', pattern_key: 'registry-miss:src/render', instance_key: 'PR#1', summary: 'x' } });
const led2 = appendLedger({ ledgerFile: ESCAPE_LEDGER, entry: { channel: 'E2', pattern_key: 'registry-miss:src/render', instance_key: 'PR#2', summary: 'y' } });

function evoPipeline(candidateSha, evoOver = {}) {
  const b = mkBundle(BASE, candidateSha);
  const { artifact } = consensusFor(b);
  const manifest = {
    repo: 'o/r', remote: 'origin', branch: 'evolve-t', expected_sha: candidateSha, purpose: 'evolution',
    consensus_artifact_hash: artifact.consensus_artifact_hash,
    evolution: { ledger_ids: [led1.id], ledger_file: ESCAPE_LEDGER, proposal_ledger: PROPOSAL_LEDGER, ...evoOver }
  };
  return { bundle: b, artifact, manifest };
}

t('[R3/R7/R10] evolution: 白名单+非空 fixture+worktree+真实 ledger id → 放行；白名单外拦', () => {
  mkdirSync(join(evoWt, 'scripts/ui-paths'), { recursive: true });
  mkdirSync(join(evoWt, 'fixtures'), { recursive: true });
  writeFileSync(join(evoWt, 'scripts/ui-paths/registry.mivo.json'), '{"ui_globs":["src/app/**"]}\n');
  writeFileSync(join(evoWt, 'fixtures/regress-registry.json'), '{"case":"src/render 命中断言","expect":true}\n');
  gitW('add', '.'); gitW('commit', '-qm', 'tighten');
  let h = gitW('rev-parse', 'HEAD');
  let E = evoPipeline(h);
  let r = checkPushGuard({ repoDir: evoWt, manifest: E.manifest, artifact: E.artifact, bundle: E.bundle, constitution });
  ok(r.ok, r.errors.join(';'));
  writeFileSync(join(evoWt, 'x.tmp'), 'x'); gitW('add', '.'); gitW('commit', '-qm', 'wl-out');
  h = gitW('rev-parse', 'HEAD'); E = evoPipeline(h);
  r = checkPushGuard({ repoDir: evoWt, manifest: E.manifest, artifact: E.artifact, bundle: E.bundle, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('白名单')));
  gitW('reset', '-q', '--hard', 'HEAD~1');
});
t('[审③F11-R] purpose 降级伪装被拦: registry diff + purpose=feature → 拒', () => {
  const h = gitW('rev-parse', 'HEAD');
  const b = mkBundle(BASE, h);
  const { artifact } = consensusFor(b);
  const m = {
    repo: 'o/r', remote: 'origin', branch: 'evolve-t', expected_sha: h, purpose: 'feature',
    consensus_artifact_hash: artifact.consensus_artifact_hash
  };
  const r = checkPushGuard({ repoDir: evoWt, manifest: m, artifact, bundle: b, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('降级伪装')), r.errors.join(';'));
});
t('[审③F11-R] 伪造 ledger id / 空 fixture / 自带 proposal_ledger 路径 → 全拒', () => {
  const h = gitW('rev-parse', 'HEAD');
  let E = evoPipeline(h, { ledger_ids: ['deadbeef00000000'] });
  let r = checkPushGuard({ repoDir: evoWt, manifest: E.manifest, artifact: E.artifact, bundle: E.bundle, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('不存在')), '伪造 ledger id 应拒');
  E = evoPipeline(h, { proposal_ledger: join(PL_DIR, 'my-own-empty.jsonl') });
  r = checkPushGuard({ repoDir: evoWt, manifest: E.manifest, artifact: E.artifact, bundle: E.bundle, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('固定路径')), '自带账本应拒');
  // 空 fixture
  writeFileSync(join(evoWt, 'fixtures/empty.json'), ' \n');
  gitW('add', '.'); gitW('commit', '-qm', 'empty fixture');
  const h2 = gitW('rev-parse', 'HEAD');
  E = evoPipeline(h2);
  r = checkPushGuard({ repoDir: evoWt, manifest: E.manifest, artifact: E.artifact, bundle: E.bundle, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('无实质内容')), '空 fixture 应拒');
  gitW('reset', '-q', '--hard', 'HEAD~1');
});
t('[审③F11-R] JSON 单调: 删数组元素/改键值 → 拒；纯追加 → 放（jsonSubset 单元）', () => {
  ok(jsonSubset({ a: [1, 2], b: 'x' }, { a: [1, 2, 3], b: 'x', c: 1 }), '追加应过');
  ok(!jsonSubset({ a: [1, 2] }, { a: [1] }), '删元素应拒');
  ok(!jsonSubset({ b: 'x' }, { b: 'y' }), '改值应拒');
  const f = 'scripts/ui-paths/registry.mivo.json';
  const prev = gitW('rev-parse', 'HEAD');
  writeFileSync(join(evoWt, f), '{"ui_globs":[]}\n');
  gitW('add', '.'); gitW('commit', '-qm', 'loosen');
  ok(!directionCheck(evoWt, prev, f).ok, '删 glob 应判扩权');
  gitW('reset', '-q', '--hard', prev);
});
t('[R10/R8] 主 checkout 跑 evolution 拒；周 3 提案后第 4 个拒', () => {
  const h = git('rev-parse', 'HEAD');
  const b = mkBundle(BASE, h);
  const { artifact } = consensusFor(b);
  const m = { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: h, purpose: 'evolution', consensus_artifact_hash: artifact.consensus_artifact_hash, evolution: { ledger_ids: [led1.id], ledger_file: ESCAPE_LEDGER, proposal_ledger: PROPOSAL_LEDGER } };
  let r = checkPushGuard({ repoDir: repo, manifest: m, artifact, bundle: b, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('worktree') || e.includes('fixture')), r.errors.join(';'));
  const now = new Date().toISOString();
  writeFileSync(PROPOSAL_LEDGER, ['p1', 'p2', 'p3'].map((p) => JSON.stringify({ at: now, kind: 'proposal', pattern_key: p })).join('\n') + '\n');
  const h2 = gitW('rev-parse', 'HEAD');
  const E = evoPipeline(h2);
  r = checkPushGuard({ repoDir: evoWt, manifest: E.manifest, artifact: E.artifact, bundle: E.bundle, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('R8')), r.errors.join(';'));
  writeFileSync(PROPOSAL_LEDGER, ''); // 清场
});
t('[e2e-pushguard 洞A] fast ledger symlink 黑洞 → 拒（审计必须真实落盘）', () => {
  const holeDir = mkdtempSync(join(tmpdir(), 'hole-'));
  const holeLedger = join(holeDir, 'ledger.jsonl');
  execFileSync('ln', ['-s', '/dev/null', holeLedger]);
  const m = mkFastManifest({}, { ledger_file: holeLedger });
  // 宪法钉到同一路径——专门让 symlink 检查成为被考项（而非固定路径不匹配先拦）
  const r = checkPushGuard({ repoDir: repo, manifest: m, constitution: { ...constitution, fast_ledger_path: holeLedger }, fastKey: FAST_KEY });
  ok(!r.ok && r.errors.some((e) => e.includes('审计黑洞')), r.errors.join(';'));
});
t('[e2e-pushguard 洞B] evolution 自带 ledger_file 伪造台账源 → 拒', () => {
  // 攻击: 自建 jsonl 放伪造 id，ledger_ids 引它，proposal_ledger 用合法路径
  const fakeDir = mkdtempSync(join(tmpdir(), 'fake-'));
  const fakeLedger = join(fakeDir, 'fake.jsonl');
  writeFileSync(fakeLedger, JSON.stringify({ id: 'forged0001', kind: 'event', channel: 'E2', at: new Date().toISOString(), prev: 'GENESIS' }) + '\n');
  const h = gitW('rev-parse', 'HEAD');
  const b = mkBundle(BASE, h);
  const { artifact } = consensusFor(b);
  const m = {
    repo: 'o/r', remote: 'origin', branch: 'evolve-t', expected_sha: h, purpose: 'evolution',
    consensus_artifact_hash: artifact.consensus_artifact_hash,
    evolution: { ledger_ids: ['forged0001'], ledger_file: fakeLedger, proposal_ledger: PROPOSAL_LEDGER }
  };
  const r = checkPushGuard({ repoDir: evoWt, manifest: m, artifact, bundle: b, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('固定台账源')), r.errors.join(';'));
});
t('[审④I1] R10: 白名单目录里叫 fixture 的 md 不算回归 fixture（必须在 fixtures/ 根下）', () => {
  const h0 = gitW('rev-parse', 'HEAD');
  gitW('checkout', '-qb', 'evolve-i1', BASE); // 干净基线: diff 只含本用例文件
  mkdirSync(join(evoWt, 'docs/evolution-proposals'), { recursive: true });
  mkdirSync(join(evoWt, 'scripts/ui-paths'), { recursive: true });
  writeFileSync(join(evoWt, 'docs/evolution-proposals/fake-fixture.md'), '看起来像 fixture 但不是，超过十个字节。\n');
  writeFileSync(join(evoWt, 'scripts/ui-paths/registry.mivo.json'), '{"ui_globs":["src/app/**","src/render/**"]}\n');
  gitW('add', '.'); gitW('commit', '-qm', 'fake fixture');
  const h = gitW('rev-parse', 'HEAD');
  const b = mkBundle(BASE, h);
  const { artifact } = consensusFor(b);
  const manifest = {
    repo: 'o/r', remote: 'origin', branch: 'evolve-i1', expected_sha: h, purpose: 'evolution',
    consensus_artifact_hash: artifact.consensus_artifact_hash,
    evolution: { ledger_ids: [led1.id], ledger_file: ESCAPE_LEDGER, proposal_ledger: PROPOSAL_LEDGER }
  };
  const r = checkPushGuard({ repoDir: evoWt, manifest, artifact, bundle: b, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('fixtures/ 根目录')), r.errors.join(';'));
  gitW('checkout', '-q', 'evolve-t'); gitW('reset', '-q', '--hard', h0);
});
t('[F4] quoted/Unicode CI 路径不被 quote 掩护', () => {
  const weird = '.github/workflows/危 险.yml';
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, weird), 'on: push\n');
  git('add', '.'); git('commit', '-qm', 'unicode ci');
  const h = git('rev-parse', 'HEAD');
  const Pu = pipelineFor(h);
  const r = checkPushGuard({ repoDir: repo, manifest: Pu.manifest, artifact: Pu.artifact, bundle: Pu.bundle, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('CI 路径')));
  git('reset', '-q', '--hard', HEAD);
});

// ========== 3. ci-readiness ==========
console.log('\n[3] W-3 + 审②I4: ciReadiness exact-head');
const CK = (over = {}) => ({ context: 'ci/build', state: 'success', head_sha: SHA_A, completed_at: '2026-07-31T10:00:00Z', run_id: '1', ...over });
t('[I4] exact-head / 时间排序双向 / fail-closed 全组', () => {
  eq(ciReadiness({ headSha: SHA_B, checks: [CK()], required: ['ci/build'] }).green, false, '旧 head success 不判绿');
  eq(ciReadiness({ headSha: SHA_A, checks: [CK({ completed_at: '2026-07-31T11:00:00Z', state: 'failure', run_id: '2' }), CK()], required: ['ci/build'] }).green, false);
  eq(ciReadiness({ headSha: SHA_A, checks: [CK({ state: 'failure' }), CK({ completed_at: '2026-07-31T11:00:00Z', run_id: '2' })], required: ['ci/build'] }).green, true);
  eq(ciReadiness({ headSha: SHA_A, checks: [CK({ completed_at: null })], required: ['ci/build'] }).green, false);
  eq(ciReadiness({ headSha: SHA_A, checks: [CK(), CK({ state: 'failure', run_id: '2' })], required: ['ci/build'] }).green, false, '同刻冲突');
  eq(ciReadiness({ headSha: SHA_A, checks: [], required: ['ci/build'] }).green, false);
  eq(ciReadiness({ headSha: SHA_A, checks: [CK({ state: 'pending' })], required: ['ci/build'] }).green, false);
  eq(ciReadiness({ headSha: SHA_A, checks: null, required: ['ci/build'] }).green, false);
  eq(ciReadiness({ headSha: SHA_A, checks: [CK()], required: [] }).green, false);
});

// ========== 4. ui-paths ==========
console.log('\n[4] ⑫: UI 判定唯一源');
const mivoReg = readJson(join(S, 'ui-paths/registry.mivo.json'));
t('[⑫] mivo/cindy 命中矩阵 + config_hash 敏感', () => {
  const r = matchUiPaths(mivoReg, ['src/app/TopBar.tsx', 'src/canvas/CanvasRoot.tsx', 'server/lib/config.ts']);
  eq(r.touches_ui, true);
  eq(r.matched_paths, ['src/app/TopBar.tsx', 'src/canvas/CanvasRoot.tsx']);
  eq(matchUiPaths(mivoReg, ['server/routes/generate.ts']).touches_ui, false);
  eq(matchUiPaths(mivoReg, ['src/app/TopBar.test.ts']).touches_ui, false);
  ok(matchUiPaths(mivoReg, []).config_hash !== matchUiPaths({ ...mivoReg, ui_globs: [...mivoReg.ui_globs, 'x/**'] }, []).config_hash);
  eq(matchUiPaths(readJson(join(S, 'ui-paths/registry.cindy.json')), ['apps/desktop/src/renderer/App.tsx']).touches_ui, true);
});

// ========== 5. gate ==========
console.log('\n[5] W-3 + 审②F7 + 审③F7-R: 游标化信号判定');
const snapBase = {
  state: 'open', head_sha: SHA_A,
  ci: { green: true, failing: [], head_sha: SHA_A },
  reviews: [], comments: [], labels: [], mergeable: true
};
t('[F7] 旧评论+新 head 不唤醒 / 同 head 新 node 唤醒一次 / stale review 不唤醒', () => {
  let r = evaluate(null, { ...snapBase, comments: [{ id: 'c1', body: '旧评论' }] });
  eq(r.decision, 'actionable');
  eq(evaluate(r.cursors, { ...snapBase, head_sha: SHA_B, ci: { green: true, failing: [], head_sha: SHA_B }, comments: [{ id: 'c1', body: '旧评论' }] }).decision, 'none');
  r = evaluate(emptyCursors(), { ...snapBase, comments: [{ id: 'c2', body: '新评论' }] });
  eq(evaluate(r.cursors, { ...snapBase, comments: [{ id: 'c2', body: '新评论' }] }).decision, 'none');
  const c0 = emptyCursors();
  eq(evaluate(c0, { ...snapBase, reviews: [{ id: 'r1', state: 'CHANGES_REQUESTED', commitOid: SHA_A, outdated: true }] }).decision, 'none');
  eq(evaluate(c0, { ...snapBase, reviews: [{ id: 'r2', state: 'CHANGES_REQUESTED', commitOid: SHA_A, dismissed: true }] }).decision, 'none');
  eq(evaluate(c0, { ...snapBase, reviews: [{ id: 'r3', state: 'CHANGES_REQUESTED', commitOid: SHA_B }] }).decision, 'none');
  eq(evaluate(c0, { ...snapBase, reviews: [{ id: 'r4', state: 'CHANGES_REQUESTED', commitOid: SHA_A }] }).decision, 'actionable');
});
t('[F7] provenance HMAC: 自家评论不唤醒/篡改验不过/他人评论唤醒', () => {
  const signed = signMarker('机器人回帖: dispatch:abc 已修复', HMAC_KEY);
  ok(verifyMarker(signed, HMAC_KEY));
  ok(!verifyMarker(signed + '篡改', HMAC_KEY));
  eq(evaluate(emptyCursors(), { ...snapBase, comments: [{ id: 'c9', body: signed }] }, { hmacKey: HMAC_KEY }).decision, 'none');
  eq(evaluate(emptyCursors(), { ...snapBase, comments: [{ id: 'c10', body: '人类评论' }] }, { hmacKey: HMAC_KEY }).decision, 'actionable');
});
t('[审③F7-R] hold 不消费游标: hold 期间新评论 → 解除 hold 后仍 actionable 恰一次', () => {
  const c0 = emptyCursors();
  const held = evaluate(c0, { ...snapBase, labels: ['hold'], comments: [{ id: 'h1', body: '签字期间的反馈' }] });
  eq(held.decision, 'blocked-external');
  eq(held.cursors, c0, 'hold 期间游标必须原样');
  // 持续 hold: 不派活（引擎 blocked 分支不投递），游标仍不动
  const held2 = evaluate(held.cursors, { ...snapBase, labels: ['hold'], comments: [{ id: 'h1', body: '签字期间的反馈' }] });
  eq(held2.decision, 'blocked-external');
  // 解除 hold → 同一评论必须唤醒
  const after = evaluate(held2.cursors, { ...snapBase, comments: [{ id: 'h1', body: '签字期间的反馈' }] });
  eq(after.decision, 'actionable');
  eq(evaluate(after.cursors, { ...snapBase, comments: [{ id: 'h1', body: '签字期间的反馈' }] }).decision, 'none', '消费一次后不重复');
});
t('[W-3] ci 红 exact-head 且同 head 一次 / merged terminal', () => {
  const c0 = emptyCursors();
  eq(evaluate(c0, { ...snapBase, ci: { green: false, failing: ['x'], head_sha: SHA_B } }).decision, 'none');
  let r = evaluate(c0, { ...snapBase, ci: { green: false, failing: ['x'], head_sha: SHA_A } });
  eq(r.decision, 'actionable');
  eq(evaluate(r.cursors, { ...snapBase, ci: { green: false, failing: ['x'], head_sha: SHA_A } }).decision, 'none');
  eq(evaluate(c0, { ...snapBase, state: 'merged' }).decision, 'terminal');
});

// ========== 6. 引擎状态机 ==========
console.log('\n[6] W 系 + 审③F14/F13-R/F6-R/I2-R: 引擎·锁·预算·完工收口');
const engDir = mkdtempSync(join(tmpdir(), 'eng-'));
const engState = join(engDir, 'state');
const lease = join(engDir, 'lease.json');
mkdirSync(engState, { recursive: true });
const snapFile = join(engDir, 'snap.json');
const dispatchLog = join(engDir, 'dispatch.log');
writeFileSync(join(engDir, 'snap.sh'), `#!/bin/sh\ncat "${snapFile}"\n`);
writeFileSync(join(engDir, 'dispatch-ok.sh'), `#!/bin/sh\ncat >> "${dispatchLog}"\necho "" >> "${dispatchLog}"\n`);
writeFileSync(join(engDir, 'notify.sh'), `#!/bin/sh\ncat >> "${join(engDir, 'notify.log')}"\necho "" >> "${join(engDir, 'notify.log')}"\n`);
for (const f of ['snap.sh', 'dispatch-ok.sh', 'notify.sh']) execFileSync('chmod', ['+x', join(engDir, f)]);
// 终态清理需要 repoDirs（I2-R fail-closed）——建一个默认业务仓
const bizRepo = mkdtempSync(join(tmpdir(), 'biz-'));
{
  const g = (...a) => execFileSync('git', ['-C', bizRepo, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'x@t'); g('config', 'user.name', 'x');
  writeFileSync(join(bizRepo, 'f.txt'), '1'); g('add', '.'); g('commit', '-qm', 'i');
}
const BUDGET = () => ({ ledger: join(engDir, `budget-${Math.random().toString(36).slice(2)}.jsonl`), cap: 10000, estimate: 1 });
const ENG = (over = {}) => ({
  stateDir: engState, leaseFile: lease,
  snapshotCmd: join(engDir, 'snap.sh') + ' {owner} {repo} {pr}',
  dispatchCmd: join(engDir, 'dispatch-ok.sh'),
  journalFile: join(engDir, 'journal.jsonl'),
  feishuCmd: join(engDir, 'notify.sh'), slackCmd: join(engDir, 'notify.sh'),
  hmacKey: HMAC_KEY,
  budget: BUDGET(),
  repoDirs: { 'o/mivo-canvas': bizRepo },
  ...over
});

t('[审③F13-R] budget 配置缺失 → 引擎启动拒绝（fail-closed）', () => {
  let threw = false;
  try { runEngine({ ...ENG(), budget: null }); } catch (e) { threw = /budget/.test(e.message); }
  ok(threw, '缺 budget 必须拒启动');
});
t('[I6-空转] 空 state → 秒退且写 lease', () => {
  const r = runEngine(ENG());
  ok(r.quiet && r.scanned === 0);
  ok(existsSync(lease));
});
const sharedBudget = BUDGET();
t('[F6] ack 前游标不推进/不叠派；错 id ack 拒；ack 后推进不再唤醒', () => {
  registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 5, branch: 'feat', pushRemote: 'origin' });
  writeFileSync(snapFile, JSON.stringify(snapBase));
  runEngine(ENG({ budget: sharedBudget }));
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, comments: [{ id: 'k1', body: '请修' }] }));
  let r = runEngine(ENG({ budget: sharedBudget }));
  eq(r.dispatched.length, 1);
  const stFile = join(engState, stateFileName('o', 'mivo-canvas', 5));
  const st1 = readJson(stFile);
  ok(st1.pending_dispatch && !(st1.cursors?.comment_ids ?? []).includes('k1'));
  eq(runEngine(ENG({ budget: sharedBudget })).dispatched.length, 0, '未 ack 不叠派');
  ok(!ackDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 5, dispatchId: 'wrong' }).ok);
  ok(ackDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 5, dispatchId: st1.pending_dispatch.dispatch_id }).ok);
  const st2 = readJson(stFile);
  ok(st2.pending_dispatch === null && st2.cursors.comment_ids.includes('k1'));
  eq(runEngine(ENG({ budget: sharedBudget })).dispatched.length, 0);
});
t('[F6] lease 过期重派同 id；≥3 次 stuck → mivo 飞书', () => {
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, comments: [{ id: 'k1', body: '请修' }, { id: 'k2', body: '再修' }] }));
  let r = runEngine(ENG({ budget: sharedBudget }));
  eq(r.dispatched.length, 1);
  const stFile = join(engState, stateFileName('o', 'mivo-canvas', 5));
  const origId = readJson(stFile).pending_dispatch.dispatch_id;
  for (let i = 1; i <= 3; i++) {
    const st = readJson(stFile);
    st.pending_dispatch.dispatched_at = new Date(Date.now() - 60 * 60000).toISOString();
    writeFileSync(stFile, JSON.stringify(st));
    r = runEngine(ENG({ budget: sharedBudget }));
    eq(r.redispatched.length, 1);
    eq(readJson(stFile).pending_dispatch.dispatch_id, origId);
  }
  ok(r.stuck.length === 1);
  ok(readFileSync(join(engDir, 'notify.log'), 'utf8').includes('挂死'));
  ackDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 5, dispatchId: origId });
});
t('[W-8] 路由: cindy stuck 静默/mivo 飞书/budget 飞书/broadcast slack/未知拒', () => {
  eq(route('stuck', { repo: 'cindy' }), 'silent');
  eq(route('stuck', { repo: 'mivo-canvas' }), 'feishu');
  eq(route('budget-pause', {}), 'feishu');
  eq(route('broadcast', {}), 'slack');
  let threw = false; try { route('mystery', {}); } catch { threw = true; }
  ok(threw);
});
t('[审④F7] 预算 v3: 29+9 拦 / 同 id 重复 reserve 幂等 / release 归零 / 负数与 NaN actual 拒 / 双 actual 只认第一条', () => {
  const bl = join(engDir, 'b29.jsonl');
  recordCost(bl, { cost_usd: 29, note: 'today' });
  ok(!reserveBudget({ ledgerFile: bl, capUsd: 30, estimateUsd: 9, dispatchId: 'd1' }).allowed, '29+9>30 必须拦');
  ok(reserveBudget({ ledgerFile: bl, capUsd: 40, estimateUsd: 9, dispatchId: 'd2' }).allowed);
  eq(spentToday(bl), 38);
  // 同 id 重复 reserve → 幂等不加额
  ok(reserveBudget({ ledgerFile: bl, capUsd: 40, estimateUsd: 9, dispatchId: 'd2' }).allowed);
  eq(spentToday(bl), 38, '重复 reserve 不得加额');
  recordCost(bl, { cost_usd: 5, kind: 'actual', dispatch_id: 'd2' });
  eq(spentToday(bl), 34, 'actual(5) 取代 reserve(9)');
  // 第二条 actual 同 id → 只认第一条
  recordCost(bl, { cost_usd: 100, kind: 'actual', dispatch_id: 'd2' });
  eq(spentToday(bl), 34, '双 actual 只认第一条');
  // release: reserve 后失败释放
  ok(reserveBudget({ ledgerFile: bl, capUsd: 60, estimateUsd: 9, dispatchId: 'd3' }).allowed);
  eq(spentToday(bl), 43);
  releaseReserve({ ledgerFile: bl, dispatchId: 'd3' });
  eq(spentToday(bl), 34, 'release 后预算回落');
  // 负数/NaN actual 洗账被拒
  let threw = false; try { recordCost(bl, { cost_usd: -20, kind: 'actual' }); } catch { threw = true; }
  ok(threw, '负数 actual 应拒');
  threw = false; try { recordCost(bl, { cost_usd: NaN, kind: 'actual' }); } catch { threw = true; }
  ok(threw, 'NaN actual 应拒');
  ok(!reserveBudget({ ledgerFile: bl, capUsd: 40, estimateUsd: undefined, dispatchId: 'd4' }).allowed);
  ok(!budgetCheck({ ledgerFile: bl, capUsd: null }).allowed);
});
t('[审④F7] 引擎 dispatch 失败 → 预留自动释放，预算不漂', () => {
  const bl = join(engDir, 'bfail.jsonl');
  const failSh = join(engDir, 'dfail.sh');
  writeFileSync(failSh, '#!/bin/sh\nexit 1\n');
  execFileSync('chmod', ['+x', failSh]);
  registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 6, branch: 'f6', pushRemote: 'origin' });
  writeFileSync(snapFile, JSON.stringify(snapBase));
  runEngine(ENG({ budget: { ledger: bl, cap: 100, estimate: 9 } })); // 首扫
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, comments: [{ id: 'q1', body: 'x' }] }));
  for (let i = 0; i < 3; i++) runEngine(ENG({ budget: { ledger: bl, cap: 100, estimate: 9 }, dispatchCmd: failSh }));
  eq(spentToday(bl), 0, '3 次投递失败后预算必须为 0（reserve 全部 release）');
  unregisterPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 6 });
});
t('[F13] 引擎预算暂停: 不派活+通知一次/天+游标不推进；恢复后补派', () => {
  const bl = join(engDir, 'bpause.jsonl');
  recordCost(bl, { cost_usd: 31, note: 'over' });
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, comments: [{ id: 'k1', body: 'x' }, { id: 'k2', body: 'y' }, { id: 'k3', body: 'z' }] }));
  const nLen = () => existsSync(join(engDir, 'notify.log')) ? readFileSync(join(engDir, 'notify.log'), 'utf8').length : 0;
  const before = nLen();
  let r = runEngine(ENG({ budget: { ledger: bl, cap: 30, estimate: 1 } }));
  ok(r.paused); eq(r.dispatched.length, 0);
  ok(nLen() > before);
  const afterFirst = nLen();
  runEngine(ENG({ budget: { ledger: bl, cap: 30, estimate: 1 } }));
  eq(nLen(), afterFirst, '同日不重复通知');
  r = runEngine(ENG({ budget: { ledger: bl, cap: 100, estimate: 1 } }));
  eq(r.dispatched.length, 1, '恢复后补派');
  const st = readJson(join(engState, stateFileName('o', 'mivo-canvas', 5)));
  ackDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 5, dispatchId: st.pending_dispatch.dispatch_id });
});
t('[审④F6] 锁语义: 活持有者不被抢 / 死 pid 陈锁可抢 / 旧 release 不删新锁', () => {
  const lkDir = mkdtempSync(join(tmpdir(), 'lk2-'));
  const lk = join(lkDir, 'x.lock');
  // 活持有者 + 老 mtime → 不可抢（超时抛错）
  const release = acquireLock(lk);
  execFileSync('touch', ['-t', '202001010000', lk]);
  let threw = false;
  try { acquireLock(lk, { timeoutMs: 400 }); } catch { threw = true; }
  ok(threw, '活持有者（本进程 pid）不得被 mtime 抢占');
  release();
  // 死 pid 陈锁 → 可抢
  mkdirSync(lk);
  writeFileSync(join(lk, 'owner.json'), JSON.stringify({ token: 'dead', pid: 4009999, at: 0 }));
  execFileSync('touch', ['-t', '202001010000', lk]);
  const rel2 = acquireLock(lk, { timeoutMs: 2000 });
  ok(typeof rel2 === 'function', '死 pid 陈锁应被抢占');
  // 旧 release 不删新锁: rel2 持有中，构造一个旧 token 的 release 行为——直接再调 rel2 之外的假释放
  // （release 闭包带 token 校验，模拟: 手改 owner token 后调用 rel2 → 不得删）
  writeFileSync(join(lk, 'owner.json'), JSON.stringify({ token: 'someone-else', pid: process.pid, at: Date.now() }));
  rel2();
  ok(existsSync(lk), '旧 release 不得删除他人持有的锁');
  execFileSync('rm', ['-rf', lk]);
});
t('[审③F14] 锁原子性: 双进程各 50 次锁内读改写，计数恰为 100（丢更新即失败）', () => {
  const lockDir = mkdtempSync(join(tmpdir(), 'lk-'));
  const counterFile = join(lockDir, 'counter.json');
  writeFileSync(counterFile, '{"n":0}');
  const script = `
    const { withLock } = await import('${join(S, 'lib/state-lock.mjs')}');
    const fs = await import('node:fs');
    for (let i = 0; i < 50; i++) {
      withLock('${counterFile}.lock', () => {
        const v = JSON.parse(fs.readFileSync('${counterFile}', 'utf8'));
        fs.writeFileSync('${counterFile}', JSON.stringify({ n: v.n + 1 }));
      });
    }`;
  const procs = [0, 1].map(() => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    p.on('exit', (c) => c === 0 ? res() : rej(new Error(`exit ${c}`)));
  }));
  return Promise.all(procs).then(() => {
    eq(readJson(counterFile).n, 100, '并发丢更新');
  });
});
t('[审④F4] complete 只认 receipt: 无 receipt 拒 / 跨任务 receipt 拒 / push 缺 / 回帖缺 / 两项齐才 ack', () => {
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, comments: [{ id: 'k4', body: '新反馈' }] }));
  const r = runEngine(ENG({ budget: sharedBudget }));
  eq(r.dispatched.length, 1);
  const stFile = join(engState, stateFileName('o', 'mivo-canvas', 5));
  const pd = readJson(stFile).pending_dispatch;
  const manifest = pd.manifest;
  const candidate = 'e'.repeat(40);
  const signed = signMarker(`已修复，dispatch:${manifest.dispatch_id}`, HMAC_KEY);
  const snapDone = { ...snapBase, head_sha: candidate, comments: [{ id: 'z', body: signed }] };
  // 攻击: 无 receipt 凭空声称完工（original==snapshot head 也不行）
  let c = checkCompletion({ manifest, snapshot: { ...snapBase, comments: [{ id: 'z', body: signed }] }, receipt: null, hmacKey: HMAC_KEY });
  ok(!c.ok && c.missing.some((m) => m.includes('无 push receipt')), '无 receipt 必拒');
  // 攻击: 跨任务 receipt
  c = checkCompletion({ manifest, snapshot: snapDone, receipt: { dispatch_id: 'other', candidate }, hmacKey: HMAC_KEY });
  ok(!c.ok && c.missing.some((m) => m.includes('dispatch_id 不匹配')));
  const receipt = { dispatch_id: manifest.dispatch_id, original_head: SHA_A, candidate, remote: 'origin', branch: 'feat', phase: 'committed' };
  // 审⑤-F1: phase 缺失/非法的 receipt 不认（两段协议之外）
  c = checkCompletion({ manifest, snapshot: snapDone, receipt: { ...receipt, phase: undefined }, hmacKey: HMAC_KEY });
  ok(!c.ok && c.missing.some((m) => m.includes('phase 非法')), '无 phase receipt 必拒');
  // 审⑤-F1: intent receipt + 远端 head==candidate（核实）→ 认；head 不符 → 拒
  c = checkCompletion({ manifest, snapshot: snapDone, receipt: { ...receipt, phase: 'intent' }, hmacKey: HMAC_KEY });
  ok(c.ok, `经远端核实的 intent 应认: ${c.missing?.join(';')}`);
  c = checkCompletion({ manifest, snapshot: { ...snapBase, comments: [{ id: 'z', body: signed }] }, receipt: { ...receipt, phase: 'intent' }, hmacKey: HMAC_KEY });
  ok(!c.ok && c.missing.some((m) => m.includes('push 未落地')), '未核实的 intent（push 没发生）必拒');
  // push 未落地（远端 head ≠ receipt.candidate）
  c = checkCompletion({ manifest, snapshot: { ...snapBase, comments: [] }, receipt, hmacKey: HMAC_KEY });
  ok(!c.ok && c.missing.some((m) => m.includes('push 未落地')));
  // 回帖缺 / 无签名
  c = checkCompletion({ manifest, snapshot: { ...snapBase, head_sha: candidate, comments: [] }, receipt, hmacKey: HMAC_KEY });
  ok(!c.ok && c.missing.some((m) => m.includes('回帖未落地')));
  c = checkCompletion({ manifest, snapshot: { ...snapBase, head_sha: candidate, comments: [{ id: 'z', body: `dispatch:${manifest.dispatch_id}` }] }, receipt, hmacKey: HMAC_KEY });
  ok(!c.ok, '无 HMAC 签名的回帖不算');
  // 两项齐
  c = checkCompletion({ manifest, snapshot: snapDone, receipt, hmacKey: HMAC_KEY });
  ok(c.ok, c.missing?.join(';'));
  ok(ackDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 5, dispatchId: manifest.dispatch_id }).ok);
});
t('[审④F5] dispatch manifest 自包含: finalize/complete 命令与 state/snapshot 接线齐备且无 undefined', () => {
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, comments: [{ id: 'k5', body: '再来反馈' }] }));
  const r = runEngine(ENG({ budget: sharedBudget }));
  eq(r.dispatched.length, 1);
  const stFile = join(engState, stateFileName('o', 'mivo-canvas', 5));
  const m = readJson(stFile).pending_dispatch.manifest;
  for (const k of ['state_dir', 'snapshot_cmd', 'manifest_path', 'finalize_cmd', 'complete_cmd', 'original_head']) {
    ok(m[k], `manifest 缺 ${k}`);
  }
  ok(!JSON.stringify(m).includes('undefined'), 'manifest 不得含 undefined');
  ok(existsSync(m.manifest_path), 'manifest 必须已落盘供会话读取');
  ackDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 5, dispatchId: m.dispatch_id });
});
t('[审③I2-R] repoDirs 缺失 → cleanup-pending 不销单；配置后真实回收 worktree/分支再销单', () => {
  // 无 repoDirs → fail-closed
  registerPr({ stateDir: engState, owner: 'x', repo: 'norepo', prNumber: 9, branch: 'b', pushRemote: 'origin' });
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, state: 'merged' }));
  let r = runEngine(ENG({ budget: sharedBudget })); // x/norepo 不在 repoDirs
  const f9 = join(engState, stateFileName('x', 'norepo', 9));
  ok(existsSync(f9), '不得销单');
  eq(readJson(f9).status, 'cleanup-pending');
  unregisterPr({ stateDir: engState, owner: 'x', repo: 'norepo', prNumber: 9 });
  // 配置 repoDirs + 真 worktree → 回收
  execFileSync('rm', ['-rf', join(bizRepo, '..', 'fix-77')]);
  execFileSync('git', ['-C', bizRepo, 'worktree', 'add', '-q', '-b', 'fix-77', join(bizRepo, '..', 'fix-77')]);
  registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 77, branch: 'fix-77', pushRemote: 'origin' });
  r = runEngine(ENG({ budget: sharedBudget }));
  ok(r.terminal.length >= 1);
  ok(!existsSync(join(bizRepo, '..', 'fix-77')), 'worktree 应回收');
  ok(!execFileSync('git', ['-C', bizRepo, 'branch', '--list', 'fix-77'], { encoding: 'utf8' }).trim(), '分支应删');
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, state: 'closed' }));
  runEngine(ENG({ budget: sharedBudget })); // 清 #5
});
t('[F5/F3-R] finalize: CAS/closed/CI delta/upstream 冒充 → 拒；正当路径放行', () => {
  const fm = { owner: 'o', repo: 'r', pr_number: 9, branch: 'feat', original_head: HEAD, dispatch_id: 'd1', remote: 'origin' };
  ok(checkFinalize({ repoDir: repo, manifest: fm, snapshot: { state: 'open', head_sha: HEAD }, constitution }).ok);
  ok(!checkFinalize({ repoDir: repo, manifest: fm, snapshot: { state: 'open', head_sha: SHA_B }, constitution }).ok);
  ok(!checkFinalize({ repoDir: repo, manifest: fm, snapshot: { state: 'closed', head_sha: HEAD }, constitution }).ok);
  // push_repo 指定 fork 时 upstream remote 冒充被 URL 绑定拦
  const fmFork = { ...fm, remote: 'upstream', push_repo: 'o/r' };
  const r = checkFinalize({ repoDir: repo, manifest: fmFork, snapshot: { state: 'open', head_sha: HEAD }, constitution });
  ok(!r.ok && r.errors.some((e) => e.includes('push URL 不是')), r.errors.join(';'));
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/z.yml'), 'on: push\n');
  git('add', '.'); git('commit', '-qm', 'ciz');
  const r2 = checkFinalize({ repoDir: repo, manifest: fm, snapshot: { state: 'open', head_sha: HEAD }, constitution });
  ok(!r2.ok && r2.errors.some((e) => e.includes('CI 路径')));
  git('reset', '-q', '--hard', HEAD);
});
t('[I2] 注册回执: 立即 verify 缺③④；扫描后齐备；schedule 缺失 fail-closed', () => {
  const wDir = mkdtempSync(join(tmpdir(), 'rw-'));
  const wState = join(wDir, 'state'); mkdirSync(wState);
  const wLease = join(wDir, 'lease.json');
  const wSnap = join(wDir, 'snap.json');
  writeFileSync(wSnap, JSON.stringify(snapBase));
  writeFileSync(join(wDir, 'snap.sh'), `#!/bin/sh\ncat "${wSnap}"\n`);
  writeFileSync(join(wDir, 'nul.sh'), `#!/bin/sh\ncat > /dev/null\n`);
  execFileSync('chmod', ['+x', join(wDir, 'snap.sh'), join(wDir, 'nul.sh')]);
  registerPr({ stateDir: wState, owner: 'x', repo: 'y', prNumber: 1, branch: 'b', pushRemote: 'origin' });
  let rc = checkReceipt({ stateDir: wState, owner: 'x', repo: 'y', prNumber: 1, leaseFile: wLease, scheduleCheckCmd: ['echo', 'active'] });
  ok(!rc.ok && rc.missing.some((m) => m.includes('要素④')) && rc.missing.some((m) => m.includes('要素③')));
  runEngine({ stateDir: wState, leaseFile: wLease, snapshotCmd: join(wDir, 'snap.sh') + ' {owner} {repo} {pr}', dispatchCmd: join(wDir, 'nul.sh'), hmacKey: HMAC_KEY, budget: BUDGET(), repoDirs: {} });
  rc = checkReceipt({ stateDir: wState, owner: 'x', repo: 'y', prNumber: 1, leaseFile: wLease, scheduleCheckCmd: ['echo', 'active'] });
  ok(rc.ok, rc.missing?.join(';'));
  ok(!checkReceipt({ stateDir: wState, owner: 'x', repo: 'y', prNumber: 1, leaseFile: wLease, scheduleCheckCmd: null }).ok);
});
t('[I5-并发] 真多进程 20 并发注册不丢 key、无半文件', () => {
  const cDir = mkdtempSync(join(tmpdir(), 'cc-'));
  const script = `import('${join(S, 'pr-watch/register.mjs')}').then(m => m.registerPr({ stateDir: process.argv[1], owner: 'o', repo: 'r', prNumber: Number(process.argv[2]), branch: 'b', pushRemote: 'origin' })).then(() => process.exit(0)).catch(() => process.exit(1))`;
  const procs = [];
  for (let i = 0; i < 20; i++) {
    procs.push(new Promise((res, rej) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script, cDir, String(2000 + i)], { stdio: 'ignore' });
      p.on('exit', (c) => c === 0 ? res() : rej(new Error(`proc ${i} exit ${c}`)));
    }));
  }
  return Promise.all(procs).then(() => {
    const files = readdirSync(cDir).filter((f) => f.endsWith('.json'));
    eq(files.length, 20);
    for (const f of files) readJson(join(cDir, f));
  });
});
t('[审③F8-R] dispatch wrapper 四元组: 只回 session_id 拒 / 缺任一字段拒 / 漂移拒 / 全齐放行（CLI 实测）', () => {
  const wDir = mkdtempSync(join(tmpdir(), 'dw-'));
  const mkTransport = (payload) => {
    const f = join(wDir, `t-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(f, `#!/bin/sh\ncat > /dev/null\necho '${payload}'\n`);
    execFileSync('chmod', ['+x', f]);
    return f;
  };
  const manifest = JSON.stringify({
    dispatch_id: 'd1', owner: 'o', repo: 'r', pr_number: 1, worktree_name: 'fix-1',
    signals: ['review'], original_head: SHA_A, rules: [],
    state_dir: '/tmp/state', snapshot_cmd: 'snap {owner} {repo} {pr}', manifest_path: '/tmp/m.json',
    finalize_cmd: 'node finalize.mjs ...', complete_cmd: 'node complete.mjs ...', branch: 'fix-1', remote: 'origin'
  });
  // 期望值只能来自 env（wrapper 已去掉硬编码默认值——单一来源，见该文件头注释）
  const EXPECT_ENV = { EXPECT_AGENT_KIND: 'claude-code', EXPECT_PROVIDER: 'Cindy AI', EXPECT_MODEL: 'claude-sonnet-5', EXPECT_EFFORT: 'xhigh' };
  // unset: 要**真正删掉**的 env key 列表——不能用空串代替。初版代码是 `process.env.X ?? '默认值'`，
  // `??` 只拦 null/undefined，空串会原样成为 EXPECT='' 照样判漂移拒绝；用空串写的"缺 env 应拒"
  // 断言在装回硬编码默认值后**依然通过** = 假覆盖（本轮自查发现，改为真 unset 才有牙齿）。
  const runW = (transport, { over = {}, unset = [] } = {}) => {
    const env = { ...process.env, CINDY_DISPATCH_CMD: transport, ...EXPECT_ENV, ...over };
    for (const k of unset) delete env[k];
    try {
      execFileSync(process.execPath, [join(W, 'cindy-dispatch.mjs')], { encoding: 'utf8', input: manifest, env });
      return true;
    } catch { return false; }
  };
  const full = { session_id: 's1', agentKind: 'claude-code', provider: 'Cindy AI', model: 'claude-sonnet-5', effort: 'xhigh' };
  ok(runW(mkTransport(JSON.stringify(full))), '四元组全齐应过');
  ok(!runW(mkTransport(JSON.stringify({ session_id: 's1' }))), '只回 session_id 应拒');
  for (const missing of ['agentKind', 'provider', 'model', 'effort']) {
    const { [missing]: _, ...part } = full;
    ok(!runW(mkTransport(JSON.stringify(part))), `缺 ${missing} 应拒`);
  }
  ok(!runW(mkTransport(JSON.stringify({ ...full, model: 'z-ai/glm-5.2' }))), 'model 漂移应拒');
  ok(!runW(''), '无传输层配置应拒');
  // 单一来源 fail-closed: 四个 EXPECT_* 真 unset 任一 → 拒（不得回落到硬编码默认值静默用旧期望）。
  //
  // 这条断言的构造试错了两轮，写清楚免得后人又写成假的：
  //   ✗ 第一版用空串占位——`?? '默认值'` 只拦 null/undefined，空串会原样成为 EXPECT='' 照样判漂移，
  //     装回默认值后断言依然通过 = 假覆盖。
  //   ✗ 第二版真 unset 了，但回执把 model 与 effort **两个**都填旧值，而每次只 unset 一个变量 →
  //     另一个字段必然与 env 的新值不符 → 仍被拒 → 装回默认值后断言依然通过 = 还是假覆盖。
  //   ✓ 本版：只让**被 unset 的那一个字段**用旧默认值，其余三个字段用新值。这样装回默认值后，
  //     期望会静默回落成旧值、恰好与回执相符、其余字段也相符 → 整体放行 → 断言变红。
  const LEGACY_DEFAULT = { EXPECT_AGENT_KIND: 'claude-code', EXPECT_PROVIDER: 'Cindy AI', EXPECT_MODEL: 'z-ai/glm-5.2', EXPECT_EFFORT: 'max' };
  const RECEIPT_FIELD = { EXPECT_AGENT_KIND: 'agentKind', EXPECT_PROVIDER: 'provider', EXPECT_MODEL: 'model', EXPECT_EFFORT: 'effort' };
  for (const envVar of Object.keys(EXPECT_ENV)) {
    const receipt = JSON.stringify({ ...full, [RECEIPT_FIELD[envVar]]: LEGACY_DEFAULT[envVar] });
    ok(!runW(mkTransport(receipt), { unset: [envVar] }),
      `${envVar} 真 unset 时必须拒（期望值只能来自 env.sh；回落旧默认值会让"旧回执 + 旧期望"这一对静默通过）`);
  }
  // 正向对照: 换一套期望值 + 相符的回执照样过（证明不是钉死某个具体模型，而是钉死"env 与回执一致"）
  ok(runW(mkTransport(JSON.stringify({ ...full, model: 'z-ai/glm-5.2', effort: 'max' })),
    { over: { EXPECT_MODEL: 'z-ai/glm-5.2', EXPECT_EFFORT: 'max' } }),
  '换一套期望值且回执相符应过');
});

// ========== 7. inbox-digest ==========
console.log('\n[7] §3 + 审③F9-R: 卡片全链闭环');
const notifications = [
  { id: '1', reason: 'mention', subject: { type: 'Issue', title: 'T1', url: 'u1' }, repository: 'a/x' },
  { id: '2', reason: 'review_requested', subject: { type: 'PullRequest', title: 'T2', url: 'u2' }, repository: 'a/y' },
  { id: '3', reason: 'ci_activity', subject: { type: 'CheckSuite', title: 'noise', url: 'u3' }, repository: 'a/x' },
  { id: '4', reason: 'state_change', closed_by_other: true, subject: { type: 'PullRequest', title: 'T4', url: 'u4' }, repository: 'a/z' },
  { id: '5', reason: 'comment', subject: { type: 'PullRequest', title: 'T5', url: 'u5' }, repository: 'a/x', blocking_others: true }
];
t('[§3.1] 分桶排序 + D 桶零出现', () => {
  const wd2 = mkdtempSync(join(tmpdir(), 'dg-'));
  const mr = join(wd2, 'mr.jsonl');
  const r = collect({ notifications, markedReadFile: mr });
  eq(r.items.map((i) => i.source_id), ['5', '2', '1', '4']);
  eq(r.noise_marked_read, 1);
  ok(!JSON.stringify(r.items).includes('noise'));
});
t('[I2/I1] 渲染守恒 + lint 扩面 + fallback 二级降级', () => {
  const input = collect({ notifications }).items;
  const good = input.map((i) => ({ source_id: i.source_id, sentence: '这条通知等你处理，看一眼就知道下一步。' }));
  ok(validateRender(input, good).ok);
  ok(!validateRender(input, good.slice(1)).ok);
  ok(!validateRender(input, [...good, { source_id: '999', sentence: '幻觉条目应当被拦下来。' }]).ok);
  const backtick = String.fromCharCode(96);
  for (const bad of [`看 ${backtick}c${backtick}`, '改了 scripts/x.mjs 文件', '调用 doThing() 失败', 'source_id 字段缺失', '先跑 npm run build 再说', '看下 src/app 目录', '类型在 index.ts 里', 'DataLoader 有竞态']) {
    ok(lintSentence(bad).length > 0, `应命中: ${bad}`);
  }
  eq(lintSentence('GitHub 上有人在等你拍板，是关于登录页的两个方案'), []);
  const items = [
    { source_id: '1', kind: 'mentioned', repo: 'a/x', title: '修复 useCanvasDrag() 泄漏', url: 'u', state: 's' },
    { source_id: '2', kind: 'awaiting_decision', repo: 'a/y', title: '登录页改版讨论', url: 'u', state: 's' }
  ];
  const fb = fallbackRender(items);
  ok(validateRender(items, fb).ok);
  ok(fb[0].sentence.includes('已省略') && fb[1].sentence.includes('登录页改版讨论'));
});
function mkDigestEnv() {
  const d = mkdtempSync(join(tmpdir(), 'run-'));
  const sh = (name, body) => { const f = join(d, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); execFileSync('chmod', ['+x', f]); return f; };
  return { d, sh };
}
t('[审③F9-R] 预检先行改桶换序 + 剔除 + 异常标注 + 补注册 + fallback + 结构化 payload 带 URL', () => {
  const { d, sh } = mkDigestEnv();
  const stDir = join(d, 'state'); mkdirSync(stDir);
  writeFileSync(join(d, 'notif.json'), JSON.stringify(notifications));
  const fetch = sh('fetch.sh', `cat "${join(d, 'notif.json')}"`);
  // 预检: id=1（原 mention 第三位）标 blocking_others → 应升到榜首；id=4 exists:false 剔除；id=2 缺失 → anomaly
  const preflight = sh('preflight.sh', `cat > /dev/null\necho '{"1":{"exists":true,"blocking_others":true},"5":{"exists":true},"4":{"exists":false}}'`);
  const markread = sh('markread.sh', `cat >> "${join(d, 'markread.log')}"`);
  const ownprs = sh('ownprs.sh', `echo '[{"owner":"o","repo":"r","number":88,"branch":"f88","push_remote":"origin"}]'`);
  const renderBad = sh('render-bad.sh', `cat > /dev/null\nprintf '[{"source_id":"5","sentence":"\\140c\\140"},{"source_id":"2","sentence":"x"},{"source_id":"1","sentence":"y"}]'`);
  const send = sh('send.sh', `cat > "${join(d, 'sent.json')}"`);
  const report = runDigest({
    fetchCmd: fetch, preflightCmd: preflight, markReadCmd: markread, ownPrsCmd: ownprs,
    renderCmd: renderBad, sendCmd: send,
    stateDir: stDir, markedReadFile: join(d, 'mr.jsonl'), journalFile: join(d, 'j.jsonl'),
    strict: false
  });
  eq(report.render_source, 'fallback');
  eq(report.reconciled, ['o/r#88']);
  const payload = readJson(join(d, 'sent.json'));
  ok(Array.isArray(payload.lines) && payload.lines[0].url, 'payload 必须结构化且带 URL');
  eq(payload.lines[0].source_id, '1', '预检 blocking_others 必须把 id=1 顶到榜首（改桶换序生效）');
  ok(!payload.text.includes('T4'), 'exists:false 剔除');
  ok(payload.lines.some((l) => l.source_id === '2' && l.anomaly), '预检缺失的 id=2 应标 anomaly');
  ok(!payload.text.includes(String.fromCharCode(96)), '零反引号');
  ok(existsSync(join(d, 'markread.log')));
});
t('[审③F9-R] 渲染重排无效: DeepSeek 反序输出，卡片仍按脚本优先级顺序', () => {
  const { d, sh } = mkDigestEnv();
  writeFileSync(join(d, 'notif.json'), JSON.stringify(notifications));
  const fetch = sh('fetch.sh', `cat "${join(d, 'notif.json')}"`);
  // 反序但句子合法
  const renderRev = sh('render-rev.sh', `cat > /dev/null\necho '[{"source_id":"4","sentence":"这条被别人关掉了，看一眼是否要跟进。"},{"source_id":"1","sentence":"有人在讨论里找你，等你回应。"},{"source_id":"2","sentence":"有个拉取请求等你拍板，选一个方案就能继续。"},{"source_id":"5","sentence":"这条正在阻塞别人，优先处理。"}]'`);
  const send = sh('send.sh', `cat > "${join(d, 'sent.json')}"`);
  const report = runDigest({ fetchCmd: fetch, renderCmd: renderRev, sendCmd: send, journalFile: join(d, 'j.jsonl'), strict: false });
  ok(report.render_source.startsWith('deepseek'));
  const payload = readJson(join(d, 'sent.json'));
  eq(payload.lines.map((l) => l.source_id), ['5', '2', '1', '4'], '输出顺序必须按脚本排序重组');
});
t('[审③F9-R] overflow 游标闭环: 首日截断落盘，次日置顶补发并清游标；空清单心跳', () => {
  const { d, sh } = mkDigestEnv();
  const cursor = join(d, 'cursor.json');
  const many = Array.from({ length: 200 }, (_, i) => ({ id: String(i), reason: 'mention', subject: { type: 'Issue', title: `话题编号很长很长的第${i}件事等待处理`, url: `u${i}` }, repository: 'a/x' }));
  writeFileSync(join(d, 'many.json'), JSON.stringify(many));
  const fetchMany = sh('many.sh', `cat "${join(d, 'many.json')}"`);
  const send = sh('send.sh', `cat > "${join(d, 'sent.json')}"`);
  const r1 = runDigest({ fetchCmd: fetchMany, sendCmd: send, cursorFile: cursor, strict: false });
  ok(r1.overflow);
  const spilled = readJson(cursor).overflow_items;
  ok(spilled.length > 0, '游标应存整条 item');
  // 次日: fetch 为空（since 窗口滑走），游标条目必须置顶补发
  const fetchEmpty = sh('empty.sh', `echo '[]'`);
  const r2 = runDigest({ fetchCmd: fetchEmpty, sendCmd: send, cursorFile: cursor, strict: false });
  eq(r2.carried_over, spilled.length, '跨日补发数量必须等于游标存量');
  ok(!r2.heartbeat, '有补发不算空');
  eq(readJson(cursor).overflow_items.length, 0, '游标消费后清空');
  // 真空清单 → 心跳
  const r3 = runDigest({ fetchCmd: fetchEmpty, sendCmd: send, cursorFile: cursor, strict: false });
  ok(r3.heartbeat);
  ok(readJson(join(d, 'sent.json')).text.includes('今天没活'));
});

t('[审④F8] strict 默认: 配置缺任一 → 拒启动；send 失败 → 游标原样不丢', () => {
  const { d, sh } = mkDigestEnv();
  let threw = false;
  try { runDigest({ fetchCmd: 'x', sendCmd: 'y' }); } catch (e) { threw = /配置缺失/.test(e.message); }
  ok(threw, 'strict 缺配置必须拒启动');
  // send 失败游标保护
  const cursor = join(d, 'cursor.json');
  writeFileSync(cursor, JSON.stringify({ overflow_items: [{ source_id: 'C1', kind: 'mentioned', repo: 'a/x', title: '上轮遗留', url: 'u', state: 's' }] }));
  const fetchEmpty = sh('fe.sh', `echo '[]'`);
  const sendFail = sh('sf.sh', 'exit 1');
  threw = false;
  try { runDigest({ fetchCmd: fetchEmpty, sendCmd: sendFail, cursorFile: cursor, strict: false }); } catch { threw = true; }
  ok(threw, 'send 失败应抛错');
  eq(readJson(cursor).overflow_items.length, 1, 'send 失败后游标必须原样（未丢失）');
  // 重跑成功 → 补发 + 游标清空
  const sent = join(d, 'sent.json');
  const sendOk = sh('so.sh', `cat > "${sent}"`);
  const r = runDigest({ fetchCmd: fetchEmpty, sendCmd: sendOk, cursorFile: cursor, strict: false });
  eq(r.carried_over, 1);
  eq(readJson(cursor).overflow_items.length, 0);
});
t('[审④F9+审⑤F4] register CLI: --push-repo/--push-remote 直通 state；缺 branch/push-remote 拒（CLI 实测）', () => {
  const d2 = mkdtempSync(join(tmpdir(), 'rp-'));
  execFileSync(process.execPath, [join(S, 'pr-watch/register.mjs'), '--state-dir', d2, '--owner', 'makecindy', '--repo', 'cindy', '--pr', '908', '--branch', 'fix/x', '--push-remote', 'fork', '--push-repo', 'PraiseZhu/cindy-fork'], { encoding: 'utf8' });
  const st = readJson(join(d2, stateFileName('makecindy', 'cindy', 908)));
  eq(st.push_repo, 'PraiseZhu/cindy-fork');
  eq(st.push_remote, 'fork', 'push_remote 必须持久化（引擎不猜 remote 名）');
  eq(st.branch, 'fix/x');
  // 审⑤-F4: 缺 --push-remote / 缺 --branch → CLI 直接拒
  for (const argsBad of [
    ['--state-dir', d2, '--owner', 'o', '--repo', 'r', '--pr', '1', '--branch', 'b'],
    ['--state-dir', d2, '--owner', 'o', '--repo', 'r', '--pr', '1', '--push-remote', 'origin']
  ]) {
    let failed = false;
    try { execFileSync(process.execPath, [join(S, 'pr-watch/register.mjs'), ...argsBad], { encoding: 'utf8', stdio: 'pipe' }); }
    catch { failed = true; }
    ok(failed, `register 缺必填参数应拒: ${argsBad.join(' ')}`);
  }
});

// ========== 8. evolution ==========
console.log('\n[8] §1.3 + 审③F10-R/F12-R: 台账·聚类·漏检·E6');
const wd = mkdtempSync(join(tmpdir(), 'ev-'));
const ledger = join(wd, 'ledger.jsonl');
t('[审⑥①/§1.3] 幂等 + 阈值 + pending/confirm + R8 拒后重提', () => {
  const entry = { channel: 'E2', pattern_key: 'rm:src/render', instance_key: 'PR#12', summary: 'x' };
  ok(appendLedger({ ledgerFile: ledger, entry }).appended);
  ok(!appendLedger({ ledgerFile: ledger, entry }).appended);
  appendLedger({ ledgerFile: ledger, entry: { ...entry, instance_key: 'PR#34' } });
  eq(clusterLedger({ lines: readFileSync(ledger, 'utf8').split('\n').filter(Boolean) }).length, 1);
  const l2 = join(wd, 'l-e1.jsonl');
  const r1 = appendLedger({ ledgerFile: l2, entry: { channel: 'E1', pattern_key: 'p', instance_key: 'PR#1', why_class: 'pending', summary: 'x' } });
  const r2 = appendLedger({ ledgerFile: l2, entry: { channel: 'E1', pattern_key: 'p', instance_key: 'PR#2', why_class: 'pending', summary: 'y' } });
  eq(clusterLedger({ lines: readFileSync(l2, 'utf8').split('\n').filter(Boolean) }).length, 0);
  // 审⑤-F6: 合法 confirm = owner HMAC 签名（confirmed_by=owner + sig 绑定 id_ref/channel/pattern）
  const CONFIRM_KEY = 'test-confirm-key-' + Math.random().toString(36).slice(2);
  const mkConfirm = (idRef, over = {}) => {
    const c = { kind: 'confirm', channel: 'E1', pattern_key: 'p', instance_key: `cf-${idRef}`, id_ref: idRef, confirmed_by: 'owner', ...over };
    c.sig = signConfirm(c, CONFIRM_KEY);
    return c;
  };
  appendLedger({ ledgerFile: l2, entry: mkConfirm(r1.id) });
  appendLedger({ ledgerFile: l2, entry: mkConfirm(r2.id) });
  const l2lines = () => readFileSync(l2, 'utf8').split('\n').filter(Boolean);
  eq(clusterLedger({ lines: l2lines(), confirmKey: CONFIRM_KEY }).length, 1, '正签 confirm 转正达阈');
  // key 缺失时 owner confirm 不生效（fail-closed）；错 key 同样不生效
  eq(clusterLedger({ lines: l2lines() }).length, 0, '无 confirmKey 时 confirm 不生效');
  eq(clusterLedger({ lines: l2lines(), confirmKey: 'wrong-key' }).length, 0, '错 key 验签失败不转正');
  const l3 = join(wd, 'l-r8.jsonl');
  appendLedger({ ledgerFile: l3, entry: { channel: 'E4', pattern_key: 'mw', instance_key: 'PR#1', summary: 'x' } });
  appendLedger({ ledgerFile: l3, entry: { channel: 'E4', pattern_key: 'mw', instance_key: 'PR#2', summary: 'y' } });
  appendLedger({ ledgerFile: l3, entry: { kind: 'rejected', channel: 'E4', pattern_key: 'mw', instance_key: 'rej', reason: 'no' } });
  eq(clusterLedger({ lines: readFileSync(l3, 'utf8').split('\n').filter(Boolean) }).length, 0);
  appendLedger({ ledgerFile: l3, entry: { channel: 'E4', pattern_key: 'mw', instance_key: 'PR#3', summary: 'z' } });
  eq(clusterLedger({ lines: readFileSync(l3, 'utf8').split('\n').filter(Boolean) }).length, 1);
});
t('[审③F12-R] E6: 非 hex content_hash 拒 / raw_material 重算忽略自报 / 未知字段拒 / 原文不落盘', () => {
  const l4 = join(wd, 'l-e6.jsonl');
  let threw = false;
  try { appendLedger({ ledgerFile: l4, entry: { channel: 'E6', pattern_key: 'p', instance_key: 'i', guard_id: 'g', content_hash: 'plaintext-not-a-hash-' + mkFakeSk() } }); }
  catch { threw = true; }
  ok(threw, '非 64hex content_hash 必须拒');
  threw = false;
  try { appendLedger({ ledgerFile: l4, entry: { channel: 'E6', pattern_key: 'p', instance_key: 'i', guard_id: 'g', raw_payload: mkCredAssign() } }); }
  catch { threw = true; }
  ok(threw, '未知字段拒');
  const fakeTok = mkFakeGhToken();
  const res = appendLedger({
    ledgerFile: l4,
    entry: {
      channel: 'E6', pattern_key: 'force-rej', instance_key: 's1', guard_id: 'W4',
      content_hash: 'f'.repeat(64), // 自报 hash 应被 raw_material 重算覆盖
      raw_material: `git push --force ${mkFakeAuthHeader()} ${fakeTok}`,
      redacted_summary: '拦下 force push，含 ' + fakeTok
    }
  });
  ok(res.appended);
  const line = readFileSync(l4, 'utf8');
  ok(!line.includes(fakeTok) && !line.includes('git push --force') && !line.includes('f'.repeat(64)), '原文/自报 hash 均不得落盘');
  eq(secretLint(line).length, 0);
});
t('[F12] secret-lint 扩面全组', () => {
  for (const s of [mkFakeSk(), mkCredAssign(), mkQuerySecret(), mkFakeGhToken(), mkFakePrivKey(), mkFakeEnv()]) {
    ok(secretLint(s).length > 0, `应命中: ${s.slice(0, 12)}…`);
  }
  eq(secretLint('普通台账内容：诊断标识 A7，差异摘要已脱敏'), []);
});
t('[审③F10-R] escape: ledger candidate≠head 全跳过；node_id 幂等（同 node 内容变化只记一次）；五纪律', () => {
  const triDir = join(wd, 'tri'); mkdirSync(triDir, { recursive: true });
  const esc = join(wd, 'escape.jsonl');
  writeFileSync(join(triDir, 'o__r__1.json'), JSON.stringify({
    candidate_sha: SHA_A,
    findings: [{ anchor: 'src/known.ts:10', evidence: '已知问题描述' }],
    gate_checks: [{ gate_id: 'format-gate' }]
  }));
  const snap = {
    head_sha: SHA_A,
    remote_findings: [
      { node_id: 'n1', head_sha: SHA_A, path: 'src/miss.ts:5', summary: '漏掉的竞态', resolved: true, state: 'resolved', kind: 'finding' },
      { node_id: 'n2', head_sha: SHA_A, path: 'src/miss.ts:8', summary: '漏掉的竞态', resolved: true, state: 'resolved', kind: 'finding' },
      { node_id: 'n3', head_sha: SHA_B, path: 'src/other.ts', summary: 'x', resolved: true, state: 'resolved', kind: 'finding' },
      { node_id: 'n4', head_sha: SHA_A, path: 'src/maybe.ts', summary: 'y', resolved: false, state: 'open', kind: 'finding' },
      { node_id: 'n5', head_sha: SHA_A, path: 'src/known.ts:12', summary: '已知问题描述', resolved: true, state: 'resolved', kind: 'finding' },
      { node_id: 'n6', head_sha: SHA_A, path: 'x', summary: 'format', resolved: true, state: 'resolved', kind: 'finding', gate_id: 'format-gate' },
      { node_id: 'n7', head_sha: SHA_A, path: 'src/app/ui.tsx', registry_path: 'src/app', summary: 'UI 证据缺失', accepted: true, state: 'resolved', kind: 'evidence-gate-rejection' }
    ]
  };
  const r = classifyEscapes({ snapshot: snap, owner: 'o', repo: 'r', prNumber: 1, triReviewLedgerDir: triDir, escapeLedger: esc });
  eq(r.e1, 1, JSON.stringify(r));
  eq(r.e2, 1);
  // ledger candidate ≠ 当前 head → 全跳过（跨 head 不计漏检）
  const r2 = classifyEscapes({ snapshot: { ...snap, head_sha: SHA_B, remote_findings: snap.remote_findings.map((f) => ({ ...f, head_sha: SHA_B })) }, owner: 'o', repo: 'r', prNumber: 1, triReviewLedgerDir: triDir, escapeLedger: esc });
  eq(r2.e1 ?? 0, 0, JSON.stringify(r2));
  // node_id 幂等: 同 node 内容变化不刷新账
  const dup1 = appendLedger({ ledgerFile: esc, entry: { channel: 'E1', why_class: 'pending', pattern_key: 'k-a', instance_key: 'PR#7', remote_node_id: 'NODE-X', summary: '第一版内容' } });
  const dup2 = appendLedger({ ledgerFile: esc, entry: { channel: 'E1', why_class: 'pending', pattern_key: 'k-b-完全不同', instance_key: 'PR#7', remote_node_id: 'NODE-X', summary: '编辑后的内容' } });
  ok(dup1.appended && !dup2.appended, '同 remote_node_id 必须幂等');
  // 旁路 PR 不算漏检
  eq(classifyEscapes({ snapshot: snap, owner: 'o', repo: 'r', prNumber: 99, triReviewLedgerDir: triDir, escapeLedger: esc }).e1, 0);
});
t('[e2e-evolution 洞①] 伪 confirm 被拦: 假 id_ref 不转正 / 缺 id_ref append 直接拒', () => {
  const lf = join(wd, 'l-fakeconfirm.jsonl');
  appendLedger({ ledgerFile: lf, entry: { channel: 'E1', pattern_key: 'fc', instance_key: 'PR#1', why_class: 'pending', summary: 'x' } });
  appendLedger({ ledgerFile: lf, entry: { channel: 'E1', pattern_key: 'fc', instance_key: 'PR#2', why_class: 'pending', summary: 'y' } });
  let threw = false;
  try { appendLedger({ ledgerFile: lf, entry: { kind: 'confirm', channel: 'E1', pattern_key: 'fc', instance_key: 'PR#1' } }); }
  catch { threw = true; }
  ok(threw, '缺 id_ref 的 confirm 必须拒');
  // 审⑤-F6: 有 id_ref 但无鉴权材料 → append 结构闸直接拒（知道真实 id 也不行）
  const realIds = readFileSync(lf, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
  threw = false;
  try { appendLedger({ ledgerFile: lf, entry: { kind: 'confirm', channel: 'E1', pattern_key: 'fc', instance_key: 'PR#1', id_ref: realIds[0] } }); }
  catch (e) { threw = /鉴权材料/.test(e.message); }
  ok(threw, '真实 id_ref 但无签名/规则的 confirm 必须在 append 被拒');
  // 正签但假 id_ref → append 过结构闸，cluster 因 id 不存在拒绝转正
  const K2 = 'k2-' + Math.random().toString(36).slice(2);
  const fake1 = { kind: 'confirm', channel: 'E1', pattern_key: 'fc', instance_key: 'PR#1', id_ref: 'deadbeefdeadbeef', confirmed_by: 'owner' };
  fake1.sig = signConfirm(fake1, K2);
  appendLedger({ ledgerFile: lf, entry: fake1 });
  eq(clusterLedger({ lines: readFileSync(lf, 'utf8').split('\n').filter(Boolean), confirmKey: K2 }).length, 0, '假 id_ref 的 confirm 不得转正');
  // 跨簇挪用: 给 event A 的正签 confirm 改 pattern 引到别簇 → channel/pattern 一致性拒
  const cross = { kind: 'confirm', channel: 'E1', pattern_key: 'other-cluster', instance_key: 'PR#1', id_ref: realIds[0], confirmed_by: 'owner' };
  cross.sig = signConfirm(cross, K2);
  appendLedger({ ledgerFile: lf, entry: cross });
  eq(clusterLedger({ lines: readFileSync(lf, 'utf8').split('\n').filter(Boolean), confirmKey: K2 }).length, 0, '跨簇引用的 confirm 不得转正');
  // 审⑥-F3: 规则路径 authority 在签名——rule_id/evidence_hash 全字段入签
  const ruleC1 = { kind: 'confirm', channel: 'E1', pattern_key: 'fc', instance_key: 'rule-cf-1', id_ref: realIds[0], rule_id: 'remote-finding-verified', evidence_hash: 'a'.repeat(64) };
  const ruleC2 = { kind: 'confirm', channel: 'E1', pattern_key: 'fc', instance_key: 'rule-cf-2', id_ref: realIds[1], rule_id: 'remote-finding-verified', evidence_hash: 'b'.repeat(64) };
  // 无 sig 的规则 confirm → append 结构闸直接拒（知道 allowlisted 规则名也不行）
  let threwNoSig = false;
  try { appendLedger({ ledgerFile: lf, entry: ruleC1 }); } catch (e) { threwNoSig = /鉴权材料/.test(e.message); }
  ok(threwNoSig, '无 sig 的规则 confirm 必须在 append 被拒');
  ruleC1.sig = signConfirm(ruleC1, K2);
  ruleC2.sig = signConfirm(ruleC2, K2);
  appendLedger({ ledgerFile: lf, entry: ruleC1 });
  appendLedger({ ledgerFile: lf, entry: ruleC2 });
  const lfLines = () => readFileSync(lf, 'utf8').split('\n').filter(Boolean);
  eq(clusterLedger({ lines: lfLines(), confirmKey: K2, confirmRules: ['remote-finding-verified'] }).length, 1, 'allowlist 规则 + 正签 confirm 转正');
  eq(clusterLedger({ lines: lfLines(), confirmKey: K2, confirmRules: [] }).length, 0, '不在 allowlist 的规则不转正');
  eq(clusterLedger({ lines: lfLines(), confirmRules: ['remote-finding-verified'] }).length, 0, '无 key: 规则 confirm 同样不生效（fail-closed）');
  eq(clusterLedger({ lines: lfLines(), confirmKey: 'wrong', confirmRules: ['remote-finding-verified'] }).length, 0, '错 key 规则 confirm 不转正');
  // 审⑥-F3 攻击: 篡改 evidence_hash 沿用旧 sig → 全字段入签必拒（独立小账本，阈值 2 差一条即 0）
  const lfT = join(wd, 'l-rule-tamper.jsonl');
  const e1 = appendLedger({ ledgerFile: lfT, entry: { channel: 'E1', pattern_key: 'rt', instance_key: 'PR#1', why_class: 'pending', summary: 'x' } });
  const e2 = appendLedger({ ledgerFile: lfT, entry: { channel: 'E1', pattern_key: 'rt', instance_key: 'PR#2', why_class: 'pending', summary: 'y' } });
  const good = { kind: 'confirm', channel: 'E1', pattern_key: 'rt', instance_key: 'cf-1', id_ref: e1.id, rule_id: 'remote-finding-verified', evidence_hash: 'd'.repeat(64) };
  good.sig = signConfirm(good, K2);
  const bad = { kind: 'confirm', channel: 'E1', pattern_key: 'rt', instance_key: 'cf-2', id_ref: e2.id, rule_id: 'remote-finding-verified', evidence_hash: 'd'.repeat(64) };
  bad.sig = signConfirm(bad, K2);
  bad.evidence_hash = 'e'.repeat(64); // 签完再改证据
  appendLedger({ ledgerFile: lfT, entry: good });
  appendLedger({ ledgerFile: lfT, entry: bad });
  eq(clusterLedger({ lines: readFileSync(lfT, 'utf8').split('\n').filter(Boolean), confirmKey: K2, confirmRules: ['remote-finding-verified'] }).length, 0,
    '签后改 evidence_hash 的 confirm 必须无效（只剩 1 条合法 confirm，达不到阈值）');
});
t('[e2e-evolution 洞②] hash 链: 删 rejected 行重写 → cluster fail-closed 抛错', () => {
  const lf = join(wd, 'l-tamper.jsonl');
  appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'tw', instance_key: 'PR#1', summary: 'x' } });
  appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'tw', instance_key: 'PR#2', summary: 'y' } });
  appendLedger({ ledgerFile: lf, entry: { kind: 'rejected', channel: 'E4', pattern_key: 'tw', instance_key: 'rej', reason: 'no' } });
  const lines = readFileSync(lf, 'utf8').split('\n').filter(Boolean);
  const headHash = readFileSync(`${lf}.head`, 'utf8').trim();
  eq(clusterLedger({ lines, expectedHeadHash: headHash }).length, 0, '完整链: 拒后不重提');
  // 攻击①: 删中间行 → prev 链断裂
  const midGone = [lines[0], lines[2]];
  let threw = false;
  try { clusterLedger({ lines: midGone, expectedHeadHash: headHash }); } catch (e) { threw = /链断裂/.test(e.message); }
  ok(threw, '删中间行必须断链抛错');
  // 攻击②: 截尾删掉末尾 rejected 行（前缀链自洽）→ head 侧车比对拦
  const tailGone = lines.slice(0, 2);
  threw = false;
  try { clusterLedger({ lines: tailGone, expectedHeadHash: headHash }); } catch (e) { threw = /截尾/.test(e.message); }
  ok(threw, '截尾删除必须被 head 侧车拦下');
});
t('[e2e-evolution 缺口③] isMain: symlink 别名路径下 CLI 不再静默 no-op', () => {
  const real = mkdtempSync(join(tmpdir(), 'sym-'));
  const alias = real + '-alias';
  execFileSync('ln', ['-s', real, alias]);
  const lf = join(real, 'l.jsonl');
  appendLedger({ ledgerFile: lf, entry: { channel: 'E2', pattern_key: 'p', instance_key: 'PR#1', summary: 'x' } });
  // 经 symlink 别名目录调用真实 CLI 文件（复制进 alias 下不行——直接用仓内脚本经别名前缀）
  const scriptsAlias = join(real, 'scripts-link');
  execFileSync('ln', ['-s', S, scriptsAlias]);
  const out = execFileSync(process.execPath, [join(scriptsAlias, 'evolution/cluster.mjs'), '--ledger', lf], { encoding: 'utf8' });
  ok(out.trim().length > 0, 'symlink 路径下 CLI 必须有输出（此前静默 no-op）');
});
t('[审④I3] entry 自带 id/at/prev 无法覆盖可信字段', () => {
  const lf = join(wd, 'l-override.jsonl');
  const r = appendLedger({ ledgerFile: lf, entry: { channel: 'E2', pattern_key: 'ov', instance_key: 'PR#1', summary: 'x', id: 'HACKED', at: '1999-01-01T00:00:00Z', prev: 'FORGED' } });
  ok(r.id !== 'HACKED', 'id 不得被 entry 覆盖');
  const rec = JSON.parse(readFileSync(lf, 'utf8').trim());
  ok(rec.id !== 'HACKED' && rec.at !== '1999-01-01T00:00:00Z' && rec.prev !== 'FORGED', '可信字段必须由追加器生成');
});
t('[R7-glob] matchAny 边界', () => {
  const c = readJson(join(S, 'evolution/constitution-paths.json'));
  ok(matchAny('schemas/x.json', c.blacklist));
  ok(!matchAny('schemas-extra/x.json', c.blacklist));
});

// ========== 9. health + gh-snapshot 契约 ==========
console.log('\n[9] W-7/I3 + 审③I7: 健康降级链 + gh-snapshot ETag/GraphQL 契约（录制假 gh）');
t('[W-7] lease 判定四态', () => {
  const hd = mkdtempSync(join(tmpdir(), 'hl-'));
  writeFileSync(join(hd, 'fresh.json'), JSON.stringify({ last_success: new Date().toISOString() }));
  writeFileSync(join(hd, 'stale.json'), JSON.stringify({ last_success: new Date(Date.now() - 120 * 60000).toISOString() }));
  writeFileSync(join(hd, 'broken.json'), '{oops');
  const dead = checkLeases({
    leases: [
      { name: 'fresh', file: join(hd, 'fresh.json') }, { name: 'stale', file: join(hd, 'stale.json') },
      { name: 'broken', file: join(hd, 'broken.json') }, { name: 'absent', file: join(hd, 'nope.json') }
    ], ttlMinutes: 45
  });
  eq(dead.map((d) => d.name).sort(), ['absent', 'broken', 'stale']);
});
t('[I3] 降级链: 飞书 ok→feishu / exit4→slack 带标记 / 双失败→none', () => {
  const hd = mkdtempSync(join(tmpdir(), 'ha-'));
  const sh = (n, b) => { const f = join(hd, n); writeFileSync(f, `#!/bin/sh\n${b}\n`); execFileSync('chmod', ['+x', f]); return f; };
  const okSh = sh('ok.sh', 'cat > /dev/null');
  const e4Sh = sh('e4.sh', 'cat > /dev/null\nexit 4');
  const failSh = sh('fail.sh', 'exit 1');
  const slackLog = join(hd, 'slack.log');
  const slackSh = sh('slack.sh', `cat > "${slackLog}"`);
  eq(alertWithFallback({ message: 'm', feishuCmd: [okSh], slackCmd: [slackSh] }).channel, 'feishu');
  eq(alertWithFallback({ message: '引擎死了', feishuCmd: [e4Sh], slackCmd: [slackSh] }).channel, 'slack-degraded');
  ok(readFileSync(slackLog, 'utf8').includes('降级通道') && readFileSync(slackLog, 'utf8').includes('凭证不可得'));
  eq(alertWithFallback({ message: 'm', feishuCmd: [failSh], slackCmd: [failSh] }).ok, false);
});
t('[审③I7/F10-R] gh-snapshot 契约: 首跑 200+ETag 落缓存；二跑发 If-None-Match 得 304 输出一致；GraphQL 产出非空 remote_findings', () => {
  const gd = mkdtempSync(join(tmpdir(), 'gh-'));
  const cacheDir = join(gd, 'cache');
  const callLog = join(gd, 'calls.log');
  // 录制假 gh: 记录 argv；对 pulls 端点第一次回 200+ETag，带 If-None-Match 时回 304（非零退出）
  const fakeGh = join(gd, 'gh.mjs');
  writeFileSync(fakeGh, `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
    const j = (o) => JSON.stringify(o);
    const inm = args.includes('-H') && args.some((a) => a.startsWith('If-None-Match'));
    const ep = args[args.length - 1];
    const H = 'HTTP/2.0 200 OK\\r\\nEtag: W/"abc123"\\r\\n\\r\\n';
    if (args[0] === 'api' && args[1] === 'graphql') {
      // 审⑤-I1: 真两页分页——首页 100 条 hasNextPage=true，第二页 1 条收尾（第 101 条不丢）；
      // GQL_MODE 变体: no-pageinfo / stuck-cursor / bad-nodes 用于 fail-closed 断言
      const mode = process.env.GQL_MODE ?? 'paged';
      const cursorArg = args.find((a, i) => args[i - 1] === '-F' && a.startsWith('cursor='));
      const page = (nodes, hasNext, end) => j({ data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: hasNext, endCursor: end }, nodes } } } } });
      const mk = (n) => ({ id: 'T' + n, isResolved: n === 1, isOutdated: false, path: 'src/x.ts',
        comments: { nodes: [{ id: 'c' + n, body: '这里有竞态', author: { login: 'greptile' }, commit: { oid: '${'f'.repeat(40)}' } }] } });
      if (mode === 'no-pageinfo') {
        process.stdout.write(j({ data: { repository: { pullRequest: { reviewThreads: { nodes: [mk(1)] } } } } }));
      } else if (mode === 'stuck-cursor') {
        process.stdout.write(page([mk(1)], true, 'SAME')); // 每页都回 SAME → 守卫必须抛
      } else if (mode === 'bad-nodes') {
        process.stdout.write(j({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
      } else if (!cursorArg) {
        process.stdout.write(page(Array.from({ length: 100 }, (_, i) => mk(i + 1)), true, 'C1'));
      } else {
        process.stdout.write(page([mk(101)], false, null));
      }
      process.exit(0);
    }
    if (ep === 'user') { process.stdout.write(H + j({ login: 'PraiseZhu' })); process.exit(0); }
    if (ep.includes('/pulls/1') && !ep.includes('reviews') && !ep.includes('comments')) {
      if (inm) { process.stderr.write('gh: HTTP 304\\n'); process.exit(1); }
      process.stdout.write(H + j({ state: 'open', merged_at: null, head: { sha: '${'f'.repeat(40)}' }, labels: [], mergeable: true }));
      process.exit(0);
    }
    if (ep.includes('reviews') || ep.includes('comments')) { process.stdout.write(H + '[]'); process.exit(0); }
    if (ep.includes('check-runs')) { process.stdout.write(H + j({ check_runs: [] })); process.exit(0); }
    if (ep.includes('/status')) { process.stdout.write(H + j({ statuses: [] })); process.exit(0); }
    process.stderr.write('unknown endpoint ' + ep); process.exit(1);
  `);
  const ghWrap = join(gd, 'gh');
  writeFileSync(ghWrap, `#!/bin/sh\nexec "${process.execPath}" "${fakeGh}" "$@"\n`);
  execFileSync('chmod', ['+x', ghWrap]);
  const env = { ...process.env, GH_BIN: ghWrap, SNAPSHOT_CACHE_DIR: cacheDir };
  const out1 = execFileSync(process.execPath, [join(W, 'gh-snapshot.mjs'), 'o', 'r', '1'], { encoding: 'utf8', env });
  const snap1 = JSON.parse(out1);
  eq(snap1.state, 'open');
  // 审⑤-I1: 两页分页——101 条全到手（第 101 页/条不静默丢）
  eq(snap1.remote_findings.length, 101, '两页 101 条 thread 必须全量归一化');
  ok(snap1.remote_findings[0].node_id === 'T1' && snap1.remote_findings[100].node_id === 'T101', '跨页条目齐备');
  eq(snap1.remote_findings[0].resolved, true);
  const out2 = execFileSync(process.execPath, [join(W, 'gh-snapshot.mjs'), 'o', 'r', '1'], { encoding: 'utf8', env });
  const snap2 = JSON.parse(out2);
  eq(snap2.state, snap1.state, '304 输出必须与缓存一致');
  const calls = readFileSync(callLog, 'utf8');
  ok(calls.includes('If-None-Match'), '二跑必须发条件请求');
  // 审⑤-I1: 结构缺失/游标停滞不再被当成空末页——remote_findings 为空且 stderr 报 fail-closed
  for (const [mode, marker] of [['no-pageinfo', 'hasNextPage 缺失'], ['stuck-cursor', 'endCursor 重复'], ['bad-nodes', 'nodes 非数组']]) {
    const outM = execFileSync(process.execPath, [join(W, 'gh-snapshot.mjs'), 'o', 'r', '1'],
      { encoding: 'utf8', env: { ...env, GQL_MODE: mode, SNAPSHOT_CACHE_DIR: mkdtempSync(join(gd, 'c-')) },
        stdio: ['ignore', 'pipe', 'pipe'] });
    // execFileSync 只回 stdout；stderr 断言改为行为断言: findings 必须为空（fail-open 如实标注）
    const snapM = JSON.parse(outM);
    eq(snapM.remote_findings.length, 0, `GQL_MODE=${mode}（${marker}）必须 fail-closed 不产出残缺 findings`);
  }
});

// ========== 10. 审⑤ delta 验收 ==========
console.log('\n[10] 审⑤: F1 崩溃窗口 / F2 预算折叠 / F3 并发抢占 / F4 自包含链 / F5 重封 / I2-I4');

t('[审⑤F1] finalize 崩溃窗口恢复: push 成功+committed 升级前死亡 → 重跑幂等恢复并可 complete', () => {
  const d = mkdtempSync(join(tmpdir(), 'f1r-'));
  const bare = join(d, 'bare.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const wt = join(d, 'wt');
  execFileSync('git', ['init', '-q', wt]);
  const g5 = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).trim();
  g5('config', 'user.email', 't@t'); g5('config', 'user.name', 't');
  writeFileSync(join(wt, 'a.txt'), '1\n'); g5('add', '.'); g5('commit', '-qm', 'base');
  g5('checkout', '-qb', 'fix');
  g5('remote', 'add', 'origin', bare);
  g5('push', '-q', 'origin', 'fix');
  const original = g5('rev-parse', 'HEAD');
  writeFileSync(join(wt, 'a.txt'), '2\n'); g5('add', '.'); g5('commit', '-qm', 'fixc');
  const candidate = g5('rev-parse', 'HEAD');
  // 模拟崩溃窗口: push 已在远端落地（head=candidate），但只留 intent receipt
  g5('push', '-q', 'origin', `${candidate}:refs/heads/fix`);
  const stDir = join(d, 'state'); mkdirSync(stDir);
  const manifest = { owner: 'o', repo: 'r', pr_number: 3, branch: 'fix', original_head: original, dispatch_id: 'd-f1', remote: 'origin' };
  const mf = join(d, 'm.json'); writeFileSync(mf, JSON.stringify(manifest));
  writeFileSync(receiptPath(stDir, manifest), JSON.stringify({
    dispatch_id: 'd-f1', original_head: original, candidate, remote: 'origin', branch: 'fix', phase: 'intent', at: new Date().toISOString()
  }));
  const snapSh = join(d, 'snap.sh');
  writeFileSync(snapSh, `#!/bin/sh\necho "{\\"state\\":\\"open\\",\\"head_sha\\":\\"$(git --git-dir ${bare} rev-parse refs/heads/fix)\\",\\"comments\\":[]}"\n`);
  execFileSync('chmod', ['+x', snapSh]);
  // 修复前语义: CAS 因 head==candidate≠original 永拒 + complete 因无 committed 永拒 → 任务卡死
  const out = execFileSync(process.execPath, [join(S, 'pr-watch/finalize.mjs'), '--repo-dir', wt, '--manifest', mf, '--snapshot-cmd', snapSh, '--state-dir', stDir], { encoding: 'utf8' });
  ok(out.includes('恢复分支'), out);
  const rec = readJson(receiptPath(stDir, manifest));
  eq(rec.phase, 'committed', 'intent 必须被补升 committed');
  const signed5 = signMarker('done dispatch:d-f1', HMAC_KEY);
  const c5 = checkCompletion({ manifest, snapshot: { state: 'open', head_sha: candidate, comments: [{ id: '1', body: signed5 }] }, receipt: rec, hmacKey: HMAC_KEY });
  ok(c5.ok, c5.missing?.join(';'));
  // 反例: 远端被他人推进（≠intent.candidate）→ 不走恢复（recoverFromReceipt=false），CAS 正常拒
  ok(!recoverFromReceipt({ manifest, snapshot: { head_sha: 'a'.repeat(40) }, receipt: rec }), '远端非 candidate 不得恢复');
  ok(!recoverFromReceipt({ manifest: { ...manifest, dispatch_id: 'other' }, snapshot: { head_sha: candidate }, receipt: rec }), '跨 dispatch receipt 不得恢复');
});

t('[审⑤F2] budget 状态折叠: release 后新 reserve 重新计入；cap 拦并发；actual 终态', () => {
  const lf = join(mkdtempSync(join(tmpdir(), 'bg5-')), 'cost.jsonl');
  ok(reserveBudget({ ledgerFile: lf, capUsd: 20, estimateUsd: 9, dispatchId: 'dA' }).allowed);
  releaseReserve({ ledgerFile: lf, dispatchId: 'dA' });
  eq(spentToday(lf), 0, 'release 归零');
  ok(reserveBudget({ ledgerFile: lf, capUsd: 20, estimateUsd: 9, dispatchId: 'dA' }).allowed, 'release 后重试是新预留');
  eq(spentToday(lf), 9, '审⑤-F2 核心: release 之后的 reserve 必须重新计入 spent');
  const rAgain = reserveBudget({ ledgerFile: lf, capUsd: 20, estimateUsd: 9, dispatchId: 'dA' });
  ok(rAgain.allowed && rAgain.reason.includes('already-reserved'), '活跃 reserve 幂等');
  eq(spentToday(lf), 9);
  ok(!reserveBudget({ ledgerFile: lf, capUsd: 20, estimateUsd: 12, dispatchId: 'dB' }).allowed, '9+12>20: 另一 dispatch 不得越过全局 cap');
  ok(reserveBudget({ ledgerFile: lf, capUsd: 20, estimateUsd: 9, dispatchId: 'dC' }).allowed);
  eq(spentToday(lf), 18);
  recordCost(lf, { cost_usd: 7, kind: 'actual', dispatch_id: 'dA' });
  eq(spentToday(lf), 16, 'actual 取代 reserve');
  recordCost(lf, { cost_usd: 100, kind: 'actual', dispatch_id: 'dA' });
  eq(spentToday(lf), 16, '同 id 只认第一条 actual');
  recordCost(lf, { cost_usd: 5, kind: 'reserve', dispatch_id: 'dA' });
  eq(spentToday(lf), 16, 'actual 终态后 reserve 不再改变状态');
});

t('[审⑤F3] 陈锁并发抢占: 12 进程同抢死 pid 陈锁，临界区最大并发恒为 1', () => {
  const d = mkdtempSync(join(tmpdir(), 'lk5-'));
  const lockPath = join(d, 'k.lock');
  const log = join(d, 'log.txt');
  const deadPid = Number(execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim()); // shell 已退出 = 死 pid
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'dead', pid: deadPid, at: Date.now() - 11 * 60000 }));
  const old = new Date(Date.now() - 11 * 60000);
  utimesSync(lockPath, old, old);
  const script = `import('${join(S, 'lib/state-lock.mjs')}').then(async m => {
    const { appendFileSync } = await import('node:fs');
    const rel = m.acquireLock(process.argv[1], { timeoutMs: 30000 });
    appendFileSync(process.argv[2], 'E ' + Date.now() + '\\n');
    const t0 = Date.now(); while (Date.now() - t0 < 60) {}
    appendFileSync(process.argv[2], 'X ' + Date.now() + '\\n');
    rel(); process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); })`;
  const procs = [];
  for (let i = 0; i < 12; i++) {
    procs.push(new Promise((res, rej) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script, lockPath, log], { stdio: ['ignore', 'ignore', 'inherit'] });
      p.on('exit', (c) => c === 0 ? res() : rej(new Error(`lock proc ${i} exit ${c}`)));
    }));
  }
  return Promise.all(procs).then(() => {
    const ev = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    eq(ev.length, 24, '12 进程 = 24 条 enter/exit');
    let depth = 0;
    for (const line of ev) {
      depth += line.startsWith('E') ? 1 : -1;
      ok(depth >= 0 && depth <= 1, `临界区并发越界（depth=${depth}）——两进程同时进入 = 误删新持有者锁`);
    }
    eq(depth, 0);
  });
});

t('[审⑤F4] 引擎自包含链: 缺 push_remote 的旧状态不派发不烧预算；manifest.remote/branch 来自注册；wrapper 契约衔接', () => {
  // 旧格式状态文件（缺 push_remote）→ 引擎跳过派发 + journal + 预算不动
  const legacy = { schema_version: 'v1', owner: 'o', repo: 'mivo-canvas', pr_number: 41, branch: 'f41', push_repo: null, cursors: null, pending_dispatch: null, first_scan_ack: null, status: 'watching' };
  writeFileSync(join(engState, stateFileName('o', 'mivo-canvas', 41)), JSON.stringify(legacy));
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, comments: [{ id: 'k41', body: '修一下' }] }));
  const b41 = BUDGET();
  let r = runEngine(ENG({ budget: b41 }));
  eq(r.dispatched.length, 0, '缺 push_remote 不得派发');
  eq(spentToday(b41.ledger), 0, '未派发不得占预算');
  ok(readFileSync(join(engDir, 'journal.jsonl'), 'utf8').includes('state-invalid'), '必须留痕 state-invalid');
  execFileSync('rm', [join(engState, stateFileName('o', 'mivo-canvas', 41))]);
  // 注册协议 v2 全链: register(fork) → engine 派发 → manifest 字段来自注册 → wrapper 必填校验通过
  registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 42, branch: 'f42', pushRemote: 'fork', pushRepo: 'PraiseZhu/cindy-fork' });
  r = runEngine(ENG({ budget: BUDGET() }));
  eq(r.dispatched.length, 1);
  const m42 = readJson(join(engState, stateFileName('o', 'mivo-canvas', 42))).pending_dispatch.manifest;
  eq(m42.remote, 'fork', 'remote 必须来自注册的 push_remote（不是引擎猜测）');
  eq(m42.branch, 'f42');
  eq(m42.push_repo, 'PraiseZhu/cindy-fork');
  // wrapper 必填清单对 manifest 全量通过（branch/remote 已在单内）
  for (const k of ['dispatch_id', 'owner', 'repo', 'pr_number', 'worktree_name', 'state_dir', 'snapshot_cmd', 'manifest_path', 'finalize_cmd', 'complete_cmd', 'original_head', 'branch', 'remote']) {
    ok(m42[k], `engine 产出的 manifest 缺 wrapper 必填字段 ${k}`);
  }
  ackDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 42, dispatchId: m42.dispatch_id });
  unregisterPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 42 });
});

t('[审⑤F5] 台账重封被拦: 截尾/改行/删侧车/删整账后 append 一律拒且 head 不变', () => {
  const lf = join(mkdtempSync(join(tmpdir(), 'lg5-')), 'l.jsonl');
  appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'k', instance_key: 'PR#1', summary: 'a' } });
  appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'k', instance_key: 'PR#2', summary: 'b' } });
  appendLedger({ ledgerFile: lf, entry: { kind: 'rejected', channel: 'E4', pattern_key: 'k', instance_key: 'rej', reason: 'no' } });
  const lines5 = readFileSync(lf, 'utf8').split('\n').filter(Boolean);
  const headBefore = readFileSync(`${lf}.head`, 'utf8');
  // 攻击①: 截尾删 rejected 后 append（审⑤-F5 核心: 旧实现会以新末行重封链+覆盖 head）
  writeFileSync(lf, lines5.slice(0, 2).join('\n') + '\n');
  let threw = false;
  try { appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'k', instance_key: 'PR#3', summary: 'c' } }); }
  catch (e) { threw = /head 侧车不一致/.test(e.message); }
  ok(threw, '截尾后 append 必拒');
  eq(readFileSync(`${lf}.head`, 'utf8'), headBefore, 'head 侧车不得被重封');
  eq(readFileSync(lf, 'utf8').split('\n').filter(Boolean).length, 2, '拒写时台账不得被追加');
  // 攻击②: 改中间行
  writeFileSync(lf, [lines5[0], lines5[1].replace('PR#2', 'PR#9'), lines5[2]].join('\n') + '\n');
  threw = false;
  try { appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'k', instance_key: 'PR#4', summary: 'd' } }); }
  catch (e) { threw = /链断裂/.test(e.message); }
  ok(threw, '改中间行后 append 必拒');
  // 攻击③: 删 head 侧车
  writeFileSync(lf, lines5.join('\n') + '\n');
  execFileSync('rm', [`${lf}.head`]);
  threw = false;
  try { appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'k', instance_key: 'PR#5', summary: 'e' } }); }
  catch (e) { threw = /侧车缺失/.test(e.message); }
  ok(threw, '删侧车后 append 必拒');
  // 攻击④: 删整账留侧车
  writeFileSync(`${lf}.head`, headBefore);
  execFileSync('rm', [lf]);
  threw = false;
  try { appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'k', instance_key: 'PR#6', summary: 'f' } }); }
  catch (e) { threw = /整账被删/.test(e.message); }
  ok(threw, '删整账后 append 必拒');
});

t('[审⑤I2] 生产 constitution/文档契约: fast_ledger_path 在位；两份文档均为 v2 全字段协议', () => {
  const prod = readJson(join(S, 'evolution/constitution-paths.json'));
  ok(typeof prod.fast_ledger_path === 'string' && prod.fast_ledger_path.length > 0, '生产 constitution 必须钉 fast_ledger_path');
  ok(Array.isArray(prod.confirm_rule_allowlist), 'confirm_rule_allowlist 必须在宪法内（审⑤-F6）');
  const skill = readFileSync(join(S, '../skills/submit-pr/SKILL.md'), 'utf8');
  const p1 = readFileSync(join(S, '../skills/submit-pr/references/phase1-checks.md'), 'utf8');
  for (const [name, doc] of [['SKILL.md', skill], ['phase1-checks.md', p1]]) {
    ok(doc.includes('expires_at'), `${name} 必须写明 expires_at`);
    ok(doc.includes('v:2') || doc.includes('v2'), `${name} 必须是 v2 协议`);
    ok(!/HMAC\((?:PR_AUTOPILOT_FAST_KEY, )?repo\|branch\|expected_sha\)/.test(doc), `${name} 不得残留旧拼串签名协议`);
  }
});

t('[审⑤I3] 状态文件严格文法: garbage__5.json / archive-x__5.json / 名实不符 → 不扫描不派发', () => {
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, comments: [{ id: 'kg', body: 'x' }] }));
  writeFileSync(join(engState, 'garbage__5.json'), JSON.stringify({ owner: 'evil', repo: 'evil', pr_number: 5, branch: 'b', push_remote: 'origin' }));
  writeFileSync(join(engState, 'archive-x__y__5.json'), JSON.stringify({ owner: 'someone', repo: 'else', pr_number: 5, branch: 'b', push_remote: 'origin' }));
  const r = runEngine(ENG({ budget: BUDGET() }));
  eq(r.dispatched.length, 0, '杂质文件不得引发派发');
  // garbage__5.json 只有两段 → 文法直接拒；archive-x__y__5.json 文法三段但内容 owner/repo
  // 与文件名不符 → 反向一致性拒。再补一个独立的名实不符用例:
  writeFileSync(join(engState, 'aa__bb__7.json'), JSON.stringify({ owner: 'o', repo: 'mivo-canvas', pr_number: 5, branch: 'b', push_remote: 'origin' }));
  const r2 = runEngine(ENG({ budget: BUDGET() }));
  ok(readFileSync(join(engDir, 'journal.jsonl'), 'utf8').includes('state-file-rejected'), '名实不符必须留痕拒绝');
  ok(!r2.dispatched.some((x) => x.pr === 'o/mivo-canvas#5'), '名实不符不得按内容派发');
  for (const f of ['garbage__5.json', 'archive-x__y__5.json', 'aa__bb__7.json']) execFileSync('rm', ['-f', join(engState, f)]);
});

t('[审⑤I4] overflow 游标损坏: strict 阻断发送且原文件保留；非 strict 记 journal 继续', () => {
  const { d, sh } = mkDigestEnv();
  const cursor = join(d, 'cursor.json');
  writeFileSync(cursor, '{broken json');
  const sent = join(d, 'sent.log');
  const cfg = {
    fetchCmd: sh('f.sh', `echo '[]'`), sendCmd: sh('s.sh', `cat >> "${sent}"`),
    preflightCmd: sh('p.sh', `cat > /dev/null\necho '{}'`), markReadCmd: sh('m.sh', 'cat > /dev/null'),
    ownPrsCmd: sh('o.sh', `echo '[]'`), stateDir: join(d, 'st'), markedReadFile: join(d, 'mr.jsonl'),
    journalFile: join(d, 'j.jsonl'), cursorFile: cursor
  };
  mkdirSync(cfg.stateDir);
  let threw = false;
  try { runDigest(cfg); } catch (e) { threw = /游标存在但不可读/.test(e.message); }
  ok(threw, 'strict 下损坏游标必须阻断发送');
  ok(!existsSync(sent), '阻断 = 一个字都没发出去');
  eq(readFileSync(cursor, 'utf8'), '{broken json', '原游标文件必须原样保留');
  // 结构非法（overflow_items 非数组）同样阻断
  writeFileSync(cursor, JSON.stringify({ at: 'x', overflow_items: 'not-an-array' }));
  threw = false;
  try { runDigest(cfg); } catch (e) { threw = /游标存在但不可读|结构/.test(e.message); }
  ok(threw, '结构非法同样阻断');
  // 非 strict: 记 journal 继续（单元/研发模式）
  const rNs = runDigest({ ...cfg, strict: false });
  ok(rNs.sent, '非 strict 降级继续');
  ok(readFileSync(cfg.journalFile, 'utf8').includes('cursor-error'));
});

// ========== 11. 审⑥ delta 验收 ==========
console.log('\n[11] 审⑥: F1 迁移 / F2 零字节截尾 / F3 规则签名 / F4 reaper 残骸 / F5 恢复闸 / F6 未知 kind');

t('[审⑥F1] v1→v2 迁移: 旧状态再注册补齐接线且游标/pending 保留 → engine 真派发', () => {
  // 手写 v1 旧状态: 缺 push_remote、有历史游标（迁移不得重置）
  const oldCursors = { review_ids: ['r-old'], comment_ids: ['c-old'], ci_run_ids: [], finding_ids: [] };
  const legacy = {
    schema_version: 'v1', owner: 'o', repo: 'mivo-canvas', pr_number: 51, branch: null,
    push_repo: null, cursors: oldCursors, pending_dispatch: null, first_scan_ack: '2026-01-01T00:00:00Z', status: 'watching'
  };
  const f51 = join(engState, stateFileName('o', 'mivo-canvas', 51));
  writeFileSync(f51, JSON.stringify(legacy));
  // 迁移前: engine 跳过（state-invalid），不烧预算——已被 [审⑤F4] 覆盖。执行迁移:
  const r1 = registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 51, branch: 'f51', pushRemote: 'origin', pushRepo: null });
  ok(r1.already && r1.migrated, '既有状态必须走迁移分支');
  const migrated = readJson(f51);
  eq(migrated.schema_version, 'v2');
  eq(migrated.branch, 'f51'); eq(migrated.push_remote, 'origin');
  eq(migrated.cursors.comment_ids, ['c-old'], '迁移不得重置游标（防重复派发）');
  eq(migrated.first_scan_ack, '2026-01-01T00:00:00Z', '回执要素不得被迁移抹掉');
  // 纠错再注册: push_remote origin→fork 可修正
  const r2 = registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 51, branch: 'f51', pushRemote: 'fork', pushRepo: 'PraiseZhu/cindy-fork' });
  ok(r2.already && r2.migrated);
  eq(readJson(f51).push_remote, 'fork', '错误注册必须可重注册纠正');
  // 无变化的重注册: 幂等不改文件
  const r3 = registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 51, branch: 'f51', pushRemote: 'fork', pushRepo: 'PraiseZhu/cindy-fork' });
  ok(r3.already && !r3.migrated, '无 diff 的重注册不重写');
  // 迁移后 engine 真派发（新信号不在旧游标里）
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, comments: [{ id: 'c-new', body: '修一下' }] }));
  const rE = runEngine(ENG({ budget: BUDGET() }));
  ok(rE.dispatched.some((x) => x.pr === 'o/mivo-canvas#51'), '迁移后必须能派发');
  const m51 = readJson(f51).pending_dispatch.manifest;
  eq(m51.remote, 'fork'); eq(m51.branch, 'f51');
  ackDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 51, dispatchId: m51.dispatch_id });
  unregisterPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 51 });
});

t('[审⑥F1-⑥] 在途 pending + 接线纠错 → fail-closed 拒迁移；同接线 schema 迁移保 pending；push_repo 三态清空', () => {
  const f52 = join(engState, stateFileName('o', 'mivo-canvas', 52));
  const pending = {
    dispatch_id: 'd-old', dispatched_at: new Date().toISOString(), redispatch_count: 0,
    manifest: { dispatch_id: 'd-old', branch: 'old-branch', remote: 'fork', push_repo: 'BadOwner/bad-fork' },
    budget: { ledger: join(engDir, 'cancel52.jsonl'), estimate: 1 } // 审⑨: cancel 只认此权威账本
  };
  const cursors52 = { review_ids: ['r-1'], comment_ids: ['c-1'], ci_run_ids: [], finding_ids: [] };
  writeFileSync(f52, JSON.stringify({
    schema_version: 'v1', owner: 'o', repo: 'mivo-canvas', pr_number: 52, branch: 'old-branch',
    push_repo: 'BadOwner/bad-fork', push_remote: 'fork', cursors: cursors52, pending_dispatch: pending,
    first_scan_ack: null, status: 'fixing'
  }));
  // 接线变化 + 在途 pending → 拒（旧 manifest 不得沿旧 remote 重派）
  let threw = false;
  try { registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 52, branch: 'main', pushRemote: 'origin', pushRepo: null }); }
  catch (e) { threw = /迁移拒绝/.test(e.message); }
  ok(threw, '在途 dispatch + 接线变化必须 fail-closed');
  eq(readJson(f52).push_remote, 'fork', '拒迁移时 state 必须原样');
  // 同接线的 schema-only 迁移: 允许，pending 原样保留
  const rSame = registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 52, branch: 'old-branch', pushRemote: 'fork', pushRepo: 'BadOwner/bad-fork' });
  ok(rSame.already && rSame.migrated, 'schema v1→v2 是迁移');
  const st52 = readJson(f52);
  eq(st52.schema_version, 'v2');
  eq(st52.pending_dispatch.dispatch_id, 'd-old', '同接线迁移必须保留在途 pending');
  // 审⑦-P1: 解卡走 cancel（不是 ack）——不消费游标、升 generation；随后接线纠错放行
  const rc = cancelDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 52, dispatchId: 'd-old' });
  ok(rc.ok); eq(rc.generation, 1);
  const stC = readJson(f52);
  eq(stC.cursors.comment_ids, ['c-1'], 'cancel 绝不消费游标（未完成的反馈必须能重派）');
  eq(stC.pending_dispatch, null);
  const rFix = registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 52, branch: 'main', pushRemote: 'origin', pushRepo: null });
  ok(rFix.migrated);
  const st52b = readJson(f52);
  eq(st52b.push_remote, 'origin');
  eq(st52b.push_repo, null, 'pushRepo:null 必须显式清空旧 fork');
  // undefined = 保留语义: 不传 pushRepo 不得覆盖
  registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 52, branch: 'main', pushRemote: 'origin' });
  eq(readJson(f52).push_repo, null);
  // CLI: --clear-push-repo 直通
  const dCli = mkdtempSync(join(tmpdir(), 'rc6-'));
  execFileSync(process.execPath, [join(S, 'pr-watch/register.mjs'), '--state-dir', dCli, '--owner', 'a', '--repo', 'b', '--pr', '1', '--branch', 'x', '--push-remote', 'fork', '--push-repo', 'p/f'], { encoding: 'utf8' });
  execFileSync(process.execPath, [join(S, 'pr-watch/register.mjs'), '--state-dir', dCli, '--owner', 'a', '--repo', 'b', '--pr', '1', '--branch', 'x', '--push-remote', 'origin', '--clear-push-repo'], { encoding: 'utf8' });
  eq(readJson(join(dCli, stateFileName('a', 'b', 1))).push_repo, null, 'CLI --clear-push-repo 必须清空');
  unregisterPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 52 });
});

t('[审⑦P1] cancel≠ack 全回归: pending→cancel→迁移→同信号新 id 重派；旧 id 迟到 ack 拒；预算释放', () => {
  registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 61, branch: 'f61', pushRemote: 'fork', pushRepo: 'PraiseZhu/cindy-fork' });
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, comments: [{ id: 'c61', body: '有新反馈' }] }));
  const b7 = BUDGET();
  let r = runEngine(ENG({ budget: b7 }));
  const f61 = join(engState, stateFileName('o', 'mivo-canvas', 61));
  const id1 = readJson(f61).pending_dispatch.dispatch_id;
  ok(r.dispatched.some((x) => x.dispatch_id === id1));
  eq(spentToday(b7.ledger), 1, '派发占预留');
  // cancel: 清 pending + 释放预留 + 升 generation，游标不动
  const rc = cancelDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 61, dispatchId: id1, budgetLedger: b7.ledger });
  ok(rc.ok && rc.generation === 1);
  eq(spentToday(b7.ledger), 0, 'cancel 必须释放预算预留');
  // 接线纠错（fork→origin 清 fork）此刻放行
  registerPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 61, branch: 'f61', pushRemote: 'origin', pushRepo: null });
  // 同一批反馈（游标未动）→ engine 以新 generation 新 id 重派
  r = runEngine(ENG({ budget: b7 }));
  const pd2 = readJson(f61).pending_dispatch;
  ok(pd2, '取消后同信号必须能重派（at-least-once）');
  ok(pd2.dispatch_id !== id1, 'generation 纳入 id: 新派发必须是新 id');
  eq(pd2.manifest.remote, 'origin', '重派 manifest 用纠错后的接线');
  ok(pd2.manifest.signals.length >= 1);
  // 旧会话迟到 ack 拿旧 id → 拒，游标不动
  ok(!ackDispatch({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 61, dispatchId: id1 }).ok, '旧 id 迟到 ack 必须被拒');
  ok(readJson(f61).pending_dispatch, '旧 ack 不得清掉新 pending');
  // 审⑧-P1-1: 裸 ack CLI 已拆除——直跑必须非零且 state 原样（吞反馈通道不存在）
  let bareAckFailed = false;
  try {
    execFileSync(process.execPath, [join(S, 'pr-watch/ack.mjs'), '--state-dir', engState, '--owner', 'o', '--repo', 'mivo-canvas', '--pr', '61', '--dispatch-id', pd2.dispatch_id], { encoding: 'utf8', stdio: 'pipe' });
  } catch { bareAckFailed = true; }
  ok(bareAckFailed, '裸 ack CLI 必须非零退出');
  ok(readJson(f61).pending_dispatch, '裸 ack CLI 不得清 pending');
  ok(!(readJson(f61).cursors?.comment_ids ?? []).includes('c61'), '裸 ack CLI 不得推进游标');
  // 审⑧-P1-1: 正收口必须走 complete CLI——receipt(committed) + 远端 head==candidate + HMAC 回帖
  const cand61 = 'e'.repeat(40);
  writeFileSync(receiptPath(engState, pd2.manifest), JSON.stringify({
    dispatch_id: pd2.dispatch_id, original_head: pd2.manifest.original_head, candidate: cand61,
    remote: pd2.manifest.remote, branch: pd2.manifest.branch, phase: 'committed', at: new Date().toISOString()
  }));
  writeFileSync(snapFile, JSON.stringify({ ...snapBase, head_sha: cand61, comments: [{ id: 'z61', body: signMarker(`fixed dispatch:${pd2.dispatch_id}`, HMAC_KEY) }] }));
  const compOut = execFileSync(process.execPath, [join(S, 'pr-watch/complete.mjs'), '--manifest', pd2.manifest.manifest_path, '--snapshot-cmd', join(engDir, 'snap.sh') + ' {owner} {repo} {pr}', '--state-dir', engState], { encoding: 'utf8', env: { ...process.env, PR_AUTOPILOT_HMAC_KEY: HMAC_KEY } });
  ok(JSON.parse(compOut.trim()).ok, 'complete 正例必须 ack 成功');
  ok((readJson(f61).cursors?.comment_ids ?? []).includes('c61'), '只有 complete 核验通过后游标才消费 c61');
  eq(readJson(f61).pending_dispatch, null);
  unregisterPr({ stateDir: engState, owner: 'o', repo: 'mivo-canvas', prNumber: 61 });
});

t('[审⑥F4-⑥] 活 reaper 挡道时 timeoutMs 仍然生效: 有界抛「获取锁超时」而非永久挂死', () => {
  const d6 = mkdtempSync(join(tmpdir(), 'lk6b-'));
  const lockPath = join(d6, 'k.lock');
  const deadPid = Number(execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim());
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'dead', pid: deadPid, at: Date.now() - 11 * 60000 }));
  const old6 = new Date(Date.now() - 11 * 60000);
  utimesSync(lockPath, old6, old6);
  // 陈旧但「活」的 reaper（pid = 本进程，模拟被 SIGSTOP 的回收者）——既不给回收也不算残骸
  const reaper = `${lockPath}.reaper`;
  writeFileSync(reaper, JSON.stringify({ pid: process.pid, at: Date.now() - 60000 }));
  utimesSync(reaper, old6, old6);
  const t0 = Date.now();
  let threw = false;
  try { acquireLock(lockPath, { timeoutMs: 500 }); }
  catch (e) { threw = /获取锁超时/.test(e.message); }
  const elapsed = Date.now() - t0;
  ok(threw, '必须抛获取锁超时（不得永久挂死）');
  ok(elapsed < 5000, `必须有界返回（实测 ${elapsed}ms）`);
});

t('[审⑥F2] 台账 truncate 为 0 字节（文件在/侧车在）→ 拒按 GENESIS 重封；全新空账正常起链', () => {
  const d6 = mkdtempSync(join(tmpdir(), 'lg6-'));
  const lf = join(d6, 'l.jsonl');
  appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'z', instance_key: 'PR#1', summary: 'a' } });
  appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'z', instance_key: 'PR#2', summary: 'b' } });
  const headBefore = readFileSync(`${lf}.head`, 'utf8');
  writeFileSync(lf, ''); // 整本清空但文件仍存在
  let threw = false;
  try { appendLedger({ ledgerFile: lf, entry: { channel: 'E4', pattern_key: 'z', instance_key: 'PR#3', summary: 'c' } }); }
  catch (e) { threw = /truncate|历史锚点/.test(e.message); }
  ok(threw, '0 字节截尾必须拒（不得按 GENESIS 重封）');
  eq(readFileSync(`${lf}.head`, 'utf8'), headBefore, 'head 侧车必须原样');
  eq(readFileSync(lf, 'utf8'), '', '台账必须原样（拒写）');
  // 对照: 全新空账（touch 出的 0 字节文件，无侧车）允许 GENESIS 起链
  const fresh = join(d6, 'fresh.jsonl');
  writeFileSync(fresh, '');
  ok(appendLedger({ ledgerFile: fresh, entry: { channel: 'E4', pattern_key: 'z', instance_key: 'PR#1', summary: 'a' } }).appended, '无历史锚点的空账正常起链');
});

t('[审⑥F4] reaper 残骸（死 pid + 超时）→ acquireLock fail-closed 报人工，不自动清理', () => {
  const d6 = mkdtempSync(join(tmpdir(), 'lk6-'));
  const lockPath = join(d6, 'k.lock');
  const deadPid = Number(execFileSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim());
  // 陈主锁 + 陈死 reaper 残骸
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'dead', pid: deadPid, at: Date.now() - 11 * 60000 }));
  const old6 = new Date(Date.now() - 11 * 60000);
  utimesSync(lockPath, old6, old6);
  const reaper = `${lockPath}.reaper`;
  writeFileSync(reaper, JSON.stringify({ pid: deadPid, at: Date.now() - 60000 }));
  utimesSync(reaper, old6, old6);
  let threw = false;
  try { acquireLock(lockPath, { timeoutMs: 2000 }); }
  catch (e) { threw = /残骸/.test(e.message); }
  ok(threw, '陈死 reaper 必须显式报人工（不得裸 rename 自清引入 ABA 双 reaper）');
  ok(existsSync(reaper), 'reaper 残骸必须原样留给人工核查');
  // 人工清理后正常抢占陈锁
  execFileSync('rm', [reaper]);
  const rel = acquireLock(lockPath, { timeoutMs: 5000 });
  rel();
});

t('[审⑥F5] recoverFromReceipt: 非法 phase / 缺 phase / 跨 branch/remote/original_head / 非 SHA candidate → 全拒', () => {
  const base6 = { owner: 'o', repo: 'r', pr_number: 1, branch: 'fix', original_head: 'a'.repeat(40), dispatch_id: 'd6', remote: 'origin' };
  const cand = 'b'.repeat(40);
  const okRec = { dispatch_id: 'd6', original_head: base6.original_head, candidate: cand, remote: 'origin', branch: 'fix', phase: 'intent' };
  const snap6 = { head_sha: cand };
  ok(recoverFromReceipt({ manifest: base6, snapshot: snap6, receipt: okRec }), '合法 intent + 远端核实应恢复');
  ok(recoverFromReceipt({ manifest: base6, snapshot: snap6, receipt: { ...okRec, phase: 'committed' } }));
  for (const [why, rec] of [
    ['phase=garbage', { ...okRec, phase: 'garbage' }],
    ['缺 phase', { ...okRec, phase: undefined }],
    ['跨 branch', { ...okRec, branch: 'other' }],
    ['跨 remote', { ...okRec, remote: 'upstream' }],
    ['original_head 不符', { ...okRec, original_head: 'c'.repeat(40) }],
    ['candidate 非 SHA', { ...okRec, candidate: 'not-a-sha' }]
  ]) {
    ok(!recoverFromReceipt({ manifest: base6, snapshot: snap6, receipt: rec }), `恢复入口必须拒: ${why}`);
  }
});

t('[审⑥F6] 台账未知 kind → fold/spent/reserve 全部抛错，不得洗成已结算', () => {
  const d6 = mkdtempSync(join(tmpdir(), 'bg6-'));
  const lf = join(d6, 'cost.jsonl');
  writeFileSync(lf, JSON.stringify({ at: new Date().toISOString(), kind: 'typo', dispatch_id: 'd', cost_usd: 0 }) + '\n');
  let threw = false;
  try { spentToday(lf); } catch (e) { threw = /未知 kind/.test(e.message); }
  ok(threw, 'spentToday 必须对未知 kind 抛错');
  threw = false;
  try { reserveBudget({ ledgerFile: lf, capUsd: 20, estimateUsd: 9, dispatchId: 'd' }); }
  catch (e) { threw = /未知 kind/.test(e.message); }
  ok(threw, 'reserveBudget 不得把损坏账当 already-settled 放行');
  // 旧格式（kind 缺失）仍按 actual 兼容
  const lf2 = join(d6, 'legacy.jsonl');
  writeFileSync(lf2, JSON.stringify({ at: new Date().toISOString(), cost_usd: 3 }) + '\n');
  eq(spentToday(lf2), 3, '旧格式（无 kind）按 actual 兼容');
  // reserve/release 缺 dispatch_id 同样抛
  const lf3 = join(d6, 'noid.jsonl');
  writeFileSync(lf3, JSON.stringify({ at: new Date().toISOString(), kind: 'reserve', dispatch_id: null, cost_usd: 5 }) + '\n');
  threw = false;
  try { spentToday(lf3); } catch (e) { threw = /缺 dispatch_id/.test(e.message); }
  ok(threw, '无主 reserve 必须抛错');
});

// ========== 12. 审⑧ delta 验收 ==========
console.log('\n[12] 审⑧: P1-1 裸 ack 拆除 / P1-2 旧会话 finalize 拦截 / P2-1 预算释放原子化');

t('[审⑧P1-2] cancel/替换后旧 manifest finalize 在 push 前被拦，远端不变；已有 receipt 时 cancel 拒', () => {
  const d8 = mkdtempSync(join(tmpdir(), 'f8-'));
  const bare = join(d8, 'bare.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const wt = join(d8, 'wt');
  execFileSync('git', ['init', '-q', wt]);
  const g8 = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).trim();
  g8('config', 'user.email', 't@t'); g8('config', 'user.name', 't');
  writeFileSync(join(wt, 'a.txt'), '1\n'); g8('add', '.'); g8('commit', '-qm', 'base');
  g8('checkout', '-qb', 'fix');
  g8('remote', 'add', 'origin', bare);
  g8('push', '-q', 'origin', 'fix');
  const original = g8('rev-parse', 'HEAD');
  writeFileSync(join(wt, 'a.txt'), '2\n'); g8('add', '.'); g8('commit', '-qm', 'fixc');
  const candidate = g8('rev-parse', 'HEAD');
  const stDir = join(d8, 'state'); mkdirSync(stDir);
  const mkM = (id) => ({ owner: 'o', repo: 'r', pr_number: 3, branch: 'fix', original_head: original, dispatch_id: id, remote: 'origin' });
  const snapSh = join(d8, 'snap.sh');
  writeFileSync(snapSh, `#!/bin/sh\necho "{\\"state\\":\\"open\\",\\"head_sha\\":\\"$(git --git-dir ${bare} rev-parse refs/heads/fix)\\",\\"comments\\":[]}"\n`);
  execFileSync('chmod', ['+x', snapSh]);
  const remoteHead = () => execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/fix'], { encoding: 'utf8' }).trim();
  // 场景: 该 PR 的 pending 已被替换为 d-new（cancel→迁移→重派），旧会话仍持 d-old manifest
  const stFile8 = join(stDir, stateFileName('o', 'r', 3));
  writeFileSync(stFile8, JSON.stringify({ schema_version: 'v2', owner: 'o', repo: 'r', pr_number: 3, branch: 'fix', push_remote: 'origin', pending_dispatch: { dispatch_id: 'd-new', dispatched_at: new Date().toISOString(), manifest: {} }, cursors: null, status: 'fixing' }));
  const mfOld = join(d8, 'm-old.json'); writeFileSync(mfOld, JSON.stringify(mkM('d-old')));
  let failedPrePush = false, errOut = '';
  try { execFileSync(process.execPath, [join(S, 'pr-watch/finalize.mjs'), '--repo-dir', wt, '--manifest', mfOld, '--snapshot-cmd', snapSh, '--state-dir', stDir], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { failedPrePush = true; errOut = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  ok(failedPrePush && /已被取消\/替换/.test(errOut), `旧 manifest finalize 必须在 push 前非零: ${errOut.slice(0, 200)}`);
  eq(remoteHead(), original, '远端必须原样（git push 从未执行）');
  ok(!existsSync(receiptPath(stDir, mkM('d-old'))), '被拦时不得留下 intent receipt');
  // 正控: pending 与 manifest 一致 → pending 门放行，流程推进到 remote URL 守卫
  // （本地 bare 路径过不了 github host 钉死——正是守卫应有行为；真 push 全链在 P2 真机出口）
  writeFileSync(stFile8, JSON.stringify({ schema_version: 'v2', owner: 'o', repo: 'r', pr_number: 3, branch: 'fix', push_remote: 'origin', pending_dispatch: { dispatch_id: 'd-old', dispatched_at: new Date().toISOString(), manifest: {} }, cursors: null, status: 'fixing' }));
  let errOut2 = '';
  try { execFileSync(process.execPath, [join(S, 'pr-watch/finalize.mjs'), '--repo-dir', wt, '--manifest', mfOld, '--snapshot-cmd', snapSh, '--state-dir', stDir], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { errOut2 = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  ok(!/已被取消\/替换/.test(errOut2) && /push URL 不是/.test(errOut2), `pending 匹配时必须通过 pending 门、到达 remote URL 守卫: ${errOut2.slice(0, 200)}`);
  eq(remoteHead(), original, '守卫链未全过时远端仍不变');
  // 审⑧-P1-2 cancel 侧: 已有 intent receipt（push 意图已表达）→ cancel fail-closed
  writeFileSync(receiptPath(stDir, mkM('d-old')), JSON.stringify({
    dispatch_id: 'd-old', original_head: original, candidate, remote: 'origin', branch: 'fix', phase: 'intent', at: new Date().toISOString()
  }));
  const led8 = join(d8, 'cost.jsonl');
  const rcRefuse = cancelDispatch({ stateDir: stDir, owner: 'o', repo: 'r', prNumber: 3, dispatchId: 'd-old', budgetLedger: led8 });
  ok(!rcRefuse.ok && /receipt/.test(rcRefuse.reason), '已有 push receipt 的 dispatch 不得取消');
  ok(readJson(stFile8).pending_dispatch, '拒取消时 pending 原样（只能走 complete）');
});

t('[审⑨P2-1R] cancel 权威账本 + 两阶段状态机: 错账本拒 / release 失败留 canceling / 引擎逐崩溃点收敛', () => {
  const d9 = mkdtempSync(join(tmpdir(), 'bc9-'));
  const stDir = join(d9, 'state'); mkdirSync(stDir);
  const ledDir = join(d9, 'ledgers'); mkdirSync(ledDir);
  const led = join(ledDir, 'cost.jsonl');
  const wrong = join(d9, 'wrong.jsonl');
  const snapJson = join(d9, 'snap.json');
  writeFileSync(snapJson, JSON.stringify(snapBase));
  writeFileSync(join(d9, 'snap.sh'), `#!/bin/sh\ncat "${snapJson}"\n`);
  writeFileSync(join(d9, 'nul.sh'), '#!/bin/sh\ncat > /dev/null\n');
  for (const f of ['snap.sh', 'nul.sh']) execFileSync('chmod', ['+x', join(d9, f)]);
  const ENG9 = () => ({
    stateDir: stDir, leaseFile: join(d9, 'lease.json'),
    snapshotCmd: join(d9, 'snap.sh') + ' {owner} {repo} {pr}',
    dispatchCmd: join(d9, 'nul.sh'), journalFile: join(d9, 'journal.jsonl'),
    hmacKey: HMAC_KEY, budget: { ledger: join(d9, 'engine-budget.jsonl'), cap: 10000, estimate: 1 }, repoDirs: {}
  });
  const mkPending = (over = {}) => ({
    dispatch_id: 'd-x', dispatched_at: new Date().toISOString(), redispatch_count: 0,
    manifest: { dispatch_id: 'd-x' }, budget: { ledger: led, estimate: 9 }, ...over
  });
  const stF = join(stDir, stateFileName('o', 'mivo-canvas', 9));
  const writeSt = (pd) => writeFileSync(stF, JSON.stringify({ schema_version: 'v2', owner: 'o', repo: 'mivo-canvas', pr_number: 9, branch: 'b', push_remote: 'origin', pending_dispatch: pd, cursors: null, status: 'fixing' }));
  writeSt(mkPending());
  ok(reserveBudget({ ledgerFile: led, capUsd: 30, estimateUsd: 9, dispatchId: 'd-x' }).allowed);
  eq(spentToday(led), 9);
  // ① 错误但可写的账本 → 拒且 state/真实账本/错账本全原样（洗账通道不存在）
  const rWrong = cancelDispatch({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 9, dispatchId: 'd-x', budgetLedger: wrong });
  ok(!rWrong.ok && /权威账本不符/.test(rWrong.reason), '错账本必须拒');
  ok(readJson(stF).pending_dispatch && !readJson(stF).pending_dispatch.canceling, 'state 原样');
  eq(spentToday(led), 9, '真实预留原样');
  ok(!existsSync(wrong), '错账本一个字都不许写');
  // ② pending 缺权威账本（非引擎标准派发）→ 拒
  const stF10 = join(stDir, stateFileName('o', 'mivo-canvas', 10));
  writeFileSync(stF10, JSON.stringify({ schema_version: 'v2', owner: 'o', repo: 'mivo-canvas', pr_number: 10, branch: 'b', push_remote: 'origin', pending_dispatch: { dispatch_id: 'd-y', dispatched_at: new Date().toISOString(), manifest: {} }, cursors: null, status: 'fixing' }));
  const rNoAuth = cancelDispatch({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 10, dispatchId: 'd-y' });
  ok(!rNoAuth.ok && /权威 budget 账本/.test(rNoAuth.reason));
  execFileSync('rm', [stF10]);
  // ③ release 失败（权威账本目录 EACCES）→ 抛、canceling 留盘、预留原样；
  //    引擎在 release 仍失败时: journal + 保持 canceling + 不重派
  execFileSync('chmod', ['555', ledDir]);
  let threw = false;
  try { cancelDispatch({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 9, dispatchId: 'd-x' }); }
  catch { threw = true; }
  ok(threw, 'release 失败必须抛');
  ok(readJson(stF).pending_dispatch.canceling === true, 'Phase A 已落盘: canceling 状态在');
  eq(spentToday(led), 9, '预留未被错误清掉');
  let r9 = runEngine(ENG9());
  eq(r9.dispatched.length, 0, 'canceling pending 绝不重派（无预留 session 不可能出现）');
  ok(readFileSync(join(d9, 'journal.jsonl'), 'utf8').includes('cancel-resume-release-failed'), '引擎必须留痕恢复失败');
  ok(readJson(stF).pending_dispatch.canceling === true, '恢复失败保持 canceling（fail-closed）');
  // ④ 权威账本恢复可写 → 引擎收敛: release + 清 pending + 升 generation，仍不按旧单重派
  execFileSync('chmod', ['755', ledDir]);
  r9 = runEngine(ENG9());
  eq(r9.dispatched.length, 0);
  const stConv = readJson(stF);
  eq(stConv.pending_dispatch, null, '引擎收敛后 pending 清空');
  eq(stConv.dispatch_generation, 1, '收敛即升 generation');
  eq(spentToday(led), 0, '预留已释放');
  ok(readFileSync(join(d9, 'journal.jsonl'), 'utf8').includes('cancel-resumed'));
  // ⑤ 崩溃点「release 已落账、Phase C 未执行」: canceling + release 已在账 → 引擎收敛且不出负账
  writeSt(mkPending({ dispatch_id: 'd-z', canceling: true, budget: { ledger: led, estimate: 9 } }));
  ok(reserveBudget({ ledgerFile: led, capUsd: 30, estimateUsd: 9, dispatchId: 'd-z' }).allowed);
  releaseReserve({ ledgerFile: led, dispatchId: 'd-z' }); // 模拟 Phase B 已完成后崩溃
  eq(spentToday(led), 0);
  r9 = runEngine(ENG9());
  eq(readJson(stF).pending_dispatch, null);
  eq(spentToday(led), 0, '重复 release 不产生负账/重复计账');
  // ⑥ 正常全程: cancel 无 --ledger（权威来自 pending）→ ok、spent 归零、generation 推进
  writeSt(mkPending({ dispatch_id: 'd-w', budget: { ledger: led, estimate: 9 } }));
  ok(reserveBudget({ ledgerFile: led, capUsd: 30, estimateUsd: 9, dispatchId: 'd-w' }).allowed);
  eq(spentToday(led), 9);
  const rcOk = cancelDispatch({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 9, dispatchId: 'd-w' });
  ok(rcOk.ok);
  eq(spentToday(led), 0, '成功 cancel 后旧 reserve 归零');
  eq(readJson(stF).pending_dispatch, null);
});

t('[审⑨P2-2] push 挂死有界超时 + 引擎单 PR 锁死不阻断整轮', () => {
  // A. 永不返回的 push: PATH 注入假 git（push 睡死，其余转发真 git）→ finalize 有限时间非零、
  //    state 锁可重新获取、intent receipt 留盘可恢复
  const d9 = mkdtempSync(join(tmpdir(), 'pt9-'));
  const fakeBin = join(d9, 'bin'); mkdirSync(fakeBin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // push 睡死时把 sleep 的 stdio 全接 /dev/null——防孤儿进程占住继承的 pipe 让外层 execFileSync 假挂
  writeFileSync(join(fakeBin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "push" ]; then sleep 300 </dev/null >/dev/null 2>&1; fi; done\nexec "${realGit}" "$@"\n`);
  execFileSync('chmod', ['+x', join(fakeBin, 'git')]);
  const stDir = join(d9, 'state'); mkdirSync(stDir);
  const m9 = { owner: 'o', repo: 'r', pr_number: 4, branch: 'feat', original_head: HEAD, dispatch_id: 'd-p', remote: 'origin' };
  const mf9 = join(d9, 'm.json'); writeFileSync(mf9, JSON.stringify(m9));
  writeFileSync(join(stDir, stateFileName('o', 'r', 4)), JSON.stringify({ schema_version: 'v2', owner: 'o', repo: 'r', pr_number: 4, branch: 'feat', push_remote: 'origin', pending_dispatch: { dispatch_id: 'd-p', dispatched_at: new Date().toISOString(), manifest: {}, budget: { ledger: join(d9, 'l.jsonl'), estimate: 1 } }, cursors: null, status: 'fixing' }));
  const snap9 = join(d9, 'snap.sh');
  writeFileSync(snap9, `#!/bin/sh\necho '{"state":"open","head_sha":"${HEAD}","comments":[]}'\n`);
  execFileSync('chmod', ['+x', snap9]);
  const t0 = Date.now();
  let failed = false;
  try {
    execFileSync(process.execPath, [join(S, 'pr-watch/finalize.mjs'), '--repo-dir', repo, '--manifest', mf9, '--snapshot-cmd', snap9, '--state-dir', stDir], {
      encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PR_AUTOPILOT_PUSH_TIMEOUT_MS: '1500' }
    });
  } catch { failed = true; }
  const elapsed = Date.now() - t0;
  ok(failed, 'push 挂死必须非零退出');
  ok(elapsed < 30_000, `必须有界（实测 ${elapsed}ms，push 超时 1.5s）`);
  const rp9 = receiptPath(stDir, m9);
  ok(existsSync(rp9) && readJson(rp9).phase === 'intent', 'intent receipt 留盘（恢复分支可用）');
  const rel9 = acquireLock(join(stDir, `${stateFileName('o', 'r', 4)}.lock`), { timeoutMs: 3000 });
  rel9(); // state 锁必须已被 withLock finally 释放
  // B. 引擎: 一个 PR 的锁被活进程占住 → 该 PR 记 pr-scan-error 跳过，其余 PR 照常派发
  const dE = mkdtempSync(join(tmpdir(), 'el9-'));
  const stE = join(dE, 'state'); mkdirSync(stE);
  const snapE = join(dE, 'snap.json'); writeFileSync(snapE, JSON.stringify({ ...snapBase, comments: [{ id: 'ke', body: '修' }] }));
  writeFileSync(join(dE, 'snap.sh'), `#!/bin/sh\ncat "${snapE}"\n`);
  writeFileSync(join(dE, 'nul.sh'), '#!/bin/sh\ncat > /dev/null\n');
  for (const f of ['snap.sh', 'nul.sh']) execFileSync('chmod', ['+x', join(dE, f)]);
  registerPr({ stateDir: stE, owner: 'o', repo: 'mivo-canvas', prNumber: 21, branch: 'a', pushRemote: 'origin' });
  registerPr({ stateDir: stE, owner: 'o', repo: 'mivo-canvas', prNumber: 22, branch: 'b', pushRemote: 'origin' });
  const lockHold = join(stE, `${stateFileName('o', 'mivo-canvas', 21)}.lock`);
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `import('${join(S, 'lib/state-lock.mjs')}').then(m => { m.acquireLock(process.argv[1], { timeoutMs: 5000 }); console.log('held'); setTimeout(() => process.exit(0), 4000); })`,
    lockHold], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => {
    holder.stdout.on('data', () => { // 等锁真正被占住
      try {
        const rE = runEngine({
          stateDir: stE, leaseFile: join(dE, 'lease.json'),
          snapshotCmd: join(dE, 'snap.sh') + ' {owner} {repo} {pr}', dispatchCmd: join(dE, 'nul.sh'),
          journalFile: join(dE, 'journal.jsonl'), hmacKey: HMAC_KEY,
          budget: { ledger: join(dE, 'b.jsonl'), cap: 100, estimate: 1 }, repoDirs: {}, lockTimeoutMs: 400
        });
        ok(rE.dispatched.some((x) => x.pr === 'o/mivo-canvas#22'), '未锁 PR 必须照常派发');
        ok(!rE.dispatched.some((x) => x.pr === 'o/mivo-canvas#21'), '被锁 PR 本轮跳过');
        ok(readFileSync(join(dE, 'journal.jsonl'), 'utf8').includes('pr-scan-error'), '被锁 PR 必须留痕');
        holder.kill('SIGKILL');
        res();
      } catch (e) { holder.kill('SIGKILL'); rej(e); }
    });
  });
});

// ========== 13. 审⑩ delta 验收 ==========
console.log('\n[13] 审⑩: P2-1 终态前预算结算 / P2-2 timeout 硬边界');

t('[审⑩P2-1] PR 转终态时先结算 pending 预留: canceling 不再死等、销单前对账、release 失败不销单', () => {
  const dA = mkdtempSync(join(tmpdir(), 'tm10-'));
  const stDir = join(dA, 'state'); mkdirSync(stDir);
  const ledDir = join(dA, 'ledgers'); mkdirSync(ledDir);
  const led = join(ledDir, 'cost.jsonl');
  const snapJson = join(dA, 'snap.json');
  writeFileSync(join(dA, 'snap.sh'), `#!/bin/sh\ncat "${snapJson}"\n`);
  writeFileSync(join(dA, 'nul.sh'), '#!/bin/sh\ncat > /dev/null\n');
  for (const f of ['snap.sh', 'nul.sh']) execFileSync('chmod', ['+x', join(dA, f)]);
  const jf = join(dA, 'journal.jsonl');
  const ENGA = (over = {}) => ({
    stateDir: stDir, leaseFile: join(dA, 'lease.json'),
    snapshotCmd: join(dA, 'snap.sh') + ' {owner} {repo} {pr}',
    dispatchCmd: join(dA, 'nul.sh'), journalFile: jf, hmacKey: HMAC_KEY,
    budget: { ledger: join(dA, 'eng-b.jsonl'), cap: 10000, estimate: 1 }, repoDirs: {}, ...over
  });
  const stF = join(stDir, stateFileName('o', 'mivo-canvas', 30));
  const writeCanceling = (id) => writeFileSync(stF, JSON.stringify({
    schema_version: 'v2', owner: 'o', repo: 'mivo-canvas', pr_number: 30, branch: 'b', push_remote: 'origin',
    pending_dispatch: { dispatch_id: id, dispatched_at: new Date().toISOString(), manifest: {}, canceling: true, budget: { ledger: led, estimate: 9 } },
    cursors: null, status: 'fixing'
  }));
  // ① canceling + reserve + closed + 无 repoDir: 预算先收敛（spent→0），随后 cleanup-pending 但账已平
  writeCanceling('d-t1');
  ok(reserveBudget({ ledgerFile: led, capUsd: 30, estimateUsd: 9, dispatchId: 'd-t1' }).allowed);
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, state: 'closed' }));
  runEngine(ENGA());
  eq(spentToday(led), 0, '终态分支必须先结算 canceling 的预留');
  const st1 = readJson(stF);
  eq(st1.pending_dispatch, null, 'pending 已结算清空');
  eq(st1.status, 'cleanup-pending', 'repoDir 缺失仍 fail-closed 不销单（但账已平）');
  ok(readFileSync(jf, 'utf8').includes('terminal-pending-settled'));
  runEngine(ENGA());
  eq(spentToday(led), 0, '二轮不重复结算/不产负账');
  execFileSync('rm', [stF]);
  // ② release 注入失败: state/canceling/账本全原样，不 cleanup 不销单
  writeCanceling('d-t2');
  ok(reserveBudget({ ledgerFile: led, capUsd: 30, estimateUsd: 9, dispatchId: 'd-t2' }).allowed);
  execFileSync('chmod', ['555', ledDir]);
  runEngine(ENGA());
  execFileSync('chmod', ['755', ledDir]);
  const st2 = readJson(stF);
  ok(st2.pending_dispatch?.canceling === true, 'release 失败必须保留 canceling state');
  ok(st2.status !== 'cleanup-pending', '未对账不得进入清理链');
  eq(spentToday(led), 9, '预留原样');
  ok(readFileSync(jf, 'utf8').includes('terminal-budget-release-failed'));
  // ③ 账本恢复 + repoDir 配齐: 结算成功 → 真销单，state 删除且 spent=0
  const bizA = mkdtempSync(join(tmpdir(), 'bizA-'));
  {
    const g = (...a) => execFileSync('git', ['-C', bizA, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 'x@t'); g('config', 'user.name', 'x');
    writeFileSync(join(bizA, 'f.txt'), '1'); g('add', '.'); g('commit', '-qm', 'i');
  }
  runEngine(ENGA({ repoDirs: { 'o/mivo-canvas': bizA } }));
  ok(!existsSync(stF), '对账成功后才允许销单');
  eq(spentToday(led), 0);
  // ④ 普通（非 canceling）pending 转 merged: 同样先结算再销单
  writeFileSync(stF, JSON.stringify({
    schema_version: 'v2', owner: 'o', repo: 'mivo-canvas', pr_number: 30, branch: 'b', push_remote: 'origin',
    pending_dispatch: { dispatch_id: 'd-t3', dispatched_at: new Date().toISOString(), manifest: {}, budget: { ledger: led, estimate: 9 } },
    cursors: null, status: 'fixing'
  }));
  ok(reserveBudget({ ledgerFile: led, capUsd: 30, estimateUsd: 9, dispatchId: 'd-t3' }).allowed);
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, state: 'merged' }));
  runEngine(ENGA({ repoDirs: { 'o/mivo-canvas': bizA } }));
  ok(!existsSync(stF));
  eq(spentToday(led), 0, '普通 pending 终态同样机械结算');
});

t('[审⑩P2-2] timeout 硬边界: push env 0/空/NaN/负/超大全拒且零副作用；engine lockTimeoutMs 非法拒启动', () => {
  // finalize: 非法 env 在读 manifest/取快照/push 之前直接非零
  const dB = mkdtempSync(join(tmpdir(), 'to10-'));
  const mfB = join(dB, 'm.json'); writeFileSync(mfB, JSON.stringify({ owner: 'o', repo: 'r', pr_number: 1 }));
  const probe = join(dB, 'probe.log');
  const snapB = join(dB, 'snap.sh');
  writeFileSync(snapB, `#!/bin/sh\necho hit >> "${probe}"\necho '{}'\n`);
  execFileSync('chmod', ['+x', snapB]);
  for (const bad of ['0', '', 'abc', '-5', '999999999', '1.5']) {
    let failedB = false, errB = '';
    try {
      execFileSync(process.execPath, [join(S, 'pr-watch/finalize.mjs'), '--repo-dir', repo, '--manifest', mfB, '--snapshot-cmd', snapB, '--state-dir', dB], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PR_AUTOPILOT_PUSH_TIMEOUT_MS: bad }
      });
    } catch (e) { failedB = true; errB = `${e.stderr ?? ''}`; }
    ok(failedB && /PUSH_TIMEOUT_MS 非法/.test(errB), `env="${bad}" 必须 fail-closed: ${errB.slice(0, 120)}`);
  }
  ok(!existsSync(probe), '非法 timeout 下不得执行任何外部命令（快照都不取）');
  // engine: lockTimeoutMs 非法 → 启动拒绝，不扫描
  for (const badL of [0, 99, 10_001, NaN, 1e9, '400']) {
    let threwL = false;
    try { runEngine(ENG({ budget: BUDGET(), lockTimeoutMs: badL })); }
    catch (e) { threwL = /lockTimeoutMs 非法/.test(e.message); }
    ok(threwL, `lockTimeoutMs=${String(badL)} 必须拒启动`);
  }
  // 合法边界值照常工作
  const rOk = runEngine(ENG({ budget: BUDGET(), lockTimeoutMs: 100 }));
  ok(rOk.scanned >= 0);
});

// ========== 14. 审⑪ delta 验收 ==========
console.log('\n[14] 审⑪: 终态放弃 pending 轮换 generation + 注册 epoch 跨销单不复用 id');

t('[审⑪P1] closed→cleanup-pending→reopen 与销单→重注册两条路径都不得复用旧 dispatch id', () => {
  const dC = mkdtempSync(join(tmpdir(), 'ep11-'));
  const stDir = join(dC, 'state'); mkdirSync(stDir);
  const snapJson = join(dC, 'snap.json');
  writeFileSync(join(dC, 'snap.sh'), `#!/bin/sh\ncat "${snapJson}"\n`);
  writeFileSync(join(dC, 'nul.sh'), '#!/bin/sh\ncat > /dev/null\n');
  for (const f of ['snap.sh', 'nul.sh']) execFileSync('chmod', ['+x', join(dC, f)]);
  const bizC = mkdtempSync(join(tmpdir(), 'bizC-'));
  {
    const g = (...a) => execFileSync('git', ['-C', bizC, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 'x@t'); g('config', 'user.name', 'x');
    writeFileSync(join(bizC, 'f.txt'), '1'); g('add', '.'); g('commit', '-qm', 'i');
  }
  const ENGC = (over = {}) => ({
    stateDir: stDir, leaseFile: join(dC, 'lease.json'),
    snapshotCmd: join(dC, 'snap.sh') + ' {owner} {repo} {pr}',
    dispatchCmd: join(dC, 'nul.sh'), journalFile: join(dC, 'journal.jsonl'), hmacKey: HMAC_KEY,
    budget: { ledger: join(dC, 'b.jsonl'), cap: 10000, estimate: 1 },
    repoDirs: { 'o/mivo-canvas': bizC }, ...over
  });
  const stF = join(stDir, stateFileName('o', 'mivo-canvas', 71));
  const openSnap = { ...snapBase, comments: [{ id: 'c71', body: '修一下' }] };
  // A. canceling pending → closed（repoDir 缺失走 cleanup-pending）→ reopen: 新 id ≠ 旧 id，旧回执全拒
  registerPr({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 71, branch: 'f71', pushRemote: 'origin' });
  const epoch1 = readJson(stF).registration_epoch;
  ok(epoch1 && epoch1.length === 16, '注册必须持久化 registration_epoch');
  writeFileSync(snapJson, JSON.stringify(openSnap));
  runEngine(ENGC());
  const id1 = readJson(stF).pending_dispatch.dispatch_id;
  // 模拟 cancel Phase B 崩溃后的 canceling 残留
  const stMid = readJson(stF);
  stMid.pending_dispatch.canceling = true;
  writeFileSync(stF, JSON.stringify(stMid));
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, state: 'closed' }));
  runEngine(ENGC({ repoDirs: {} })); // 无 repoDir → 结算 + cleanup-pending
  const stTerm = readJson(stF);
  eq(stTerm.status, 'cleanup-pending');
  eq(stTerm.dispatch_generation, 1, '终态放弃 pending 必须同笔原子写轮换 generation');
  // reopen: 同 head 同反馈（游标未消费）→ 必须是新 id
  writeFileSync(snapJson, JSON.stringify(openSnap));
  const rRe = runEngine(ENGC());
  const id2 = readJson(stF).pending_dispatch.dispatch_id;
  ok(rRe.dispatched.length === 1 && id2 !== id1, `reopen 重派必须新 id（old=${id1} new=${id2}）`);
  ok(!ackDispatch({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 71, dispatchId: id1 }).ok, '旧取消会话的迟到 ack 必拒');
  ok(readJson(stF).pending_dispatch.dispatch_id === id2, '新 pending 不受旧 ack 影响');
  // B. 普通（非 canceling）pending 同样轮换: 先收口 A 的 id2 再造
  ackDispatch({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 71, dispatchId: id2 });
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, comments: [{ id: 'c71', body: '修一下' }, { id: 'c72', body: '再修' }] }));
  runEngine(ENGC());
  const id3 = readJson(stF).pending_dispatch.dispatch_id;
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, state: 'closed' }));
  runEngine(ENGC({ repoDirs: {} }));
  eq(readJson(stF).dispatch_generation, 2, '普通 pending 终态放弃同样轮换');
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, comments: [{ id: 'c71', body: '修一下' }, { id: 'c72', body: '再修' }] }));
  runEngine(ENGC());
  ok(readJson(stF).pending_dispatch.dispatch_id !== id3, '普通 pending 复活重派也必须新 id');
  // C. 终态销单成功 → reopen → 重新注册: 新 epoch 新 id 空间，旧 receipt 不可用于收口
  const idPre = readJson(stF).pending_dispatch.dispatch_id;
  const preManifest = readJson(stF).pending_dispatch.manifest;
  writeFileSync(receiptPath(stDir, preManifest), JSON.stringify({ dispatch_id: idPre, original_head: SHA_A, candidate: 'f'.repeat(40), remote: 'origin', branch: 'f71', phase: 'committed', at: new Date().toISOString() }));
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, state: 'merged' }));
  runEngine(ENGC()); // repoDir 配齐 → 结算 + 销单
  ok(!existsSync(stF), '销单完成');
  writeFileSync(snapJson, JSON.stringify(openSnap));
  registerPr({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 71, branch: 'f71', pushRemote: 'origin' });
  const epoch2 = readJson(stF).registration_epoch;
  ok(epoch2 && epoch2 !== epoch1, '重注册必须是新 epoch');
  runEngine(ENGC());
  const idNew = readJson(stF).pending_dispatch.dispatch_id;
  ok(idNew !== id1 && idNew !== idPre, `跨销单不复用任何旧 id（new=${idNew}）`);
  // 旧 receipt（idPre）对新 pending 无效: complete 的 ack 会因 id 不匹配拒
  ok(!ackDispatch({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 71, dispatchId: idPre }).ok, '旧 receipt 的 id 不得收口新 pending');
});

// ========== 15. P0-⑦ 队列握手 transport 契约 ==========
console.log('\n[15] P0-⑦: queue-transport 班车握手契约');

t('[P0-⑦] queue-transport: 落任务→收回执→清理；超时拒；坏标头拒；坏 env 拒', () => {
  const dQ = mkdtempSync(join(tmpdir(), 'qt-'));
  const qDir = join(dQ, 'queue');
  const QT = join(W, 'queue-transport.mjs');
  const dispatchText = (id) => `【pr-autopilot 修复任务 ${id}】o/r#1 有新反馈: comment\n\n硬规则...\nOWNER_STANDING_AUTH: PR_PUSH_AND_REPLY`;
  const goodReceipt = { session_id: 's-9', agentKind: 'claude-code', provider: 'Cindy AI', model: 'z-ai/glm-5.2', effort: 'max' };
  // ① 正常握手: 后台起 transport → 模拟班车写 receipt → transport 输出回执并清理
  const idA = 'a'.repeat(16);
  const pA = new Promise((res, rej) => {
    const p = spawn(process.execPath, [QT], { env: { ...process.env, PR_AUTOPILOT_QUEUE_DIR: qDir, PR_AUTOPILOT_QUEUE_TIMEOUT_MS: '10000' }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', (c) => c === 0 ? res(out) : rej(new Error(`transport exit ${c}`)));
    p.stdin.end(dispatchText(idA));
    const poll = setInterval(() => {
      if (existsSync(join(qDir, `${idA}.task.txt`))) {
        clearInterval(poll);
        ok(readFileSync(join(qDir, `${idA}.task.txt`), 'utf8').includes('OWNER_STANDING_AUTH'), '任务文本必须完整落盘');
        writeFileSync(join(qDir, `${idA}.receipt.json`), JSON.stringify(goodReceipt));
      }
    }, 100);
  }).then((out) => {
    const r = JSON.parse(out.trim());
    eq(r.session_id, 's-9');
    eq(r.model, 'z-ai/glm-5.2', '回执四元组原样转交（校验在 cindy-dispatch）');
    ok(!existsSync(join(qDir, `${idA}.task.txt`)) && !existsSync(join(qDir, `${idA}.receipt.json`)), '握手完成必须清理队列');
  });
  // ② 超时: 无班车 → 非零退出且任务文件被清（防晚到班车重复投递）
  const idB = 'b'.repeat(16);
  const pB = new Promise((res, rej) => {
    const p = spawn(process.execPath, [QT], { env: { ...process.env, PR_AUTOPILOT_QUEUE_DIR: qDir, PR_AUTOPILOT_QUEUE_TIMEOUT_MS: '5000' }, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('exit', (c) => {
      try {
        ok(c !== 0, '无回执必须非零');
        ok(!existsSync(join(qDir, `${idB}.task.txt`)), '超时必须清任务文件');
        res();
      } catch (e) { rej(e); }
    });
    p.stdin.end(dispatchText(idB));
  });
  // ③ 坏标头 / 坏 env: 立即拒
  for (const [badIn, badEnv, why] of [
    ['没有标头的文本', {}, '缺 dispatch_id 标头'],
    [dispatchText('c'.repeat(16)), { PR_AUTOPILOT_QUEUE_TIMEOUT_MS: '0' }, 'timeout=0'],
    [dispatchText('d'.repeat(16)), { PR_AUTOPILOT_QUEUE_TIMEOUT_MS: '999999999' }, 'timeout 超大']
  ]) {
    let failedQ = false;
    try { execFileSync(process.execPath, [QT], { input: badIn, env: { ...process.env, PR_AUTOPILOT_QUEUE_DIR: qDir, ...badEnv }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { failedQ = true; }
    ok(failedQ, `必须拒: ${why}`);
  }
  return Promise.all([pA, pB]);
});

t('[P0-⑦] probe 探针: 无活 SKIP / 新信号·租约过期·canceling·终态·滞留队列 RUN；文法过滤同引擎', async () => {
  const { probe } = await import('../deploy/wrappers/probe.mjs');
  const dP = mkdtempSync(join(tmpdir(), 'pb-'));
  const stDir = join(dP, 'state'); mkdirSync(stDir);
  const qDir = join(dP, 'queue'); mkdirSync(qDir);
  const snapJson = join(dP, 'snap.json');
  writeFileSync(join(dP, 'snap.sh'), `#!/bin/sh\ncat "${snapJson}"\n`);
  execFileSync('chmod', ['+x', join(dP, 'snap.sh')]);
  const snapCmd = join(dP, 'snap.sh') + ' {owner} {repo} {pr}';
  const P9 = (over = {}) => probe({ stateDir: stDir, queueDir: qDir, snapshotCmd: snapCmd, hmacKey: HMAC_KEY, ...over });
  eq(P9().work, false, '无在册 PR → SKIP');
  registerPr({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 5, branch: 'f', pushRemote: 'origin' });
  writeFileSync(snapJson, JSON.stringify(snapBase));
  eq(P9().work, false, '在册但无信号 → SKIP（零 token 轮）');
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, comments: [{ id: 'p1', body: '修' }] }));
  ok(P9().work, '新评论信号 → RUN');
  // pending 未过期 → 无动作；过期 → RUN；canceling → RUN
  const stF = join(stDir, stateFileName('o', 'mivo-canvas', 5));
  const base = readJson(stF);
  writeFileSync(stF, JSON.stringify({ ...base, pending_dispatch: { dispatch_id: 'd', dispatched_at: new Date().toISOString(), manifest: {} } }));
  eq(P9().work, false, '在途未过期 → SKIP');
  writeFileSync(stF, JSON.stringify({ ...base, pending_dispatch: { dispatch_id: 'd', dispatched_at: new Date(Date.now() - 60 * 60000).toISOString(), manifest: {} } }));
  ok(P9().work, '租约过期 → RUN');
  writeFileSync(stF, JSON.stringify({ ...base, pending_dispatch: { dispatch_id: 'd', dispatched_at: new Date().toISOString(), manifest: {}, canceling: true } }));
  ok(P9().work, 'canceling → RUN（待引擎收敛）');
  writeFileSync(stF, JSON.stringify(base));
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, state: 'merged' }));
  ok(P9().work, '终态 → RUN（结算/清理）');
  // 队列滞留任务 → RUN（与 PR 状态无关）
  writeFileSync(snapJson, JSON.stringify(snapBase));
  writeFileSync(join(qDir, 'x.task.txt'), 'x');
  ok(P9().work, '队列滞留 → RUN');
  execFileSync('rm', [join(qDir, 'x.task.txt')]);
  // 杂质文件不触发
  writeFileSync(join(stDir, 'garbage__5.json'), '{}');
  eq(P9().work, false, '杂质文件不得放行班车');
});

// ========== 16. merged 远端分支清理（owner 2026-08-01 点单） ==========
console.log('\n[16] branch-cleanup: merged 远端分支清理硬门');

t('[branch-cleanup] 保护分支/野 remote/无锚点/头漂移全拒；already-gone 幂等；正例 argv 钉死', async () => {
  const { cleanupRemoteBranch } = await import('../scripts/pr-watch/branch-cleanup.mjs');
  const SHA = 'a'.repeat(40);
  const calls = [];
  const mkExec = (lsOut) => (argv) => {
    calls.push(argv.join(' '));
    if (argv.includes('ls-remote')) return lsOut;
    return '';
  };
  const base9 = { repoDir: repo, remote: 'origin', branch: 'feat', repoFullName: 'o/r', expectedHeadSha: SHA };
  // ① 保护分支硬名单（任何配置不可放开）
  for (const b of ['main', 'master', 'develop', 'release/1.0', 'deploy/green']) {
    const r = cleanupRemoteBranch({ ...base9, branch: b, exec: mkExec('') });
    ok(!r.deleted && r.skipped && /保护分支/.test(r.reason), `保护分支必须拒: ${b}`);
  }
  // ② 野 remote（evilhost 在 repo 里配置的 URL 非 github/o/r）→ validate 拦
  let r = cleanupRemoteBranch({ ...base9, remote: 'evilhost', exec: mkExec('') });
  ok(r.skipped && /校验未过/.test(r.reason), '野 remote 必须拒');
  // ③ 无 PR head 锚点 → 拒
  r = cleanupRemoteBranch({ ...base9, expectedHeadSha: 'HEAD', exec: mkExec('') });
  ok(r.skipped && /锚点/.test(r.reason));
  // ④ 远端头 ≠ 被合并 PR head（merge 后有人推了新提交）→ 拒且绝不执行 push
  calls.length = 0;
  r = cleanupRemoteBranch({ ...base9, exec: mkExec(`${'b'.repeat(40)}\trefs/heads/feat\n`) });
  ok(r.skipped && /新提交/.test(r.reason), '头漂移必须拒');
  ok(!calls.some((c) => c.includes('--delete')), '拒删路径绝不执行 push');
  // ⑤ already-gone（GitHub auto-delete 已删）→ 幂等跳过
  r = cleanupRemoteBranch({ ...base9, exec: mkExec('') });
  ok(r.skipped && r.alreadyGone === true);
  // ⑥ 正例: ls-remote 头等于 PR head → 删除，argv 固定普通 delete refspec
  calls.length = 0;
  r = cleanupRemoteBranch({ ...base9, exec: mkExec(`${SHA}\trefs/heads/feat\n`) });
  ok(r.deleted === true, r.reason);
  eq(r.argv, ['git', '-C', repo, 'push', 'origin', '--delete', 'feat'], '删除 argv 必须钉死');
  // ⑦ push 失败 → 异常上抛（由引擎 journal，不静默）
  let threw9 = false;
  try {
    cleanupRemoteBranch({ ...base9, exec: (argv) => { if (argv.includes('--delete')) throw new Error('remote rejected'); return `${SHA}\trefs/heads/feat\n`; } });
  } catch (e) { threw9 = /remote rejected/.test(e.message); }
  ok(threw9);
});

t('[branch-cleanup] 引擎接线: 默认关闭零行为；开启后 merged 才触发、失败留痕不阻塞销单', () => {
  const dD = mkdtempSync(join(tmpdir(), 'bc16-'));
  const stDir = join(dD, 'state'); mkdirSync(stDir);
  const snapJson = join(dD, 'snap.json');
  writeFileSync(join(dD, 'snap.sh'), `#!/bin/sh\ncat "${snapJson}"\n`);
  writeFileSync(join(dD, 'nul.sh'), '#!/bin/sh\ncat > /dev/null\n');
  for (const f of ['snap.sh', 'nul.sh']) execFileSync('chmod', ['+x', join(dD, f)]);
  const bizD = mkdtempSync(join(tmpdir(), 'bizD-'));
  {
    const g = (...a) => execFileSync('git', ['-C', bizD, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 'x@t'); g('config', 'user.name', 'x');
    writeFileSync(join(bizD, 'f.txt'), '1'); g('add', '.'); g('commit', '-qm', 'i');
    g('remote', 'add', 'origin', join(dD, 'not-github.git')); // 本地路径 URL → validate 必拦（fail-closed 展示面）
  }
  const jf = join(dD, 'journal.jsonl');
  const ENGD = (over = {}) => ({
    stateDir: stDir, leaseFile: join(dD, 'lease.json'),
    snapshotCmd: join(dD, 'snap.sh') + ' {owner} {repo} {pr}', dispatchCmd: join(dD, 'nul.sh'),
    journalFile: jf, hmacKey: HMAC_KEY,
    budget: { ledger: join(dD, 'b.jsonl'), cap: 100, estimate: 1 },
    repoDirs: { 'o/mivo-canvas': bizD }, ...over
  });
  // 默认关闭: merged 销单，无 branch-cleanup 痕迹
  registerPr({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 81, branch: 'f81', pushRemote: 'origin' });
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, state: 'merged' }));
  runEngine(ENGD());
  ok(!existsSync(join(stDir, stateFileName('o', 'mivo-canvas', 81))), '销单正常');
  ok(!readFileSync(jf, 'utf8').includes('branch-cleanup'), '默认 off 零行为');
  // 开启: merged → 尝试清理（本例被 URL 校验拦下 = skipped 留痕），销单不受阻
  registerPr({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 82, branch: 'f82', pushRemote: 'origin' });
  runEngine(ENGD({ deleteRemoteBranchOnMerge: true }));
  ok(!existsSync(join(stDir, stateFileName('o', 'mivo-canvas', 82))), '清理被拦不得阻塞销单');
  const jTxt = readFileSync(jf, 'utf8');
  ok(jTxt.includes('"kind":"branch-cleanup"') && /校验未过/.test(jTxt), '开启后必须留痕（本例 fail-closed 拦下）');
  // closed（未合并）: 开启也绝不触发清理
  registerPr({ stateDir: stDir, owner: 'o', repo: 'mivo-canvas', prNumber: 83, branch: 'f83', pushRemote: 'origin' });
  writeFileSync(snapJson, JSON.stringify({ ...snapBase, state: 'closed' }));
  runEngine(ENGD({ deleteRemoteBranchOnMerge: true }));
  ok(!existsSync(join(stDir, stateFileName('o', 'mivo-canvas', 83))));
  const after83 = readFileSync(jf, 'utf8').split('\n').filter((l) => l.includes('#83'));
  ok(!after83.some((l) => l.includes('branch-cleanup')), 'closed 未合并绝不碰分支');
});

// ========== 17. 修复编排门禁 v2（并行/串行机器裁决） ==========
console.log('\n[17] 修复编排 v2: anchor_paths 校验 / SC coverage / fix-plan 分组波次');

t('[v2-anchor] normalizeRepoPath: 精确文件收，绝对/../反斜杠/尾斜杠/空/NUL 拒', () => {
  ok(normalizeRepoPath('src/store/documentSlice.ts').ok);
  ok(normalizeRepoPath('a').ok, '单段文件名合法');
  for (const bad of ['/abs/x', './x', '../x', 'a/../b', 'a\\b', 'dir/', '', 'a/\0/b', 'a//b']) {
    ok(!normalizeRepoPath(bad).ok, `必须拒: ${JSON.stringify(bad)}`);
  }
});

t('[v2-anchor] verdict-validate: anchor_paths 缺失/含目录/绝对 → degraded', () => {
  const bad1 = mkVerdictFor('claude-adversarial', bundle, { findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: [], evidence: 'e', status: 'closed' }], closed_finding_ids: ['F1'] });
  ok(validateVerdict(bad1).some((e) => /anchor_paths/.test(e)), '空 anchor_paths 必 degraded');
  const bad2 = mkVerdictFor('claude-adversarial', bundle, { findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: ['src/x/'], evidence: 'e', status: 'closed' }], closed_finding_ids: ['F1'] });
  ok(validateVerdict(bad2).some((e) => /anchor_paths/.test(e)), '目录路径必 degraded');
  const good = mkVerdictFor('claude-adversarial', bundle, { findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: ['src/x.ts'], evidence: 'e', status: 'closed' }], closed_finding_ids: ['F1'] });
  eq(validateVerdict(good).length, 0, '精确路径应过');
});

t('[anchor_paths 拆分/D2] verdict 的 finding 携带 write_paths/allowed_paths → 必拒（写入许可不受理外部输入）', () => {
  const withWrite = mkVerdictFor('claude-adversarial', bundle, { findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: ['src/x.ts'], write_paths: ['src/x.ts'], evidence: 'e', status: 'closed' }], closed_finding_ids: ['F1'] });
  ok(validateVerdict(withWrite).some((e) => /write_paths/.test(e)), 'finding 带 write_paths 必须被拒（D2）');
  const withAllowed = mkVerdictFor('claude-adversarial', bundle, { findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: ['src/x.ts'], allowed_paths: ['src/x.ts'], evidence: 'e', status: 'closed' }], closed_finding_ids: ['F1'] });
  ok(validateVerdict(withAllowed).some((e) => /allowed_paths/.test(e)), 'finding 带 allowed_paths 必须被拒（D2）');
});

// 造一个带 N 条 canonical finding 的真共识 artifact（各 finding 指定 anchor_paths）
function artifactWithFindings(specs, bundleObj = bundle, gateOpts = {}) {
  // specs: [{fid_face, sev, paths, invariant?, family_id?, evidence?}] —— 三席都 close 同一批以达共识。
  // 每条 anchor + evidence 唯一（防 canonical dedup 合并），便于按 anchor 反查 canonical id。
  // SC-B1: actionable（blocker/major）finding 默认各自「自成一族」（invariant/family_id 按
  // 下标各不相同）；测试跨 finding 共享 family 时通过 spec.family_id/spec.invariant 显式指定。
  // D1: family_id 只是这里模拟的 verdict 层本地标签（保持不变）——真正的跨 finding 分组身份
  // 是 consensus-gate 从 invariant 派生的 family_key；两条 spec 若给了相同 invariant，即便
  // family_id 标签不同，下游也会被正确判定为同一 family（这正是本次数据契约要保证的性质）。
  const findings = specs.map((s, i) => ({
    id: `f${i}`, primary_face: s.face ?? 'A', severity: s.sev, anchor: `${s.paths.join('|')}#${i}`, anchor_paths: s.paths, evidence: s.evidence ?? `ev-${i}-${s.paths.join(',')}`, status: 'closed',
    ...(['blocker', 'major'].includes(s.sev) ? { invariant: s.invariant ?? `inv-f${i}`, family_id: s.family_id ?? `fam-f${i}` } : {})
  }));
  const ids = findings.map((f) => f.id);
  const art = consensusFor(bundleObj, [
    { findings, closed_finding_ids: ids },
    { findings, closed_finding_ids: ids },
    { findings: [], closed_finding_ids: [] } // 第三席无独立 finding
  ], gateOpts).artifact;
  ok(art.gate_result === 'pass', 'artifact 应达共识: ' + JSON.stringify(art.fail_reasons ?? []));
  return art;
}

// SC-B1/D1: 测试懒惰路径——对 fix/verify/archive SC 自动补 invariant/family_key（从其引用的
// canonical finding 逐字复制，只在引用 finding 存在且 actionable 时补）。绑定字段是
// family_key（内容派生），不是 family_id（reviewer 席内本地标签）。显式已提供该字段的
// SC 不覆盖（用于测试「字段错配/归因漂移」「缺归因」等场景）。global SC / 多 finding_ids 的
// SC 不处理（SC-4 会先拒多引用，不需要本函数介入）。
function withScAttribution(scs, artifact) {
  const byId = new Map((artifact.canonical_findings ?? []).map((f) => [f.id, f]));
  return scs.map((sc) => {
    if (sc.kind === 'global') return sc;
    const fids = Array.isArray(sc.finding_ids) ? sc.finding_ids : [];
    if (fids.length !== 1) return sc;
    const cf = byId.get(fids[0]);
    if (!cf || (cf.severity !== 'blocker' && cf.severity !== 'major')) return sc;
    if ('invariant' in sc || 'family_key' in sc) return sc;
    return { ...sc, invariant: cf.invariant, family_key: cf.family_key };
  });
}

t('[v2-coverage] SC 必须覆盖每条 blocker/major finding，绑定 artifact hash，拒悬空/漏项', () => {
  const art = artifactWithFindings([
    { sev: 'blocker', paths: ['server/lib/assetStore.ts'] },
    { sev: 'major', paths: ['src/store/documentSlice.ts'] },
    { sev: 'suggestion', paths: ['docs/x.md'] }
  ]);
  const ids = art.canonical_findings.map((f) => f.id);
  const blockerMajor = art.canonical_findings.filter((f) => f.severity !== 'suggestion').map((f) => f.id);
  const mk = (scs) => ({ schema_version: 'v1', consensus_artifact_hash: art.consensus_artifact_hash, scs: withScAttribution(scs, art) });
  // 全覆盖 → ok
  const full = mk(blockerMajor.map((fid, i) => ({ id: `SC-${i}`, kind: 'fix', finding_ids: [fid], change: 'c', holds: 'h', verify: VF() })));
  eq(checkScCoverage({ manifest: full, artifact: art }).length, 0, '全覆盖应过');
  // 漏一条 major → fail
  const miss = mk([{ id: 'SC-0', kind: 'fix', finding_ids: [blockerMajor[0]], change: 'c', holds: 'h', verify: VF() }]);
  ok(checkScCoverage({ manifest: miss, artifact: art }).some((e) => /未被任何 SC 覆盖/.test(e)), '漏 major 必拒');
  // 悬空引用 → fail
  const dangling = mk([...full.scs, { id: 'SC-x', kind: 'fix', finding_ids: ['nonexistent'], change: 'c', holds: 'h', verify: VF() }]);
  ok(checkScCoverage({ manifest: dangling, artifact: art }).some((e) => /悬空/.test(e)), '悬空 finding_id 必拒');
  // 换 artifact hash（假绑定）→ fail
  const forged = mk(full.scs); forged.consensus_artifact_hash = 'f'.repeat(64);
  ok(checkScCoverage({ manifest: forged, artifact: art }).some((e) => /未绑定|不符/.test(e)), 'SC 未绑定本次共识必拒');
  // suggestion 不强制覆盖: 仅覆盖 blocker/major 仍过
  eq(checkScCoverage({ manifest: full, artifact: art }).length, 0);
});

t('[anchor_paths 拆分/D2] sc-manifest 的 SC 携带 write_paths/allowed_paths → 必拒', () => {
  const art = artifactWithFindings([{ sev: 'major', paths: ['src/y.ts'] }]);
  const fid = art.canonical_findings[0].id;
  const withWrite = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: [{ id: 'SC-0', kind: 'fix', finding_ids: [fid], change: 'c', holds: 'h', verify: VF(), write_paths: ['src/y.ts'] }] };
  ok(checkScCoverage({ manifest: withWrite, artifact: art }).some((e) => /write_paths/.test(e)), 'SC 带 write_paths 必须被拒（D2）');
  const withAllowed = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: [{ id: 'SC-0', kind: 'fix', finding_ids: [fid], change: 'c', holds: 'h', verify: VF(), allowed_paths: ['src/y.ts'] }] };
  ok(checkScCoverage({ manifest: withAllowed, artifact: art }).some((e) => /allowed_paths/.test(e)), 'SC 带 allowed_paths 必须被拒（D2）');
});

t('[v2-plan] fix-plan: 冲突域相交同组、独立域并行、verify 进末波、缺 anchor_paths degraded、hash 可重算', () => {
  const art = artifactWithFindings([
    { sev: 'blocker', paths: ['server/lib/assetStore.ts'] },       // f0 独立
    { sev: 'major', paths: ['src/store/documentSlice.ts'] },        // f1 与 f2 撞
    { sev: 'major', paths: ['src/store/documentSlice.ts', 'src/store/x.ts'] }, // f2
    { sev: 'major', paths: ['src/lib/persistBoot.ts'] }             // f3 独立
  ]);
  const id = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const manifest = {
    schema_version: 'v1', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: [
      { id: 'SC-0', kind: 'fix', finding_ids: [id(0)], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-1', kind: 'fix', finding_ids: [id(1)], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-2', kind: 'fix', finding_ids: [id(2)], change: 'c', holds: 'h', verify: VF() }, // 与 SC-1 撞 documentSlice.ts
      { id: 'SC-3', kind: 'fix', finding_ids: [id(3)], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-V', kind: 'verify', finding_ids: [id(1)], change: 'c', holds: 'h', verify: VF('npm', ['test']), anchor: 't' }
    ]
  };
  // SC-V 的 finding 是 f1（非测试路径）——verify SC 自身路径须像测试，这里 finding 路径不像 → 应 degraded
  let r = buildFixPlan({ artifact: art, manifest });
  ok(r.degraded && r.reasons.some((x) => /verify.*不像测试/.test(x)), 'verify SC 路径不像测试必 degraded');
  // 改: verify SC 引用一个测试路径 finding
  const artT = artifactWithFindings([
    { sev: 'blocker', paths: ['server/lib/assetStore.ts'] },
    { sev: 'major', paths: ['src/store/documentSlice.ts'] },
    { sev: 'major', paths: ['src/store/documentSlice.ts', 'src/store/x.ts'] },
    { sev: 'major', paths: ['src/lib/persistBoot.ts'] },
    { sev: 'major', paths: ['e2e/flow.test.ts'] }  // 测试路径 finding
  ]);
  const idT = (i) => artT.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const m2 = {
    schema_version: 'v1', consensus_artifact_hash: artT.consensus_artifact_hash,
    scs: [
      { id: 'SC-0', kind: 'fix', finding_ids: [idT(0)], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-1', kind: 'fix', finding_ids: [idT(1)], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-2', kind: 'fix', finding_ids: [idT(2)], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-3', kind: 'fix', finding_ids: [idT(3)], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-V', kind: 'verify', finding_ids: [idT(4)], change: 'c', holds: 'h', verify: VF('npm', ['test']) }
    ]
  };
  r = buildFixPlan({ artifact: artT, manifest: m2 });
  ok(!r.degraded, '合法 plan 不应 degraded: ' + JSON.stringify(r.reasons ?? []));
  // SC-1 + SC-2 撞 documentSlice.ts → 同组；SC-0 / SC-3 各独立组 → 三组并行在 wave1
  const fixWave = r.plan.waves[0];
  eq(fixWave.length, 3, 'wave1 三组并行（SC-0 / {SC-1,SC-2} / SC-3）');
  const merged = r.plan.groups.find((g) => g.sc_ids.length === 2);
  eq(merged.sc_ids, ['SC-1', 'SC-2'], '撞同文件的两 SC 必同组串行');
  // verify 进最后一波
  eq(r.plan.waves.length, 2, 'verify 单独末波');
  eq(r.plan.waves[1].length, 1);
  // hash 可重算（纯函数）
  eq(computeFixPlanHash(r.plan), r.plan.fix_plan_hash, 'fix_plan_hash 必须重算等价');
  // 缺 anchor_paths → degraded
  const artBad = JSON.parse(JSON.stringify(artT));
  artBad.canonical_findings[0].anchor_paths = [];
  const rb = buildFixPlan({ artifact: artBad, manifest: m2 });
  ok(rb.degraded, '缺 anchor_paths 必 degraded 不产 plan');
});

// ========== 18. 执行层 + 验证闸（1 号 / 2 号） ==========
console.log('\n[18] 执行层: 组数门 / N-worktree 隔离 / 集成重叠检测 + push-guard 编排链');

const { checkDispatch } = await import('../scripts/fix-dispatch-gate.mjs');
const ORC = await import('../scripts/fix-orchestrate.mjs');
const FR = await import('../scripts/fix-run.mjs');
const TRUSTED_CAP = 8; // config/orchestration.json 的 max_parallel_workers（SC-6 可信来源）
// SC-10: 结构化交卷材料 helper
function mkResult(plan, groupId, over = {}) {
  const g = plan.groups.find((x) => x.id === groupId);
  return {
    status: 'PASS',
    sc_results: (g?.sc_ids ?? []).map((sc) => ({ sc_id: sc, status: 'PASS', evidence: `${sc} 验证通过` })),
    ...over
  };
}

// 复用 §17 的 artifactWithFindings 造 4 组（3 独立 + 1 撞组）
function planFixture() {
  // 源共识 = 修复**前**那轮: base 与终版一致（同一 PR），candidate 是修复前的 SHA
  const srcBundle = mkBundle(BASE, SHA_A);
  const art = artifactWithFindings([
    { sev: 'blocker', paths: ['server/a.ts'] },
    { sev: 'major', paths: ['src/b.ts'] },
    { sev: 'major', paths: ['src/b.ts', 'src/b2.ts'] }, // 与上条撞 → 同组
    { sev: 'major', paths: ['src/c.ts'] }
  ], srcBundle);
  const id = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const manifest = {
    schema_version: 'v1', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: [0, 1, 2, 3].map((i) => ({ id: `SC-${i}`, kind: 'fix', finding_ids: [id(i)], change: 'c', holds: 'h', verify: VF() }))
  };
  const r = buildFixPlan({ artifact: art, manifest });
  ok(!r.degraded, 'plan 不该 degraded: ' + JSON.stringify(r.reasons ?? []));
  return { art, scManifest: manifest, plan: r.plan };
}

t('[1号-组数门] 计划 3 组并行: 只派 1 个 → 拒；派全 → 过；同 worker 兼两组 → 拒；空壳/幽灵/换 plan → 拒', () => {
  const { plan } = planFixture();
  eq(plan.waves.length, 1); eq(plan.waves[0].length, 3, '3 组并行（其中一组含两条撞车 SC）');
  const SHA = (c) => c.repeat(40);
  const mkRec = (dispatches, over = {}) => ({ fix_plan_hash: plan.fix_plan_hash, waves: [{ dispatches }], ...over });
  const full = plan.waves[0].map((g, i) => ({ group_id: g, worker_session_id: `s${i}`, tip: SHA(String(i)), report: `组 ${g} 交卷`, result: mkResult(plan, g) }));
  eq(checkDispatch({ plan, record: mkRec(full) }).length, 0, '全派应过');
  // 首跑那次的失败模式: 只派一个 worker 串行吃完
  const only1 = checkDispatch({ plan, record: mkRec([full[0]]) });
  ok(only1.some((e) => /该并行没并行/.test(e)), '只派 1 个必须被拦（owner 目标核心）');
  // 同一 worker 兼两组冒充并行
  const sameWorker = full.map((d) => ({ ...d, worker_session_id: 'same' }));
  ok(checkDispatch({ plan, record: mkRec(sameWorker) }).some((e) => /冒充并行/.test(e)));
  // 空壳记录（无 tip / 无 report）
  ok(checkDispatch({ plan, record: mkRec(full.map((d) => ({ ...d, tip: undefined }))) }).some((e) => /tip SHA/.test(e)));
  // SC-10: 结构化交卷——FAIL 状态 / 缺结构 / sc 不全 PASS 全拒（旧实现 report='FAIL' 也过）
  ok(checkDispatch({ plan, record: mkRec(full.map((d) => ({ ...d, result: undefined }))) }).some((e) => /缺结构化 result/.test(e)), '缺结构化交卷必拒');
  ok(checkDispatch({ plan, record: mkRec(full.map((d) => ({ ...d, result: { ...d.result, status: 'FAIL' } }))) }).some((e) => /≠ PASS/.test(e)), 'FAIL 交卷必拒');
  ok(checkDispatch({ plan, record: mkRec(full.map((d) => ({ ...d, result: { status: 'PASS', sc_results: [] } }))) }).some((e) => /缺 sc_results/.test(e)), '空 sc_results 必拒');
  ok(checkDispatch({ plan, record: mkRec([{ ...full[0], result: { status: 'PASS', sc_results: full[0].result.sc_results.map((r) => ({ ...r, status: 'FAIL' })) } }, ...full.slice(1)]) }).some((e) => /status=FAIL/.test(e)), '单条 sc FAIL 必拒');
  // 幽灵组 / 重复组
  ok(checkDispatch({ plan, record: mkRec([...full, { group_id: 'gX', worker_session_id: 'sx', tip: SHA('a'), report: 'r', result: { status: 'PASS', sc_results: [{ sc_id: 'x', status: 'PASS', evidence: 'e' }] } }]) }).some((e) => /幽灵组/.test(e)));
  ok(checkDispatch({ plan, record: mkRec([...full, { ...full[0], worker_session_id: 'sdup' }]) }).some((e) => /有 2 条派发记录/.test(e)));
  // 换 plan（record 未绑定本 plan）
  ok(checkDispatch({ plan, record: mkRec(full, { fix_plan_hash: 'f'.repeat(64) }) }).some((e) => /未绑定本 plan/.test(e)));
  // 波数不符
  ok(checkDispatch({ plan, record: { fix_plan_hash: plan.fix_plan_hash, waves: [] } }).some((e) => /波数/.test(e)));
});

t('[1号-容量分批] 组数 > capacity 必须分批且每批 ≤ capacity、覆盖全组不重复', () => {
  // 造 5 个独立域 SC，capacity=2 → 需分 3 批
  const art = artifactWithFindings([0, 1, 2, 3, 4].map((i) => ({ sev: 'major', paths: [`src/m${i}.ts`] })));
  const id = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const scm = { schema_version: 'v1', consensus_artifact_hash: art.consensus_artifact_hash, scs: [0, 1, 2, 3, 4].map((i) => ({ id: `SC-${i}`, kind: 'fix', finding_ids: [id(i)], change: 'c', holds: 'h', verify: VF() })) };
  const p = buildFixPlan({ artifact: art, manifest: scm, capacity: 2 }).plan;
  const CD = (record) => checkDispatch({ plan: p, record, capacity: 2 }); // fixture 注入，生产走可信配置
  eq(p.waves[0].length, 5, '5 组全独立同波');
  eq(p.n_min_per_wave[0], 2, 'capacity=2 → 下界取 2');
  const SHA = (c) => c.repeat(40);
  const ds = p.waves[0].map((g, i) => ({ group_id: g, worker_session_id: `w${i}`, tip: SHA(String(i % 10)), report: 'r', result: mkResult(p, g) }));
  // 无 batches → 拒
  ok(CD({ fix_plan_hash: p.fix_plan_hash, waves: [{ dispatches: ds }] }).some((e) => /必须分批/.test(e)));
  // 合法 canonical partition 2+2+1
  const good = { fix_plan_hash: p.fix_plan_hash, waves: [{ dispatches: ds, batches: [p.waves[0].slice(0, 2), p.waves[0].slice(2, 4), p.waves[0].slice(4)] }] };
  eq(CD(good).length, 0, '合法 canonical partition 应过');
  // SC-6: singleton batches（把可并行的组拆成 5 批串行）→ 必拒（旧实现放行）
  ok(CD({ fix_plan_hash: p.fix_plan_hash, waves: [{ dispatches: ds, batches: p.waves[0].map((g) => [g]) }] }).some((e) => /批数/.test(e)),
    'singleton batches 全串行必须被拦（R2-P1-3 核心）');
  // 非末批未满载 → 拒
  ok(CD({ fix_plan_hash: p.fix_plan_hash, waves: [{ dispatches: ds, batches: [[p.waves[0][0]], p.waves[0].slice(1, 3), p.waves[0].slice(3)] }] }).some((e) => /批数|满载/.test(e)));
  // 幽灵 id 混入 batches → 拒
  ok(CD({ fix_plan_hash: p.fix_plan_hash, waves: [{ dispatches: ds, batches: [[p.waves[0][0], 'ghost'], p.waves[0].slice(1, 3), p.waves[0].slice(3)] }] }).some((e) => /幽灵组|缺计划组/.test(e)));
});

t('[1号-隔离] 真 N-worktree: 3 组各自 worktree 改各自文件 → 集成成功；改同一文件 → 重叠 fail-closed 不 merge', () => {
  const d18 = mkdtempSync(join(tmpdir(), 'orc-'));
  const r18 = join(d18, 'repo');
  execFileSync('git', ['init', '-q', r18]);
  const g18 = (...a) => execFileSync('git', ['-C', r18, ...a], { encoding: 'utf8' }).trim();
  g18('config', 'user.email', 'o@t'); g18('config', 'user.name', 'o');
  for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(r18, f), 'base\n');
  g18('add', '.'); g18('commit', '-qm', 'base');
  const candidate = g18('rev-parse', 'HEAD');
  const wtRoot = join(d18, 'wt'); mkdirSync(wtRoot);
  const plan18 = {
    schema_version: 'v1', capacity: 8,
    groups: [
      { id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] },
      { id: 'g2', sc_ids: ['SC-1'], paths: ['b.ts'] },
      { id: 'g3', sc_ids: ['SC-2'], paths: ['c.ts'] }
    ],
    waves: [['g1', 'g2', 'g3']]
  };
  // allocate: 三个独立 worktree，base 同为 candidate
  const alloc = ORC.allocateWave({ repoDir: r18, worktreeRoot: wtRoot, runId: 'run1', plan: plan18, waveIndex: 0, waveBase: candidate, artifact: { canonical_findings: [] }, scManifest: { scs: [] } });
  eq(alloc.allocations.length, 3);
  for (const a of alloc.allocations) ok(existsSync(a.worktree), `worktree 应建成: ${a.group_id}`);
  ok(new Set(alloc.allocations.map((a) => a.worktree)).size === 3, '三个 worktree 路径互异（并发写危险构造上消失）');
  // 各组在自己 worktree 改自己文件并 commit（模拟并行 worker）
  const tips = [];
  for (const [i, a] of alloc.allocations.entries()) {
    const f = plan18.groups[i].paths[0];
    writeFileSync(join(a.worktree, f), `fixed by ${a.group_id}\n`);
    execFileSync('git', ['-C', a.worktree, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', a.worktree, 'commit', '-qm', `fix ${a.group_id}`], { encoding: 'utf8' });
    tips.push({ group_id: a.group_id, tip: execFileSync('git', ['-C', a.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
  }
  // integrate: 无重叠 → 成功且三处改动都在
  const rep = ORC.integrateWave({ repoDir: r18, waveBase: candidate, groupTips: tips });
  ok(rep.ok, '无重叠应集成成功: ' + JSON.stringify(rep.overlaps));
  ok(/^[0-9a-f]{40}$/.test(rep.integrated_tip));
  for (const f of ['a.ts', 'b.ts', 'c.ts']) {
    ok(execFileSync('git', ['-C', r18, 'show', `${rep.integrated_tip}:${f}`], { encoding: 'utf8' }).includes('fixed by'), `${f} 的修复必须进集成`);
  }
  // 重叠场景: 两组都改 a.ts → 集成前检测出交集，fail-closed 不 merge
  const d2 = mkdtempSync(join(tmpdir(), 'orc2-'));
  const wtRoot2 = join(d2, 'wt'); mkdirSync(wtRoot2, { recursive: true });
  const alloc2 = ORC.allocateWave({ repoDir: r18, worktreeRoot: wtRoot2, runId: 'run2', plan: plan18, waveIndex: 0, waveBase: candidate, artifact: { canonical_findings: [] }, scManifest: { scs: [] } });
  const tips2 = [];
  for (const a of alloc2.allocations.slice(0, 2)) {
    writeFileSync(join(a.worktree, 'a.ts'), `both touch ${a.group_id}\n`); // 计划外重叠（实改写集漂移）
    execFileSync('git', ['-C', a.worktree, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', a.worktree, 'commit', '-qm', `overlap ${a.group_id}`], { encoding: 'utf8' });
    tips2.push({ group_id: a.group_id, tip: execFileSync('git', ['-C', a.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
  }
  const before = g18('rev-parse', 'HEAD');
  const rep2 = ORC.integrateWave({ repoDir: r18, waveBase: candidate, groupTips: tips2 });
  ok(!rep2.ok, '实改文件重叠必须 fail-closed');
  ok(rep2.overlaps.some((o) => (o.files ?? []).includes('a.ts')), '必须报出重叠文件 a.ts');
  eq(g18('rev-parse', 'HEAD'), before, 'SC-13: 重叠被拒时 HEAD 必须没动（此前 before 变量未被断言）');
  // 血统: 不存在的对象 → 拒（**真实但不相关的 commit** 场景见 §20 SC-13，那条才是有效覆盖）
  const rep3 = ORC.integrateWave({ repoDir: r18, waveBase: candidate, groupTips: [{ group_id: 'g1', tip: 'a'.repeat(40) }] });
  ok(!rep3.ok && rep3.overlaps.some((o) => /血统|tip/.test(o.error ?? '')), '不存在对象的 tip 必须拒');
  // cleanup 回收（SC-R3-1: 目标只从 manifest 记录枚举）
  const cl = ORC.cleanupRun({ manifest: { repo_dir: r18, run_id: 'run1', integration_branch: null, waves: [{ worktree_root: wtRoot, allocations: alloc.allocations }] } });
  ok(cl.steps.filter((x) => x.startsWith('wt-removed')).length === 3, JSON.stringify(cl));
  for (const a of alloc.allocations) ok(!existsSync(a.worktree), 'cleanup 后 worktree 应回收');
});

t('[1号-波次基线] wave2 base = wave1 集成 tip（依赖波能看见前波产物）；残骸 worktree fail-closed', () => {
  const d19 = mkdtempSync(join(tmpdir(), 'wv-'));
  const r19 = join(d19, 'repo');
  execFileSync('git', ['init', '-q', r19]);
  const g19 = (...a) => execFileSync('git', ['-C', r19, ...a], { encoding: 'utf8' }).trim();
  g19('config', 'user.email', 'o@t'); g19('config', 'user.name', 'o');
  writeFileSync(join(r19, 'api.ts'), 'export const old = 1;\n');
  g19('add', '.'); g19('commit', '-qm', 'base');
  const cand = g19('rev-parse', 'HEAD');
  const wtRoot = join(d19, 'wt'); mkdirSync(wtRoot);
  const plan19 = {
    schema_version: 'v1', capacity: 8,
    groups: [{ id: 'g1', sc_ids: ['SC-0'], paths: ['api.ts'] }, { id: 'v2', sc_ids: ['SC-V'], paths: ['api.test.ts'], verify: true }],
    waves: [['g1'], ['v2']]
  };
  // wave1: 新增 API
  const a1 = ORC.allocateWave({ repoDir: r19, worktreeRoot: wtRoot, runId: 'r', plan: plan19, waveIndex: 0, waveBase: cand, artifact: { canonical_findings: [] }, scManifest: { scs: [] } });
  const wt1 = a1.allocations[0].worktree;
  writeFileSync(join(wt1, 'api.ts'), 'export const old = 1;\nexport const NEW_API = 2;\n');
  execFileSync('git', ['-C', wt1, 'add', '.'], { encoding: 'utf8' });
  execFileSync('git', ['-C', wt1, 'commit', '-qm', 'add api'], { encoding: 'utf8' });
  const tip1 = execFileSync('git', ['-C', wt1, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const int1 = ORC.integrateWave({ repoDir: r19, waveBase: cand, groupTips: [{ group_id: 'g1', tip: tip1 }] });
  ok(int1.ok);
  // wave2 base = wave1 集成 tip → verify 组能看见 NEW_API（审 R1-P1-5 核心）
  const a2 = ORC.allocateWave({ repoDir: r19, worktreeRoot: wtRoot, runId: 'r', plan: plan19, waveIndex: 1, waveBase: int1.integrated_tip, artifact: { canonical_findings: [] }, scManifest: { scs: [] } });
  const wt2 = a2.allocations[0].worktree;
  ok(readFileSync(join(wt2, 'api.ts'), 'utf8').includes('NEW_API'), 'wave2 worktree 必须看见 wave1 的产物（否则依赖波形同虚设）');
  // 残骸: 把 g1 的 worktree 挪到与 base 无血缘的 orphan commit → 再 allocate 必须 fail-closed
  execFileSync('git', ['-C', wt1, 'checkout', '-q', '--orphan', 'orphan-br'], { encoding: 'utf8' });
  writeFileSync(join(wt1, 'junk.ts'), 'orphan\n');
  execFileSync('git', ['-C', wt1, 'add', '.'], { encoding: 'utf8' });
  execFileSync('git', ['-C', wt1, 'commit', '-qm', 'orphan'], { encoding: 'utf8' });
  let threw19 = false;
  try { ORC.allocateWave({ repoDir: r19, worktreeRoot: wtRoot, runId: 'r', plan: plan19, waveIndex: 0, waveBase: cand, artifact: { canonical_findings: [] }, scManifest: { scs: [] } }); }
  catch (e) { threw19 = /残骸/.test(e.message); }
  ok(threw19, '与 base 无血缘的 worktree 残骸必须 fail-closed（不得拿它当本波用）');
  // 非法输入
  for (const bad of [{ waveBase: 'HEAD' }, { runId: 'a b' }]) {
    let t19 = false;
    try { ORC.allocateWave({ repoDir: r19, worktreeRoot: wtRoot, runId: bad.runId ?? 'r2', plan: plan19, waveIndex: 0, waveBase: bad.waveBase ?? cand, artifact: { canonical_findings: [] }, scManifest: { scs: [] } }); }
    catch { t19 = true; }
    ok(t19, `非法输入应拒: ${JSON.stringify(bad)}`);
  }
});

t('[2号-push闸/SC-R3-6] 端到端契约: 真实状态机 run + SKILL 字段 manifest（无 legacy）→ 放行；SC-2/3/4/9/10 + R3-2/8/10 回归', () => {
  // 零 finding 且无 parent 的首轮直通 → 无需编排链（豁免；须在 feat 前推之前用旧 HEAD 验）
  ok(checkPushGuard({ repoDir: repo, manifest: P.manifest, artifact: P.artifact, bundle: P.bundle, constitution }).ok,
    '零 finding 首轮直通应免编排链');

  // ---- 源共识: 修复前 candidate == 真实 HEAD（feat 初始 commit）----
  const srcBundle = mkBundle(BASE, HEAD);
  const art = artifactWithFindings([
    { sev: 'blocker', paths: ['server/a.ts'] },
    { sev: 'major', paths: ['src/b.ts'] },
    { sev: 'major', paths: ['src/b.ts', 'src/b2.ts'] }, // 与上条撞 → 同组
    { sev: 'major', paths: ['src/c.ts'] }
  ], srcBundle);
  const fid = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const scManifest = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash, scs: withScAttribution([
    { id: 'SC-0', kind: 'fix', finding_ids: [fid(0)], change: 'c', holds: 'h', verify: VF('test', ['-f', 'server/a.ts']) },
    { id: 'SC-1', kind: 'fix', finding_ids: [fid(1)], change: 'c', holds: 'h', verify: VF('test', ['-f', 'src/b.ts']) },
    { id: 'SC-2', kind: 'fix', finding_ids: [fid(2)], change: 'c', holds: 'h', verify: VF('test', ['-f', 'src/b2.ts']) },
    { id: 'SC-3', kind: 'fix', finding_ids: [fid(3)], change: 'c', holds: 'h', verify: VF('test', ['-f', 'src/c.ts']) }
  ], art) };
  const pr2 = buildFixPlan({ artifact: art, manifest: scManifest });
  ok(!pr2.degraded, 'plan 不该 degraded: ' + JSON.stringify(pr2.reasons ?? []));
  const plan = pr2.plan;
  eq(plan.waves.length, 1); eq(plan.waves[0].length, 3, '3 组并行（其中一组含两条撞车 SC）');

  // ---- 真实状态机 run（squash 集成）——SKILL Phase 2c 的命令序列逐一走真 ----
  const st = mkdtempSync(join(tmpdir(), 'pgrun-'));
  const wtR = join(st, 'wt'); mkdirSync(wtR);
  const symbolicBefore = git('symbolic-ref', '--short', 'HEAD');
  FR.initRun({ stateDir: st, runId: 'pg1', repoDir: repo, plan, scManifest, sourceArtifact: art, featureBranch: 'feat' });
  const al = FR.allocate({ stateDir: st, runId: 'pg1', plan, waveIndex: 0, worktreeRoot: wtR, artifact: art, scManifest });
  eq(al.wave_base, HEAD, 'wave0 base == 源 artifact candidate（SC-R3-10）');
  for (const a of al.allocations) {
    for (const f of a.anchor_paths) {
      mkdirSync(dirname(join(a.worktree, f)), { recursive: true });
      writeFileSync(join(a.worktree, f), `fixed ${a.group_id}\n`);
    }
    execFileSync('git', ['-C', a.worktree, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', a.worktree, 'commit', '-qm', `fix ${a.group_id}`], { encoding: 'utf8' });
  }
  const integ = FR.integrate({ stateDir: st, runId: 'pg1', plan, waveIndex: 0 });
  ok(integ.ok, 'wave1 应集成: ' + JSON.stringify(integ.errors ?? []));
  eq(git('symbolic-ref', '--short', 'HEAD'), symbolicBefore, 'SC-R3-11: integrate 不得动主 checkout（v1 会 detach）');
  const val = FR.validateIntegration({ stateDir: st, runId: 'pg1', scManifest, waveIndex: 0 });
  ok(val.ok, '复跑应过: ' + JSON.stringify(val.results));
  const fin = FR.finalizeRun({ stateDir: st, runId: 'pg1' });
  const S1 = fin.final_candidate;
  eq(git('rev-parse', 'HEAD'), S1, 'finalize 对检出中的 feat 用 ff-only 前推，工作区自然到位');
  eq(git('status', '--porcelain'), '', '前推后工作区 clean');
  const runM = fin.manifest;
  // SC-R3-8 正向前提: 最终链只有 1 个 squash、无 merge、group tips 不在祖先里
  const chain = git('rev-list', `${HEAD}..${S1}`).split('\n').filter(Boolean);
  eq(chain, [S1], 'source..final 恰为 squash commit 本身');
  for (const t2 of runM.waves[0].tips) {
    let inChain = true;
    try { execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', t2.tip, S1], { encoding: 'utf8' }); } catch { inChain = false; }
    ok(!inChain, `group tip ${t2.group_id} 不得进最终祖先（squash 语义，SC-R3-8）`);
  }

  // ---- 终版共识（delta 轮 parent 谱系）+ **SKILL.md 字段清单** manifest（无 sc_hash/sc_list）----
  const finalBundle = mkBundle(BASE, S1);
  const finalArt = consensusFor(finalBundle, [{}, {}, {}], { parentArtifactHash: art.consensus_artifact_hash }).artifact;
  ok(finalArt.gate_result === 'pass', '终版共识应达成');
  eq(finalArt.parent_artifact_hash, art.consensus_artifact_hash, '终版必须记录 exact parent');
  const dispatchRecord = { fix_plan_hash: plan.fix_plan_hash,
    waves: [{ dispatches: runM.waves[0].tips.map((t3, i) => ({ group_id: t3.group_id, worker_session_id: `w${i}`, tip: t3.tip, report: 'ok', result: mkResult(plan, t3.group_id) })) }] };
  const fo = {
    source_artifact_hash: art.consensus_artifact_hash,
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecord),
    run_manifest_hash: FR.runManifestHash(runM)
  };
  const baseManifest = { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: S1, purpose: 'feature',
    consensus_artifact_hash: finalArt.consensus_artifact_hash };
  const call = (over = {}) => checkPushGuard({
    repoDir: repo,
    manifest: over.manifest ?? { ...baseManifest, fix_orchestration: fo },
    artifact: over.artifact ?? finalArt, bundle: 'bundle' in over ? over.bundle : finalBundle, constitution,
    sourceArtifact: 'sourceArtifact' in over ? over.sourceArtifact : art,
    scManifest: 'scManifest' in over ? over.scManifest : scManifest,
    fixPlan: 'fixPlan' in over ? over.fixPlan : plan,
    dispatchRecord: 'dispatchRecord' in over ? over.dispatchRecord : dispatchRecord,
    runManifest: 'runManifest' in over ? over.runManifest : runM
  });
  // SC-R3-6: 严格按 SKILL.md 字段的 manifest（无 legacy sc_hash/sc_list）→ 放行
  let r = call();
  ok(r.ok, 'SC-R3-6 契约: SKILL 字段 manifest + 真实 run 应放行: ' + r.errors.join(';'));
  // SC-2: 省略 fix_orchestration → **必拒**
  const omitted = call({ manifest: baseManifest });
  ok(!omitted.ok && omitted.errors.some((e) => /必须走修复编排链/.test(e)),
    'SC-2: 有 parent/finding 却省略编排链声明必须被拦（R2-P1-1 核心）');
  // 缺件 → fail-closed
  for (const k of ['sourceArtifact', 'scManifest', 'fixPlan', 'dispatchRecord', 'runManifest']) {
    ok(!call({ [k]: null }).ok, `缺 ${k} 必须 fail-closed`);
  }
  // SC-9: run manifest 的 final_candidate ≠ expected_sha（集成后私改）→ 拒
  const sneak = JSON.parse(JSON.stringify(runM)); sneak.final_candidate = '9'.repeat(40);
  const rs = call({ runManifest: sneak, manifest: { ...baseManifest, fix_orchestration: { ...fo, run_manifest_hash: FR.runManifestHash(sneak) } } });
  ok(!rs.ok && rs.errors.some((e) => /最终 integrated_tip|私改/.test(e)), 'SC-9: final_candidate 不符必拒');
  // SC-R3-8: 集成后私补 commit——lead 真把 feat 推进到私补 SHA 再来 push → lineage 拒
  const sneakTip = git('commit-tree', `${S1}^{tree}`, '-p', S1, '-m', 'lead sneaks in');
  git('merge', '--ff-only', sneakTip); // 模拟 lead 私补后 feat/HEAD 都在私补 SHA 上
  const sneakBundle = mkBundle(BASE, sneakTip);
  const sneakArt = consensusFor(sneakBundle, [{}, {}, {}], { parentArtifactHash: art.consensus_artifact_hash }).artifact;
  const rSneak = call({ artifact: sneakArt, bundle: sneakBundle, manifest: { ...baseManifest, expected_sha: sneakTip, consensus_artifact_hash: sneakArt.consensus_artifact_hash, fix_orchestration: fo } });
  ok(!rSneak.ok && rSneak.errors.some((e) => /最终 integrated_tip|私改|未登记 commit/.test(e)), 'SC-R3-8: 集成后私补 commit 必拒: ' + rSneak.errors.join(';'));
  git('reset', '--hard', '-q', S1); // 还原临时 fixture 仓到集成 tip
  // SC-R3-2: run manifest 漏组（wave tips subset，攻击者连 hash 一起重算）→ 拒
  const subset = JSON.parse(JSON.stringify(runM));
  subset.waves[0].tips = subset.waves[0].tips.slice(0, 1);
  const rSub = call({ runManifest: subset, manifest: { ...baseManifest, fix_orchestration: { ...fo, run_manifest_hash: FR.runManifestHash(subset) } } });
  ok(!rSub.ok && rSub.errors.some((e) => /集成组集合|漏组/.test(e)), 'SC-R3-2: 漏组 run manifest 必拒（R3 反例复刻）');
  // SC-R3-10: run 起点漂移 → 拒
  const drift = JSON.parse(JSON.stringify(runM)); drift.source_candidate = BASE;
  const rDrift = call({ runManifest: drift, manifest: { ...baseManifest, fix_orchestration: { ...fo, run_manifest_hash: FR.runManifestHash(drift) } } });
  ok(!rDrift.ok && rDrift.errors.some((e) => /起点漂移|source_candidate/.test(e)), 'SC-R3-10: 起点漂移必拒');
  // run manifest 事件链被删改 → 拒
  const chainBroken = JSON.parse(JSON.stringify(runM)); chainBroken.events.splice(1, 1);
  const rc = call({ runManifest: chainBroken, manifest: { ...baseManifest, fix_orchestration: { ...fo, run_manifest_hash: FR.runManifestHash(chainBroken) } } });
  ok(!rc.ok && rc.errors.some((e) => /事件链断裂/.test(e)), 'run manifest 断链必拒');
  // SC-3: 同 base 的**另一份**源 artifact 冒充 → 必拒
  const otherSrc = artifactWithFindings([{ sev: 'major', paths: ['src/other.ts'] }], mkBundle(BASE, SHA_B));
  eq(otherSrc.base_sha, art.base_sha, '前提: 冒充者与真源同 base');
  const wrongSrc = call({ sourceArtifact: otherSrc, manifest: { ...baseManifest, fix_orchestration: { ...fo, source_artifact_hash: otherSrc.consensus_artifact_hash } } });
  ok(!wrongSrc.ok && wrongSrc.errors.some((e) => /exact parent|冒充/.test(e)), 'SC-3: 同 base 错源必拒');
  // SC-4: mega-SC → 覆盖门拒
  const megaScm = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: [{ id: 'SC-MEGA', kind: 'fix', finding_ids: art.canonical_findings.map((f) => f.id), change: 'c', holds: 'h', verify: VF() }] };
  const mega = call({ scManifest: megaScm, manifest: { ...baseManifest, fix_orchestration: { ...fo, sc_manifest_hash: hashObject(megaScm) } } });
  ok(!mega.ok && mega.errors.some((e) => /恰好引用 1 条|SC 覆盖门/.test(e)), 'SC-4: mega-SC 必拒（R2-P1-2 核心）');
  // SC 漏项
  const missScm = { ...scManifest, scs: scManifest.scs.slice(0, 1) };
  ok(!call({ scManifest: missScm, manifest: { ...baseManifest, fix_orchestration: { ...fo, sc_manifest_hash: hashObject(missScm) } } }).ok, 'SC 漏项必拒');
  // lead 手改分组合成单组串行（连 hash 一起改）→ 重算拦
  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.groups = [{ id: 'g1', sc_ids: plan.groups.flatMap((g) => g.sc_ids).sort(), paths: [...new Set(plan.groups.flatMap((g) => g.paths))].sort() }];
  tampered.waves = [['g1']];
  tampered.fix_plan_hash = computeFixPlanHash(tampered);
  const rt = call({ fixPlan: tampered, manifest: { ...baseManifest, fix_orchestration: { ...fo, fix_plan_hash: tampered.fix_plan_hash } } });
  ok(!rt.ok && rt.errors.some((e) => /分组被 lead 改动/.test(e)), '改分组串行化必拒');
  // 派发不足（只派 1 个）
  const thin = { fix_plan_hash: plan.fix_plan_hash, waves: [{ dispatches: [dispatchRecord.waves[0].dispatches[0]] }] };
  ok(!call({ dispatchRecord: thin, manifest: { ...baseManifest, fix_orchestration: { ...fo, dispatch_record_hash: hashObject(thin) } } }).ok, '派发不足必拒');
  // SC-10: FAIL 交卷
  const failRec = JSON.parse(JSON.stringify(dispatchRecord));
  failRec.waves[0].dispatches[0].result.status = 'FAIL';
  ok(!call({ dispatchRecord: failRec, manifest: { ...baseManifest, fix_orchestration: { ...fo, dispatch_record_hash: hashObject(failRec) } } }).ok, 'FAIL 交卷必拒');
  // cleanup: 本 run 的 worktree/分支全回收（真实 allocation 记录驱动）
  const cl = ORC.cleanupRun({ manifest: readJson(FR.runManifestPath(st, 'pg1')) });
  eq((cl.errors ?? []).length, 0, 'cleanup 不应报错: ' + JSON.stringify(cl.errors));
  for (const a of al.allocations) ok(!existsSync(a.worktree), 'run worktree 应回收');
});

t('[SC-5] canonical severity 取同簇最高（输入顺序无关，防降级绕过覆盖门）', () => {
  const mkF = (sev) => ({ id: `s-${sev}`, primary_face: 'A', severity: sev, anchor: 'src/same.ts#0', anchor_paths: ['src/same.ts'], evidence: '同一个问题的相同描述', status: 'closed' });
  for (const [a, b] of [['suggestion', 'major'], ['major', 'suggestion']]) {
    const art = consensusFor(bundle, [
      { findings: [mkF(a)], closed_finding_ids: [`s-${a}`] },
      { findings: [mkF(b)], closed_finding_ids: [`s-${b}`] },
      {}
    ]).artifact;
    eq(art.canonical_findings.length, 1, '同簇应聚为一条');
    eq(art.canonical_findings[0].severity, 'major', `输入顺序 ${a}→${b} 时 canonical 必须取最高 major`);
  }
});

t('[SC-1/SC-R3-1] cleanup 归属校验: 未登记拒删 + registered-not-owned 拒删（P0 安全）', () => {
  const d1 = mkdtempSync(join(tmpdir(), 'cl1-'));
  const r1 = join(d1, 'repo');
  execFileSync('git', ['init', '-q', r1]);
  const g1 = (...a) => execFileSync('git', ['-C', r1, ...a], { encoding: 'utf8' }).trim();
  g1('config', 'user.email', 'o@t'); g1('config', 'user.name', 'o');
  writeFileSync(join(r1, 'f.ts'), 'x\n'); g1('add', '.'); g1('commit', '-qm', 'base');
  const cand = g1('rev-parse', 'HEAD');
  const planC = { schema_version: 'v1', capacity: 8, groups: [{ id: 'g1', sc_ids: ['SC-0'], paths: ['f.ts'] }], waves: [['g1']] };
  const mkManifest = (allocations) => ({ repo_dir: r1, run_id: 'runX', integration_branch: null, waves: [{ worktree_root: dirname(allocations[0].worktree), allocations }] });
  // ① 未登记目录（含哨兵文件）→ 拒删
  const fakeRoot = mkdtempSync(join(tmpdir(), 'notmine-'));
  const fakeWt = join(fakeRoot, 'runX-g1');
  mkdirSync(fakeWt, { recursive: true });
  const sentinel = join(fakeWt, 'IMPORTANT.txt');
  writeFileSync(sentinel, '不可删除的用户数据\n');
  const bad = ORC.cleanupRun({ manifest: mkManifest([{ group_id: 'g1', worktree: fakeWt, branch: 'fix/runX/g1' }]) });
  ok(existsSync(sentinel), 'P0: 未登记目录的文件必须还在（旧实现 rmSync 会删掉）');
  ok((bad.errors ?? []).some((e) => /归属不符|拒绝回收/.test(e)), '必须报归属不符');
  ok((bad.steps ?? []).includes('wt-refused:g1'));
  // ② R3-P0 场景: **合法登记但非本 run 分配**的 worktree（路径被 manifest 恶意/失误引用）
  //    v1 只查 registered → remove --force 直接删掉；现在检出分支 ≠ allocation 记录 → 拒，
  //    且**连分支都不删**
  const legitWt = join(d1, 'legit-wt');
  g1('worktree', 'add', '-q', '-b', 'legit-branch', legitWt, cand);
  const sentinel2 = join(legitWt, 'WIP.txt');
  writeFileSync(sentinel2, '别人的未提交工作\n');
  const bad2 = ORC.cleanupRun({ manifest: mkManifest([{ group_id: 'g1', worktree: legitWt, branch: 'fix/runX/g1' }]) });
  ok(existsSync(sentinel2), 'SC-R3-1 P0: 合法登记但非本 run 的 worktree（含未提交数据）必须存活');
  ok((bad2.errors ?? []).some((e) => /检出分支.*≠|归属不符/.test(e)), '必须报检出分支不符: ' + JSON.stringify(bad2.errors));
  eq(g1('rev-parse', '--verify', 'refs/heads/legit-branch').length, 40, '归属不符时对方分支必须原封不动');
  ok(!(bad2.steps ?? []).some((s) => s.startsWith('br-deleted')), '归属不符连分支都不删');
  // ③ 正常 run → 照常回收（目标来自真实 allocation 记录）
  const wtRoot = join(d1, 'wt'); mkdirSync(wtRoot);
  const al = ORC.allocateWave({ repoDir: r1, worktreeRoot: wtRoot, runId: 'ok1', plan: planC, waveIndex: 0, waveBase: cand, artifact: { canonical_findings: [] }, scManifest: { scs: [] } });
  ok(existsSync(al.allocations[0].worktree));
  const good = ORC.cleanupRun({ manifest: { repo_dir: r1, run_id: 'ok1', integration_branch: null, waves: [{ worktree_root: wtRoot, allocations: al.allocations }] } });
  ok(!existsSync(al.allocations[0].worktree), '已登记 worktree 应被回收');
  eq((good.errors ?? []).length, 0, '正常回收不应报错: ' + JSON.stringify(good.errors));
});

t('[SC-7] verify SC 按冲突图分组: 两个独立测试域 → 末波 2 组并行（不再强制合成 1 组）', () => {
  const art = artifactWithFindings([
    { sev: 'major', paths: ['src/a.ts'] },
    { sev: 'major', paths: ['e2e/x.test.ts'] },
    { sev: 'major', paths: ['e2e/y.test.ts'] }
  ]);
  const id = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const scm = { schema_version: 'v1', consensus_artifact_hash: art.consensus_artifact_hash, scs: [
    { id: 'SC-0', kind: 'fix', finding_ids: [id(0)], change: 'c', holds: 'h', verify: VF() },
    { id: 'SC-V1', kind: 'verify', finding_ids: [id(1)], change: 'c', holds: 'h', verify: VF('npm', ['test', 'x']) },
    { id: 'SC-V2', kind: 'verify', finding_ids: [id(2)], change: 'c', holds: 'h', verify: VF('npm', ['test', 'y']) }
  ] };
  const r = buildFixPlan({ artifact: art, manifest: scm });
  ok(!r.degraded, JSON.stringify(r.reasons ?? []));
  eq(r.plan.waves.length, 2);
  eq(r.plan.waves[1].length, 2, 'SC-7: 两个独立 verify SC 必须末波并行（R2-P1-6 核心）');
  eq(r.plan.capacity, TRUSTED_CAP, 'SC-6: capacity 来自可信配置');
});


// ========== 19. SC-8/SC-9/SC-10b: 有状态 orchestrator + DAG lineage + 复跑 ==========
console.log('\n[19] SC-8 run manifest CAS / SC-9 DAG lineage / SC-10b orchestrator 复跑');

// 真 git 仓 + 真 plan，跑完整 run（init→allocate→integrate→validate→finalize）
function mkRunEnv(specs) {
  const d = mkdtempSync(join(tmpdir(), 'run-'));
  const r = join(d, 'repo');
  execFileSync('git', ['init', '-q', r]);
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'o@t'); g('config', 'user.name', 'o');
  for (const f of specs.files) {
    mkdirSync(dirname(join(r, f)), { recursive: true });
    writeFileSync(join(r, f), 'base\n');
  }
  g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat');
  const cand = g('rev-parse', 'HEAD');
  return { d, r, g, cand, stateDir: join(d, 'state'), wtRoot: join(d, 'wt') };
}
// SC-R3-10: initRun 起点由源 artifact 派生——helper 造「artifact + 与其绑定的 plan + scm」三件
function mkRunSetup(env, groups, waves, scs, capacity = TRUSTED_CAP) {
  const art = consensusFor(mkBundle(SHA_A, env.cand)).artifact;
  const plan = { schema_version: 'v1', consensus_artifact_hash: art.consensus_artifact_hash, capacity, groups, waves, n_min_per_wave: waves.map((w) => Math.min(w.length, capacity)) };
  plan.fix_plan_hash = computeFixPlanHash(plan);
  const scm = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash, scs };
  return { art, plan, scm };
}
function workGroup(env, alloc, file, content) {
  const wt = alloc.worktree;
  mkdirSync(dirname(join(wt, file)), { recursive: true });
  writeFileSync(join(wt, file), content);
  execFileSync('git', ['-C', wt, 'add', '.'], { encoding: 'utf8' });
  execFileSync('git', ['-C', wt, 'commit', '-qm', `fix ${alloc.group_id}`], { encoding: 'utf8' });
  return execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

t('[SC-8] run manifest CAS: wave base 由状态派生不接受自报；跳波拒；tampered plan 拒；tip 归属/越域/空交卷全拒', () => {
  const env = mkRunEnv({ files: ['a.ts', 'b.ts', 'e2e/x.test.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }, { id: 'g2', sc_ids: ['SC-1'], paths: ['b.ts'] },
     { id: 'v1', sc_ids: ['SC-V'], paths: ['e2e/x.test.ts'], verify: true }],
    [['g1', 'g2'], ['v1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) },
     { id: 'SC-1', kind: 'fix', finding_ids: ['f1'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'b.ts']) },
     { id: 'SC-V', kind: 'verify', finding_ids: ['f2'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'e2e/x.test.ts']) }]
  );
  FR.initRun({ stateDir: env.stateDir, runId: 'r1', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  // 重复 init 幂等保护
  let threw = false;
  try { FR.initRun({ stateDir: env.stateDir, runId: 'r1', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art }); } catch { threw = true; }
  ok(threw, '同 runId 重复 init 必拒');
  // SC-R3-10: plan 绑错 artifact → init 拒
  threw = false;
  const otherArt = consensusFor(mkBundle(SHA_A, SHA_B)).artifact;
  try { FR.initRun({ stateDir: env.stateDir, runId: 'r1b', repoDir: env.r, plan, scManifest: scm, sourceArtifact: otherArt }); }
  catch (e) { threw = /plan 绑定的 artifact hash/.test(e.message); }
  ok(threw, 'SC-R3-10: plan 与源 artifact 不绑定必拒');
  // 跳波: wave2 未待 wave1 集成 → CAS 拒（旧实现 caller 传任意 SHA 就行）
  threw = false;
  try { FR.allocate({ stateDir: env.stateDir, runId: 'r1', plan, waveIndex: 1, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm }); }
  catch (e) { threw = /base 不可得|尚未集成/.test(e.message); }
  ok(threw, 'SC-8: 跳波 allocate 必拒（base 只能由 manifest 派生）');
  // wave1 正常
  const a1 = FR.allocate({ stateDir: env.stateDir, runId: 'r1', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  eq(a1.wave_base, env.cand, 'wave0 base == source candidate');
  eq(a1.allocations.length, 2);
  // SC-R3-2（R3 反例复刻）: tampered plan（漏 g2 且 hash 自洽）调 integrate → 必拒
  const tamperedPlan = JSON.parse(JSON.stringify(plan));
  tamperedPlan.waves = [['g1'], ['v1']];
  tamperedPlan.fix_plan_hash = computeFixPlanHash(tamperedPlan);
  threw = false;
  try { FR.integrate({ stateDir: env.stateDir, runId: 'r1', plan: tamperedPlan, waveIndex: 0 }); }
  catch (e) { threw = /plan hash 不符/.test(e.message); }
  ok(threw, 'SC-R3-2: integrate 收 tampered plan 必拒（v1 不校验 = 组可被静默漏集成）');
  // 空交卷（不改任何东西）→ tip == base → 拒
  let integ = FR.integrate({ stateDir: env.stateDir, runId: 'r1', plan, waveIndex: 0 });
  ok(!integ.ok && integ.errors.some((e) => /空交卷|等于 base/.test(e)), '空交卷必拒');
  // [anchor_paths 拆分] fix 类 write_paths.mode='isolated'：g1（anchor=a.ts）改一个未被任何组
  // 认领、也未与其他组撞车的新文件 c.ts——旧设计会把它误判「越域改动」拒绝（anchor 是证据不是
  // 写集，2026-08-02 拆分修的正是这个问题），新设计应放行。
  workGroup(env, a1.allocations[0], 'c.ts', 'g1 合法但未被证据覆盖的改动\n');
  workGroup(env, a1.allocations[1], 'b.ts', 'g2 改自己的\n');
  integ = FR.integrate({ stateDir: env.stateDir, runId: 'r1', plan, waveIndex: 0 });
  ok(integ.ok, 'fix 类 write_paths.mode=isolated: 改未被证据覆盖但未撞车的文件应放行: ' + JSON.stringify(integ.errors ?? []));
});

t('[SC-8/SC-9/SC-10b] 完整 run: 两波 squash 集成 → 复跑验证 → finalize 前推 → 链为精确 squash 集合；主 checkout 零接触', () => {
  const env = mkRunEnv({ files: ['a.ts', 'b.ts', 'e2e/x.test.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }, { id: 'g2', sc_ids: ['SC-1'], paths: ['b.ts'] },
     { id: 'v1', sc_ids: ['SC-V'], paths: ['e2e/x.test.ts'], verify: true }],
    [['g1', 'g2'], ['v1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) },
     { id: 'SC-1', kind: 'fix', finding_ids: ['f1'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'b.ts']) },
     { id: 'SC-V', kind: 'verify', finding_ids: ['f2'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'e2e/x.test.ts']) }]
  );
  FR.initRun({ stateDir: env.stateDir, runId: 'r2', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const symbolicBefore = env.g('symbolic-ref', '--short', 'HEAD');
  // wave1: 两组各改自己文件 → 并行集成（squash）
  const a1 = FR.allocate({ stateDir: env.stateDir, runId: 'r2', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  const t1a = workGroup(env, a1.allocations[0], 'a.ts', 'fixed a\n');
  const t1b = workGroup(env, a1.allocations[1], 'b.ts', 'fixed b\n');
  const i1 = FR.integrate({ stateDir: env.stateDir, runId: 'r2', plan, waveIndex: 0 });
  ok(i1.ok, 'wave1 应集成成功: ' + JSON.stringify(i1.errors ?? []));
  eq(env.g('symbolic-ref', '--short', 'HEAD'), symbolicBefore, 'SC-R3-11: integrate 不得 detach 主 checkout');
  // SC-R3-8: integrated_tip 是单亲 squash，parent == 波 base；group tips 不进祖先
  eq(env.g('rev-parse', `${i1.integrated_tip}^`), env.cand, 'wave1 squash 的 parent == 波 base');
  for (const tip of [t1a, t1b]) {
    let anc = true;
    try { execFileSync('git', ['-C', env.r, 'merge-base', '--is-ancestor', tip, i1.integrated_tip], { encoding: 'utf8' }); } catch { anc = false; }
    ok(!anc, 'group tip 不得是 squash 的祖先（SC-R3-8）');
  }
  ok(env.g('show', `${i1.integrated_tip}:a.ts`).includes('fixed a'), 'squash 树含 g1 修复');
  ok(env.g('show', `${i1.integrated_tip}:b.ts`).includes('fixed b'), 'squash 树含 g2 修复');
  // SC-10b: orchestrator 自己复跑 verify（真实 execFile）
  const v1 = FR.validateIntegration({ stateDir: env.stateDir, runId: 'r2', scManifest: scm, waveIndex: 0 });
  ok(v1.ok, 'wave1 复跑应过: ' + JSON.stringify(v1.results));
  // wave2 base 必须 == wave1 集成 tip（SC-8 ①，看得见前波产物）
  const a2 = FR.allocate({ stateDir: env.stateDir, runId: 'r2', plan, waveIndex: 1, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  eq(a2.wave_base, i1.integrated_tip, 'SC-8: wave2 base == wave1 integrated_tip');
  ok(readFileSync(join(a2.allocations[0].worktree, 'a.ts'), 'utf8').includes('fixed a'), 'wave2 必须看见 wave1 产物');
  workGroup(env, a2.allocations[0], 'e2e/x.test.ts', 'test updated\n');
  const i2 = FR.integrate({ stateDir: env.stateDir, runId: 'r2', plan, waveIndex: 1 });
  ok(i2.ok, 'wave2 应集成: ' + JSON.stringify(i2.errors ?? []));
  const v2 = FR.validateIntegration({ stateDir: env.stateDir, runId: 'r2', scManifest: scm, waveIndex: 1 });
  ok(v2.ok);
  // finalize: feature branch 前推（检出中 → ff-only，工作区同步且 clean）
  const fin = FR.finalizeRun({ stateDir: env.stateDir, runId: 'r2' });
  eq(fin.final_candidate, i2.integrated_tip);
  eq(env.g('rev-parse', 'refs/heads/feat'), i2.integrated_tip, 'feature branch 必须被前推');
  eq(env.g('rev-parse', 'HEAD'), i2.integrated_tip, '检出中的 feat 用 ff-only 前推，工作区自然到位');
  eq(env.g('status', '--porcelain'), '', '前推后工作区 clean');
  // SC-R3-8: 最终链 == 精确 squash 集合（两波各一个 squash，无 merge、无其他 commit）
  const revs = env.g('rev-list', `${env.cand}..${fin.final_candidate}`).split('\n').filter(Boolean);
  eq(revs.sort(), [i1.integrated_tip, i2.integrated_tip].sort(), 'source..final 恰为两个 wave squash');
  eq(env.g('rev-list', '--merges', `${env.cand}..${fin.final_candidate}`), '', '最终链无 merge commit');
  eq([...FR.recordedSquashes(fin.manifest)].sort(), [i1.integrated_tip, i2.integrated_tip].sort(), 'recordedSquashes == 链上集合');
  // 事件链完整 / 删改断链
  eq(FR.verifyEventChain(fin.manifest).length, 0, 'run manifest 事件链应完整');
  const tampered = JSON.parse(JSON.stringify(fin.manifest));
  tampered.events.splice(1, 1);
  ok(FR.verifyEventChain(tampered).length > 0, '删事件必须断链');
  // SC-R3-3: validation 明细入 runManifestHash——事后改 verify 结果即 hash 失效
  const rmHash = FR.runManifestHash(fin.manifest);
  const flipped = JSON.parse(JSON.stringify(fin.manifest));
  flipped.waves[0].validation.results[0].exit_code = 99;
  ok(FR.runManifestHash(flipped) !== rmHash, 'SC-R3-3: 改 validation 明细必须使 run manifest hash 失效');
});

t('[SC-8④/SC-R3-9] overlap = fail-closed + 串行重派（真重跑: 后组看得见前组产物，不搬旧产物）', () => {
  const env = mkRunEnv({ files: ['shared.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  // 两组的 write_paths 域都含 shared.ts（计划认为可并行，实改却撞车）
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['shared.ts'] }, { id: 'g2', sc_ids: ['SC-1'], paths: ['shared.ts'] }],
    [['g1', 'g2']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'shared.ts']) },
     { id: 'SC-1', kind: 'fix', finding_ids: ['f1'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'shared.ts']) }]
  );
  FR.initRun({ stateDir: env.stateDir, runId: 'r3', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'r3', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  // 两组并行都改 shared.ts → 撞车
  const wt1 = a.allocations[0].worktree, wt2 = a.allocations[1].worktree;
  writeFileSync(join(wt1, 'shared.ts'), 'g1 line\nbase\n');
  execFileSync('git', ['-C', wt1, 'commit', '-qam', 'g1'], { encoding: 'utf8' });
  writeFileSync(join(wt2, 'shared.ts'), 'base\ng2 line\n');
  execFileSync('git', ['-C', wt2, 'commit', '-qam', 'g2'], { encoding: 'utf8' });
  const r = FR.integrate({ stateDir: env.stateDir, runId: 'r3', plan, waveIndex: 0 });
  ok(!r.ok && r.replan_required, 'SC-R3-9: overlap 必须 fail-closed 转串行重派（不 cherry-pick 冒充重跑）');
  eq(r.order, ['g1', 'g2'], '重派顺序确定性');
  const m0 = readJson(FR.runManifestPath(env.stateDir, 'r3'));
  ok(m0.events.some((e) => e.kind === 'overlap-replan-required'), 'overlap 必须留痕');
  // replan 状态下再并行 integrate → 拒（不得回头）
  const again = FR.integrate({ stateDir: env.stateDir, runId: 'r3', plan, waveIndex: 0 });
  ok(!again.ok && again.errors.some((e) => /串行重派/.test(e)), 'replan 后不得回头并行集成');
  // 轮1: g1 在 wave base 上重跑
  const s1 = FR.serialAllocate({ stateDir: env.stateDir, runId: 'r3', plan, waveIndex: 0 });
  eq(s1.allocation.group_id, 'g1'); eq(s1.allocation.base, env.cand, '轮1 base == 波 base');
  // 未 integrate 就开下一轮 → 拒
  let threw = false;
  try { FR.serialAllocate({ stateDir: env.stateDir, runId: 'r3', plan, waveIndex: 0 }); }
  catch (e) { threw = /尚未 serial-integrate/.test(e.message); }
  ok(threw, '上一轮未集成不得开下一轮');
  writeFileSync(join(s1.allocation.worktree, 'shared.ts'), 'g1 line\nbase\n');
  execFileSync('git', ['-C', s1.allocation.worktree, 'commit', '-qam', 'g1 rerun'], { encoding: 'utf8' });
  const si1 = FR.serialIntegrate({ stateDir: env.stateDir, runId: 'r3', plan, waveIndex: 0 });
  ok(si1.ok && !si1.wave_done, '轮1 集成、波未完');
  // 轮2: g2 base == 轮1 squash——**真重跑**: g2 的新 worktree 看得见 g1 产物（cherry-pick 搬旧产物做不到）
  const s2 = FR.serialAllocate({ stateDir: env.stateDir, runId: 'r3', plan, waveIndex: 0 });
  eq(s2.allocation.group_id, 'g2'); eq(s2.allocation.base, si1.squash, '轮2 base == 轮1 squash（递进）');
  ok(readFileSync(join(s2.allocation.worktree, 'shared.ts'), 'utf8').includes('g1 line'), 'SC-R3-9 核心: 重跑的 g2 看得见 g1 产物');
  writeFileSync(join(s2.allocation.worktree, 'shared.ts'), 'g1 line\nbase\ng2 line\n');
  execFileSync('git', ['-C', s2.allocation.worktree, 'commit', '-qam', 'g2 rerun'], { encoding: 'utf8' });
  const si2 = FR.serialIntegrate({ stateDir: env.stateDir, runId: 'r3', plan, waveIndex: 0 });
  ok(si2.ok && si2.wave_done, '轮2 集成后波完成');
  const m1 = readJson(FR.runManifestPath(env.stateDir, 'r3'));
  eq(m1.waves[0].integrated_tip, si2.squash);
  ok(env.g('show', `${si2.squash}:shared.ts`).includes('g1 line') && env.g('show', `${si2.squash}:shared.ts`).includes('g2 line'), '最终树含两组产物');
  // 链 = 两个 round squash（精确集合，group 原始 tips 不在其中）
  const revs = env.g('rev-list', `${env.cand}..${si2.squash}`).split('\n').filter(Boolean);
  eq(revs.sort(), [si1.squash, si2.squash].sort(), '串行链恰为两个 round squash');
  // 全部轮完成后再开 → 拒
  threw = false;
  try { FR.serialAllocate({ stateDir: env.stateDir, runId: 'r3', plan, waveIndex: 0 }); }
  catch (e) { threw = /已全部完成/.test(e.message); }
  ok(threw, '重派完成后不得再开轮');
});

t('[R10-A1] archive kind 端到端可用: coverage-gate 过 → buildFixPlan 定域末波 → 真跑 fix-run 改 README → push-guard 全链绿', () => {
  // 独立仓: 真实 base 祖先（非合成 SHA）——push-guard 的 diff/CI 路径检查需要 base_sha 真实存在
  const d = mkdtempSync(join(tmpdir(), 'archA1-'));
  const r = join(d, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', r]);
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'o@t'); g('config', 'user.name', 'o');
  writeFileSync(join(r, 'seed.txt'), 'seed\n');
  g('add', '.'); g('commit', '-qm', 'base');
  const baseSha = g('rev-parse', 'HEAD');
  g('remote', 'add', 'origin', 'https://github.com/o/r.git');
  g('checkout', '-qb', 'feat');
  for (const f of ['a.ts', 'e2e/x.test.ts', 'README.md']) {
    mkdirSync(dirname(join(r, f)), { recursive: true });
    writeFileSync(join(r, f), 'base\n');
  }
  g('add', '.'); g('commit', '-qm', 'feat seed');
  const cand = g('rev-parse', 'HEAD');
  const env = { d, r, g, cand, stateDir: join(d, 'state'), wtRoot: join(d, 'wt') };

  const bundleA1 = mkBundle(baseSha, cand);
  const art = artifactWithFindings([
    { sev: 'major', paths: ['a.ts'] },              // f0 → kind=fix
    { sev: 'major', paths: ['e2e/x.test.ts'] },     // f1 → kind=verify
    { sev: 'major', paths: ['server/bar.ts'] }      // f2 → kind=archive（残余风险登记，域不从此派生）
  ], bundleA1);
  const id = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const RESIDUAL_PHRASE = 'ARCHIVE-R10-A1-RESIDUAL';
  const scManifest = {
    schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: withScAttribution([
      { id: 'SC-0', kind: 'fix', finding_ids: [id(0)], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) },
      { id: 'SC-V', kind: 'verify', finding_ids: [id(1)], change: 'c', holds: 'h', verify: VF('test', ['-f', 'e2e/x.test.ts']) },
      { id: 'SC-ARCH', kind: 'archive', finding_ids: [id(2)], change: '把残余风险文案写进 README.md', holds: 'README.md 含约定文案', verify: VF('grep', ['-q', RESIDUAL_PHRASE, 'README.md']) }
    ], art)
  };

  // ① coverage-gate: archive SC 与 fix/verify 同等过闸
  eq(checkScCoverage({ manifest: scManifest, artifact: art }).length, 0, 'archive SC 应与 fix/verify 同等过 coverage-gate（SKILL.md「ARCHIVE 类的收口」机器契约）');

  // ② buildFixPlan: 域固定 README.md + 末波与 verify 并行
  const r1 = buildFixPlan({ artifact: art, manifest: scManifest });
  ok(!r1.degraded, 'archive kind 不应致 degraded: ' + JSON.stringify(r1.reasons ?? []));
  const plan = r1.plan;
  eq(plan.waves.length, 2, 'fix 一波 + (verify+archive) 末波');
  eq(plan.waves[0].length, 1, 'wave0 仅 fix 组');
  eq(plan.waves[1].length, 2, 'wave1 verify 组与 archive 组并行（Decision 3）');
  const archGroup = plan.groups.find((gr) => gr.sc_ids.includes('SC-ARCH'));
  ok(archGroup, '必须存在 archive 组');
  eq(archGroup.paths, ['README.md'], 'archive SC 的文件域必须固定为 README.md（不从 anchor_paths 派生）');
  ok(plan.waves[1].includes(archGroup.id), 'archive 组必须在末波');
  const verifyGroup = plan.groups.find((gr) => gr.verify);
  ok(verifyGroup && plan.waves[1].includes(verifyGroup.id), 'verify 组也必须在同一末波');

  // ③ 真跑 fix-run: init → allocate wave0 → 改 a.ts → integrate → validate
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  FR.initRun({ stateDir: env.stateDir, runId: 'archA1', repoDir: env.r, plan, scManifest, sourceArtifact: art, featureBranch: 'feat' });
  const a0 = FR.allocate({ stateDir: env.stateDir, runId: 'archA1', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest });
  workGroup(env, a0.allocations[0], 'a.ts', 'fixed\n');
  const i0 = FR.integrate({ stateDir: env.stateDir, runId: 'archA1', plan, waveIndex: 0 });
  ok(i0.ok, 'wave0 应集成: ' + JSON.stringify(i0.errors ?? []));
  ok(FR.validateIntegration({ stateDir: env.stateDir, runId: 'archA1', scManifest, waveIndex: 0 }).ok, 'wave0 复跑验证应过');

  // wave1: verify 组改 e2e/x.test.ts；archive 组把残余风险文案写进 README.md（各自独立 worktree，域互不相交）
  const a1 = FR.allocate({ stateDir: env.stateDir, runId: 'archA1', plan, waveIndex: 1, worktreeRoot: env.wtRoot, artifact: art, scManifest });
  eq(a1.allocations.length, 2, 'wave1 应分配 2 个独立 worktree（verify + archive 并行）');
  const vAlloc = a1.allocations.find((x) => x.group_id === verifyGroup.id);
  const arAlloc = a1.allocations.find((x) => x.group_id === archGroup.id);
  ok(vAlloc && arAlloc, '两组分配都应存在');
  eq(arAlloc.write_paths, { mode: 'fixed-list', paths: ['README.md'] }, 'archive 组分配的 write_paths 必须是脚本给定的固定清单（mode=fixed-list），不是 isolated（SC-M1/M2）');
  workGroup(env, vAlloc, 'e2e/x.test.ts', 'test ok\n');
  // worker 在 archive worktree 里把残余风险文案写进 README——这正是 MUST-FIX-1 要打通的路径；
  // 改的是 write_paths.paths 内的 README.md，不应被 fix-run 判越域
  workGroup(env, arAlloc, 'README.md', `# Project\n\n## 残余风险\n${RESIDUAL_PHRASE}: 已知限制，登记存档\n`);
  const i1 = FR.integrate({ stateDir: env.stateDir, runId: 'archA1', plan, waveIndex: 1 });
  ok(i1.ok, 'wave1（verify+archive 并行）应集成，改 README 不得被判越域: ' + JSON.stringify(i1.errors ?? []));
  const v1 = FR.validateIntegration({ stateDir: env.stateDir, runId: 'archA1', scManifest, waveIndex: 1 });
  ok(v1.ok, 'wave1 复跑验证应过（archive 的 grep 验证也在内): ' + JSON.stringify(v1.results));
  ok(v1.results.some((x) => x.sc_id === 'SC-ARCH' && x.status === 'PASS'), 'SC-ARCH 的 grep 验证必须真通过');

  const fin = FR.finalizeRun({ stateDir: env.stateDir, runId: 'archA1' });
  ok(/^[0-9a-f]{40}$/.test(fin.final_candidate));
  eq(env.g('status', '--porcelain'), '', 'finalize 后工作区应 clean');

  // ④ push-guard 全链: 终版共识 + SKILL 字段 manifest → 应放行
  const finalBundleA1 = mkBundle(bundleA1.base_sha, fin.final_candidate);
  const finalArtA1 = consensusFor(finalBundleA1, [{}, {}, {}], { parentArtifactHash: art.consensus_artifact_hash }).artifact;
  ok(finalArtA1.gate_result === 'pass', '终版共识应达成: ' + JSON.stringify(finalArtA1.fail_reasons ?? []));
  const runManifestA1 = readJson(FR.runManifestPath(env.stateDir, 'archA1'));
  const tipFor = (groupId) => {
    for (const w of runManifestA1.waves) {
      const found = (w.tips ?? []).find((x) => x.group_id === groupId);
      if (found) return found.tip;
    }
    throw new Error(`no tip recorded for group ${groupId}`);
  };
  const dispatchRecordA1 = {
    fix_plan_hash: plan.fix_plan_hash,
    waves: plan.waves.map((waveGroupIds, wi) => ({
      dispatches: waveGroupIds.map((gid, i) => ({
        group_id: gid, worker_session_id: `w${wi}-${i}`, tip: tipFor(gid), report: 'ok', result: mkResult(plan, gid)
      }))
    }))
  };
  const foA1 = {
    source_artifact_hash: art.consensus_artifact_hash,
    sc_manifest_hash: hashObject(scManifest),
    fix_plan_hash: plan.fix_plan_hash,
    dispatch_record_hash: hashObject(dispatchRecordA1),
    run_manifest_hash: FR.runManifestHash(runManifestA1)
  };
  const pgResult = checkPushGuard({
    repoDir: env.r,
    manifest: { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: fin.final_candidate, purpose: 'feature', consensus_artifact_hash: finalArtA1.consensus_artifact_hash, fix_orchestration: foA1 },
    artifact: finalArtA1, bundle: finalBundleA1, constitution,
    sourceArtifact: art, scManifest, fixPlan: plan, dispatchRecord: dispatchRecordA1, runManifest: runManifestA1
  });
  ok(pgResult.ok, 'push-guard 全链应放行: ' + pgResult.errors.join(';'));
});

t('[SC-M3] archive 组越域: 改了非 README.md 的文件 → 必须被拒（write_paths.mode=fixed-list 强制 exact）', () => {
  // 行为断言，不只是形状断言（lead 判据：形状对了不代表约束在咬）——archive 组的 write_paths
  // 是脚本给定常量 ['README.md']，changed 集合必须是它的子集，多一个文件就是越域。
  const env = mkRunEnv({ files: ['README.md', 'other.md'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'a1', sc_ids: ['SC-ARCH'], paths: ['README.md'], archive: true }], [['a1']],
    [{ id: 'SC-ARCH', kind: 'archive', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'README.md']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'archM3', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'archM3', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  eq(a.allocations[0].write_paths, { mode: 'fixed-list', paths: ['README.md'] }, 'archive 组分配的 write_paths 必须是脚本给定的固定清单');
  workGroup(env, a.allocations[0], 'other.md', '越域改动\n');
  const integ = FR.integrate({ stateDir: env.stateDir, runId: 'archM3', plan, waveIndex: 0 });
  ok(!integ.ok && integ.errors.some((e) => /越域改动/.test(e)), 'archive 组改非 README.md 必须被拒（write_paths.mode=fixed-list 强制）: ' + JSON.stringify(integ.errors ?? []));
});

t('[R10-A2] hub 门（D1 通用可移除性判据）: 4 条 archive SC 全指向 README.md 合成 1 组，不触发 hub degraded', () => {
  const art = artifactWithFindings([
    { sev: 'major', paths: ['src/m0.ts'] },
    { sev: 'major', paths: ['src/m1.ts'] },
    { sev: 'major', paths: ['src/m2.ts'] },
    { sev: 'major', paths: ['src/m3.ts'] }
  ]);
  const id = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const scManifest = {
    schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: withScAttribution([0, 1, 2, 3].map((i) => ({
      id: `SC-ARCH-${i}`, kind: 'archive', finding_ids: [id(i)], change: 'c', holds: 'h',
      verify: VF('grep', ['-q', `RESIDUAL-${i}`, 'README.md'])
    })), art)
  };
  eq(checkScCoverage({ manifest: scManifest, artifact: art }).length, 0, '4 条 archive SC 应各恰好引用 1 条 finding 并过覆盖门');
  const r2 = buildFixPlan({ artifact: art, manifest: scManifest });
  ok(!r2.degraded, '4 条 archive SC 全指向 README.md 不应触发 hub degraded（R10-A2 核心）: ' + JSON.stringify(r2.reasons ?? []));
  eq(r2.plan.groups.length, 1, '4 条 archive SC 应合成 1 组（同域必然同组串行）');
  eq(r2.plan.groups[0].sc_ids, ['SC-ARCH-0', 'SC-ARCH-1', 'SC-ARCH-2', 'SC-ARCH-3'], '该组必须含全部 4 条 archive SC');
  eq(r2.plan.groups[0].paths, ['README.md']);
  eq(r2.plan.waves.length, 1, '无 fix/verify SC 时只有 archive 末波');
  eq(r2.plan.waves[0], [r2.plan.groups[0].id]);
});

// R10-A2'（owner 2026-08-02，复核 mivo-canvas #419 死锁后拍板换判据）: hubViolations 从
// 「路径占比」换成「可移除性」——6 个场景各自独立成一条 fixture（不合并进一个 t()），
// 使每条判据分支的红/绿在回归输出里能被逐条精确定位，不被同一 t() 内先失败的断言掩盖。
const HUB_SHARE_D1 = 0.5; // 与 config/orchestration.json 的 hub_path_max_share 一致，判据变了配置语义不变

t("[R10-A2'-1] hubViolations 场景1 R3 真 hub 污染: 8 条 fix SC 各带共享 .gitignore → 必须 degraded（原有保护不能被删）", () => {
  const s1 = Array.from({ length: 8 }, (_, i) => ({ sc_id: `s1-${i}`, paths: [`src/u${i}.ts`, '.gitignore'] }));
  const r1 = hubViolations(s1, HUB_SHARE_D1, 'fix');
  ok(r1.length > 0 && r1.some((x) => x.includes('.gitignore')), '场景1 R3 真 hub 污染必须 degraded（原有保护）: ' + JSON.stringify(r1));
});

t("[R10-A2'-2] hubViolations 场景2 单文件 PR 死锁: 3 条 fix SC 全锚同 1 文件 → 必须放行（D1 核心，mivo-canvas #419 实测）", () => {
  const s2 = Array.from({ length: 3 }, (_, i) => ({ sc_id: `s2-${i}`, paths: ['src/foo.ts'] }));
  const r2h = hubViolations(s2, HUB_SHARE_D1, 'fix');
  eq(r2h.length, 0, '场景2 单文件 PR 死锁必须放行（唯一锚点=真耦合，不是广域误报）: ' + JSON.stringify(r2h));
});

t("[R10-A2'-3] hubViolations 场景3 archive 池: 4 条 archive SC 全锚 README.md → 必须放行（D2: 通用判据自然覆盖）", () => {
  const s3 = Array.from({ length: 4 }, (_, i) => ({ sc_id: `s3-${i}`, paths: ['README.md'] }));
  const r3 = hubViolations(s3, HUB_SHARE_D1, 'archive');
  eq(r3.length, 0, '场景3 archive 池必须放行（不需要专门豁免分支）: ' + JSON.stringify(r3));
});

t("[R10-A2'-4] hubViolations 场景4 混合真耦合: 两条 [foo.ts,shared.ts] + 一条 [shared.ts] → 必须放行（第三条唯一锚点即 shared.ts）", () => {
  const s4 = [
    { sc_id: 's4-0', paths: ['foo.ts', 'shared.ts'] },
    { sc_id: 's4-1', paths: ['foo.ts', 'shared.ts'] },
    { sc_id: 's4-2', paths: ['shared.ts'] }
  ];
  const r4 = hubViolations(s4, HUB_SHARE_D1, 'fix');
  eq(r4.length, 0, '场景4 混合真耦合必须放行（s4-2 唯一锚点就是 shared.ts）: ' + JSON.stringify(r4));
});

t("[R10-A2'-5] hubViolations 场景5 混合假 hub: 4 条 SC 各带 [各自文件, shared.ts] → 必须 degraded（每条都能脱离 shared.ts 独立存在）", () => {
  const s5 = Array.from({ length: 4 }, (_, i) => ({ sc_id: `s5-${i}`, paths: [`m${i}.ts`, 'shared.ts'] }));
  const r5 = hubViolations(s5, HUB_SHARE_D1, 'fix');
  ok(r5.length > 0 && r5.some((x) => x.includes('shared.ts')), '场景5 混合假 hub 必须 degraded: ' + JSON.stringify(r5));
});

t("[R10-A2'-6] hubViolations 场景6 不到 ≥3 下限: 2 条 SC 共享同一路径 → 必须放行（原有下限保护）", () => {
  const s6 = [{ sc_id: 's6-0', paths: ['shared6.ts'] }, { sc_id: 's6-1', paths: ['shared6.ts'] }];
  const r6 = hubViolations(s6, HUB_SHARE_D1, 'fix');
  eq(r6.length, 0, '场景6 低于 ≥3 下限必须放行（原有下限保护）: ' + JSON.stringify(r6));
});


// ========== 19b. D8 选中数闸门（owner 2026-08-03 授权）==========
console.log('\n[19b] D8 选中数闸门: vitest `-t` 无匹配 exit 0 不得记 PASS');

// 历史反例（bug-doctor 批次1，四轮实测）: SC-BD1-R2-N05 的 verify 写成
// `state.test.mjs -t 时间戳归一化`，过滤词对、**文件错**（用例实际在 gate.test.mjs）。
// vitest 对 -t 无匹配 = skip 全部 + **exit 0**，于是它在 orchestrator 里记 PASS、
// digest 唯一、stdout 非空，却对交付物零约束。本闸门专治这一类。
t('[D8] 纯函数: vitest recipe 识别 + 选中数解析', () => {
  eq(FR.vitestSelectionApplies(VF('npx', ['vitest', 'run', 'x', '-t', 'Y'])), { applies: true, blocked: false }, 'vitest recipe 应适用');
  eq(FR.vitestSelectionApplies(VF('test', ['-f', 'a.ts'])).applies, false, '自包含 test recipe 不适用（坑④: 它们合法存在）');
  eq(FR.vitestSelectionApplies(VF('node', ['-e', '1'])).applies, false, '裸 node -e 不适用');
  eq(FR.vitestSelectionApplies(VF('npx', ['eslint', '.'])).applies, false, 'npx 但非 vitest 不适用');
  for (const flag of ['--reporter=dot', '--outputFile=/tmp/z', '--reporter', '--outputFile.json=/tmp/z']) {
    const r = FR.vitestSelectionApplies(VF('npx', ['vitest', 'run', 'x', flag]));
    ok(r.applies && r.blocked === true, `自带 ${flag} 必须 fail-closed（不许用自定义 reporter 关掉闸门）`);
  }
  // 选中数 = passed + failed；被 -t 过滤掉的落 pending，不算跑过
  eq(FR.readVitestSelection(JSON.stringify({ numPassedTests: 4, numFailedTests: 0, numPendingTests: 124 })), 4);
  eq(FR.readVitestSelection(JSON.stringify({ numPassedTests: 2, numFailedTests: 1, numPendingTests: 0 })), 3);
  eq(FR.readVitestSelection(JSON.stringify({ numPassedTests: 0, numFailedTests: 0, numPendingTests: 17 })), 0, '无匹配: 全 pending ⇒ 选中 0');
  eq(FR.readVitestSelection('not json'), null, '坏 json ⇒ null（调用方 fail-closed）');
  eq(FR.readVitestSelection(JSON.stringify({ numTotalTests: 5 })), null, '缺计数字段 ⇒ null');
});

t('[D8] validate 闸门: 选中 0 记 VACUOUS 阻断；测不出 fail-closed；非 vitest recipe 不误伤', () => {
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  // D7 前置: npx 类 recipe 需要主仓有 node_modules 可链入，否则先被 D7 判 UNRUNNABLE，
  // 根本走不到 D8。这里造一个空目录即可（D8 用 selectionProbe 注入，不真跑 vitest）。
  mkdirSync(join(env.r, 'node_modules'), { recursive: true });
  const V = (id) => VF('npx', ['vitest', 'run', 'a.ts', '-t', id]);
  const ids = ['D8-OK', 'D8-ZERO', 'D8-NULL', 'D8-PLAIN', 'D8-REPORTER'];
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ids, paths: ['a.ts'] }],
    [['g1']],
    [
      { id: 'D8-OK', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: V('D8-OK') },
      { id: 'D8-ZERO', kind: 'fix', finding_ids: ['f1'], change: 'c', holds: 'h', verify: V('D8-ZERO') },
      { id: 'D8-NULL', kind: 'fix', finding_ids: ['f2'], change: 'c', holds: 'h', verify: V('D8-NULL') },
      { id: 'D8-PLAIN', kind: 'fix', finding_ids: ['f3'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) },
      { id: 'D8-REPORTER', kind: 'fix', finding_ids: ['f4'], change: 'c', holds: 'h', verify: VF('npx', ['vitest', 'run', 'a.ts', '--reporter=dot']) }
    ]
  );
  FR.initRun({ stateDir: env.stateDir, runId: 'd8', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a1 = FR.allocate({ stateDir: env.stateDir, runId: 'd8', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a1.allocations[0], 'a.ts', 'fixed a\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'd8', plan, waveIndex: 0 }).ok, 'd8 wave1 应集成');

  // runner 注入让主记录一律 PASS（把「主记录成败」与「选中数闸门」两件事解耦，
  // 单独考闸门）；selectionProbe 注入模拟四种选中数形态。
  const probed = [];
  const v = FR.validateIntegration({
    stateDir: env.stateDir, runId: 'd8', scManifest: scm, waveIndex: 0,
    runner: () => 'stub stdout',
    selectionProbe: (verify) => {
      const id = verify.args[verify.args.length - 1];
      probed.push(id);
      if (id === 'D8-ZERO') return 0;
      if (id === 'D8-NULL') return null;
      return 3;
    }
  });
  const by = Object.fromEntries(v.results.map((r) => [r.sc_id, r]));

  eq(by['D8-OK'].status, 'PASS', '选中 3 ⇒ 照常 PASS');
  eq(by['D8-OK'].selection_gate, 'pass');
  eq(by['D8-OK'].selected_tests, 3, '选中数必须落进记录（可审计）');

  eq(by['D8-ZERO'].status, 'VACUOUS', '选中 0 ⇒ VACUOUS（历史缺陷 N05 的形状）');
  eq(by['D8-ZERO'].selection_gate, 'fail');
  ok(/零约束|选中 0/.test(by['D8-ZERO'].note ?? ''), 'VACUOUS 必须写清原因');

  eq(by['D8-NULL'].status, 'UNRUNNABLE', '测不出选中数 ⇒ fail-closed，不得记 PASS');
  eq(by['D8-NULL'].selection_gate, 'unmeasurable');

  eq(by['D8-PLAIN'].status, 'PASS', '非 vitest 的自包含 recipe 不得被误伤');
  eq(by['D8-PLAIN'].selection_gate, 'unmeasured');
  eq(by['D8-PLAIN'].selected_tests, null);
  ok(/T1/.test(by['D8-PLAIN'].selection_reason ?? ''), '未覆盖必须如实声明为 T1，不冒称覆盖全部');
  eq(by['D8-PLAIN'].note, undefined, 'D7-③ 契约: 正常 PASS 不得带诊断 note（覆盖边界声明走 selection_reason）');

  eq(by['D8-REPORTER'].status, 'UNRUNNABLE', '自带 --reporter ⇒ 阻断');
  eq(by['D8-REPORTER'].selection_gate, 'blocked');
  ok(!probed.includes('a.ts'), '被 blocked 的 recipe 不应再去跑探针');
  eq(probed.sort(), ['D8-NULL', 'D8-OK', 'D8-ZERO'], '只对适用且未 blocked 的 recipe 探针');

  eq(v.ok, false, '本波含 VACUOUS/UNRUNNABLE ⇒ 整波不过（与 FAIL 同等阻断）');
  // 注意: 本波不能用来证明「闸门不是恒拦」——D8-REPORTER 的 --reporter 冲突是
  // recipe 形状问题，改选中数也解不开，它永远 blocked。放行方向另起一条 fixture 验。
});

t('[D8] 反向: 选中数全 > 0 且无 reporter 冲突时闸门放行（证明不是恒拦）', () => {
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  mkdirSync(join(env.r, 'node_modules'), { recursive: true }); // 同上: D7 前置
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['D8-A', 'D8-B'], paths: ['a.ts'] }],
    [['g1']],
    [{ id: 'D8-A', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('npx', ['vitest', 'run', 'a.ts', '-t', 'D8-A']) },
     { id: 'D8-B', kind: 'fix', finding_ids: ['f1'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) }]
  );
  FR.initRun({ stateDir: env.stateDir, runId: 'd8b', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a1 = FR.allocate({ stateDir: env.stateDir, runId: 'd8b', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a1.allocations[0], 'a.ts', 'fixed a\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'd8b', plan, waveIndex: 0 }).ok);
  const v = FR.validateIntegration({
    stateDir: env.stateDir, runId: 'd8b', scManifest: scm, waveIndex: 0,
    runner: () => 'stub', selectionProbe: () => 5
  });
  eq(v.ok, true, '选中数 > 0 + 无冲突 ⇒ 放行: ' + JSON.stringify(v.results));
  eq(v.results.find((r) => r.sc_id === 'D8-A').selection_gate, 'pass');
  eq(v.results.find((r) => r.sc_id === 'D8-B').selection_gate, 'unmeasured');
  eq(v.results.find((r) => r.sc_id === 'D8-B').note, undefined, 'D7-③ 契约: 正常 PASS 不带 note');
});

// ========== 20. SC-11/SC-12/SC-13 ==========
console.log('\n[20] SC-11 anchor 广域防护 / SC-12 skill 契约 / SC-13 空转清理');

t('[SC-11] anchor_paths: 目录（无尾斜杠）拒 / 超 cap degraded / 重复拒 / tracked 校验', async () => {
  const VV = await import('../scripts/verdict-validate.mjs');
  // ① 超 cap → degraded
  const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  const vMany = mkVerdictFor('claude-adversarial', bundle, {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: many, evidence: 'e', status: 'closed' }],
    closed_finding_ids: ['F1']
  });
  ok(validateVerdict(vMany).some((e) => /上限/.test(e)), 'SC-11: 广列 25 条路径必须 degraded');
  eq(validateVerdict(vMany, { anchorPathsMax: 30 }).length, 0, '提高 cap 后应过（cap 生效证明）');
  // ② 重复路径 → 拒
  const vDup = mkVerdictFor('claude-adversarial', bundle, {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: ['src/a.ts', 'src/a.ts'], evidence: 'e', status: 'closed' }],
    closed_finding_ids: ['F1']
  });
  ok(validateVerdict(vDup).some((e) => /重复/.test(e)), '重复路径必拒');
  // ③ tracked 校验: 真 git repo 里「目录（无尾斜杠）」与「不存在文件」都必须拒
  const d = mkdtempSync(join(tmpdir(), 'trk-'));
  const r = join(d, 'repo');
  execFileSync('git', ['init', '-q', r]);
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'o@t'); g('config', 'user.name', 'o');
  mkdirSync(join(r, 'src'), { recursive: true });
  writeFileSync(join(r, 'src', 'real.ts'), 'x\n');
  g('add', '.'); g('commit', '-qm', 'base');
  const sha = g('rev-parse', 'HEAD');
  const tracked = VV.trackedPathSet({ repoDir: r, baseSha: sha, candidateSha: sha });
  ok(tracked.has('src/real.ts'), 'tracked 集合应含真实文件');
  ok(!tracked.has('src'), 'tracked 集合不含目录');
  const mkV = (paths) => ({
    ...mkVerdictFor('claude-adversarial', bundle, {
      findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: paths, evidence: 'e', status: 'closed' }],
      closed_finding_ids: ['F1']
    })
  });
  eq(validateVerdict(mkV(['src/real.ts']), { trackedPaths: tracked }).length, 0, '真实 tracked 文件应过');
  ok(validateVerdict(mkV(['src']), { trackedPaths: tracked }).some((e) => /tracked/.test(e)),
    'SC-11 核心: "src" 这类真实目录（无尾斜杠）必须被 tracked 校验拦下');
  ok(validateVerdict(mkV(['src/ghost.ts']), { trackedPaths: tracked }).some((e) => /tracked/.test(e)), '不存在文件必拒');
});

t('[SC-12] live 契约一致性: SKILL/references 与 validator/push-guard 实际要求逐字对齐', () => {
  const skill = readFileSync(join(S, '../skills/submit-pr/SKILL.md'), 'utf8');
  // schema 版本: 必须写 v2（旧版写 v1 → live reviewer 产物全 degraded）
  ok(/review-verdict\.schema\.json` \*\*v2\*\*/.test(skill), 'SKILL 必须声明 verdict schema v2');
  ok(!/schemas\/review-verdict\.schema\.json v1/.test(skill), '不得残留 v1 声明');
  // anchor_paths 填写要求必须在场（分组唯一输入）
  ok(skill.includes('anchor_paths'), 'SKILL 必须说明 anchor_paths 填写要求');
  // 旧 sc_list 协议不得残留
  ok(!/sc_hash\+sc_list/.test(skill), '不得残留 sc_hash+sc_list 旧协议');
  ok(skill.includes('sc_manifest'), 'SKILL 必须用 sc_manifest');
  // 编排链五件套 + 有状态 orchestrator 命令必须在场
  for (const k of ['run_manifest_hash', 'fix-run.mjs init', 'canonical partition', 'config/orchestration.json']) {
    ok(skill.includes(k), `SKILL 缺 ${k}`);
  }
  // SC-R3-12: R3 后的契约要素——串行重派命令、结构化 verify、manifest 驱动 cleanup、T1 降调
  for (const k of ['serial-allocate', 'serial-integrate', 'execFile(shell:false)', 'cleanup --state-dir', 'T1（防疏忽/防漂移）']) {
    ok(skill.includes(k), `SKILL 缺 R3 契约要素 ${k}`);
  }
  ok(!skill.includes('--source-candidate'), '不得残留 CLI 自报起点参数（SC-R3-10: 起点由 artifact 派生）');
  ok(!/cherry-pick 逐组叠加/.test(skill), '不得残留 cherry-pick 冒充串行重跑的旧文案（SC-R3-9）');
  // validator 实际只收 v2（与文档对齐）
  const vv = readFileSync(join(S, 'verdict-validate.mjs'), 'utf8');
  ok(/schema_version === 'v2'/.test(vv), 'validator 应只收 v2');
  // SC-R3-6: push-guard 不得再强制 legacy sc_hash/sc_list（文档≡实现）
  const pg = readFileSync(join(S, 'push-guard.mjs'), 'utf8');
  ok(!pg.includes('必须携带 sc_hash'), 'push-guard 不得再强制 legacy sc_hash/sc_list');
});

t('[R10-A4] SKILL.md 契约与实现逐字同步: 按文档描述构造的 manifest/verdict 真能过闸（不止 grep 文档）', () => {
  const skill = readFileSync(join(S, '../skills/submit-pr/SKILL.md'), 'utf8');
  // ① 文档必须点名真实机制的机器字段/kind/范围（不是只写"文档化接受"这种空话）
  ok(skill.includes('kind=archive'), 'SKILL 必须点名 kind=archive 机制');
  ok(skill.includes('hardening_coverage'), 'SKILL 必须点名机器字段 hardening_coverage');
  ok(skill.includes('README.md'), 'SKILL 必须说明 archive 的文件域是 README.md');
  ok(/"cmd":\s*"grep"/.test(skill) && skill.includes('README.md'), 'SKILL 必须给出 grep 验证配方示例');
  // 2026-08-03 终审 P1: 这行原本断言的是**旧契约**（'hub 路径门对 archive 池豁免'），
  // 而该特例分支早已被 SC-A2'/D2 删掉。更糟的是: 我修 SKILL 主句时在历史警示块里**逐字引用**
  // 了那句旧文案,于是这条 substring 断言继续为真——**我的漂移修正把这条本该抓漂移的
  // fixture 骗绿了**。终审实测: 预测「把主句反向改回豁免 → 本块必红」,实际红集 = ∅。
  // 这是第 8 类的 0-红 形态,由「断言锁的是旧契约 + 历史引文满足它」双因造成。
  // 改法: ①断当前**正向**契约; ②SKILL 历史块已改写为不含旧句(消除陷阱本身)。
  ok(skill.includes('hub 路径门对 archive 池没有特例豁免'), 'SKILL 必须说明 hub 门三池同查、archive 无特例豁免（当前契约）');
  // D2 复核 P2: 机器把阻断降级为「由人读记录」时,主流程必须写明谁读/何时读/读后动作——
  // 否则 notes 只是随 JSON 存在,T1 流程可以整体无视它,「记录」名存实亡。
  ok(skill.includes('parallelism_notes') && skill.includes('非空时 lead 必须读'), 'SKILL Phase 2c 必须定义 parallelism_notes 的消费动作（非空必读）');
  // 复核控制变异实证(2026-08-03): 只锁"非空必读"时,把后半句反写成"停止派工/进 degraded/
  // 阻断"仍全绿——契约的后半(确认后继续,不得把记录当阻断用)同样要钉,否则 fixture 全绿下
  // 流程可以改回 D2 之前的死锁。三段锚点均取 Phase 2c 消费条款内的原文。
  ok(skill.includes('在编排记录（派工说明/PR 正文任一）里写一句确认'), 'Phase 2c 必须要求读后在编排记录写确认');
  ok(skill.includes('后照常派工'), 'Phase 2c 必须写明确认后照常派工（不是停下）');
  ok(skill.includes('不改分组、不进 degraded、不阻断'), 'Phase 2c 必须写明 notes 不改分组/不进 degraded/不阻断——把记录改回阻断即违反 D2');
  ok(!skill.includes('hub 路径门对 archive 池豁免'), '不得再出现旧契约原句——哪怕作为历史引文，也会让 substring 断言失去鉴别力');
  // 「三池同查」这条**无法从 buildFixPlan 的输出观测**: archive SC 的文件域固定为单一
  // README.md，移除后余集为空，D1 判据必然放行——"查了但放行"与"豁免所以没查"输出完全相同。
  // 所以这里只锁机器真能验的那一条: hubViolations 对任何 label 行为一致（不给 archive 开后门）。
  {
    const items = [
      { sc_id: 'A-0', paths: ['README.md', 'src/a.ts'] },
      { sc_id: 'A-1', paths: ['README.md', 'src/b.ts'] },
      { sc_id: 'A-2', paths: ['README.md', 'src/c.ts'] }
    ];
    eq(hubViolations(items, 0.5, 'archive').length, 1, 'archive label 不得被特例放行');
    eq(hubViolations(items, 0.5, 'fix').length, 1, '对照: 同一组输入在 fix label 下结果相同');
    // 真 archive 形状（只有 README.md）→ 余集为空 → D1 判据放行，两个 label 同样放行
    const solo = ['A-0', 'A-1', 'A-2'].map((sc_id) => ({ sc_id, paths: ['README.md'] }));
    eq(hubViolations(solo, 0.5, 'archive').length, 0, '真 archive 形状: 余集为空 → D1 放行（不是豁免，是判据本身）');
  }
  ok(skill.includes('round===1') && skill.includes('两对抗席'), 'SKILL 必须说明覆盖率契约的机器强制范围');
  // SC-B4: 文档必须点名 checklist_version 机制与 9→10 迁移语义
  ok(skill.includes('checklist_version'), 'SKILL 必须点名机器字段 checklist_version');
  ok(skill.includes('十类'), 'SKILL 必须说明加固清单已是十类（9→10 迁移）');
  ok(skill.includes('清单版本过期需重审'), 'SKILL 必须点名版本不符的报错措辞（与缺项错误区分，D5）');
  // SC-B1: 文档必须点名 invariant/family_id 归因字段与「lead 只能复制不得自填」的约束
  ok(skill.includes('invariant') && skill.includes('family_id'), 'SKILL 必须点名机器字段 invariant/family_id');
  // D1: 文档必须区分 family_id（verdict 层本地标签）与 family_key（跨 reviewer/跨 candidate
  // 的内容派生身份）——这条界线本身是 gpt 终审阻断修复的直接原因，不能只字面提过 family_id
  // 就算数，必须同时点名 family_key 且说明两者不是一回事。
  ok(skill.includes('family_key'), 'SKILL 必须点名机器字段 family_key');
  ok(skill.includes('本地归组标签') || skill.includes('本地标签'), 'SKILL 必须说明 family_id 只是 reviewer 席内的本地标签（与 family_key 的区分）');
  ok(skill.includes('逐字复制') || skill.includes('逐字相等'), 'SKILL 必须说明 lead/SC 层只能逐字复制归因字段，不得自填');
  ok(skill.includes('family_context'), 'SKILL 必须点名派工包的 family_context 机制');
  // SC-B2: 文档必须点名 pr-body.mjs 机制与时序约束（先生成锚点段，delta review 才能开始）
  ok(skill.includes('pr-body.mjs'), 'SKILL 必须点名 pr-body.mjs 脚本');
  ok(skill.includes('review_input_hash') && skill.includes('pr_body'), 'SKILL 必须说明 pr_body 纳入 review_input_hash 的时序约束');
  ok(skill.includes('已登记接受'), 'SKILL 必须点名 ARCHIVE 措辞「已登记接受」（与「已修复」区分）');

  // ② 严格按 SKILL.md 描述的形状构造真实输入，跑真守卫——不是只 grep 文档字符串（R3 踩过的坑）
  const art = artifactWithFindings([{ sev: 'major', paths: ['src/skill-doc-check.ts'] }]);
  const fid = art.canonical_findings[0].id;
  const scManifest = {
    schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: withScAttribution([{
      id: 'SC-ARCH-1', kind: 'archive', finding_ids: [fid],
      change: '把残余风险文案写进 README.md', holds: 'README.md 含约定文案',
      verify: { cmd: 'grep', args: ['-q', '<残余风险关键文案>', 'README.md'] }
    }], art)
  };
  eq(checkScCoverage({ manifest: scManifest, artifact: art }).length, 0, '按 SKILL.md 例句构造的 archive SC 必须真过 coverage-gate');
  const r = buildFixPlan({ artifact: art, manifest: scManifest });
  ok(!r.degraded, '按 SKILL.md 例句构造的 archive SC 必须真产出可派工 plan: ' + JSON.stringify(r.reasons ?? []));
  eq(r.plan.groups[0].paths, ['README.md'], 'SKILL.md 声明的文件域必须与实现一致');

  // ③ 按 SKILL.md 描述的 hardening_coverage 形状构造 verdict，跑真 validator
  const docVerdict = mkVerdictFor('claude-adversarial', bundle, {
    hardening_coverage: Array.from({ length: HARDENING_CLASS_COUNT }, (_, i) => ({ class_id: i + 1, result: 'covered', evidence: `第${i + 1}类核对完成` }))
  });
  eq(validateVerdict(docVerdict).length, 0, '按 SKILL.md 例句构造的 hardening_coverage 必须真过 validator');
});

t('[SC-13] 血统校验用真实但不相关的 commit（非"对象不存在"空转）', () => {
  const d = mkdtempSync(join(tmpdir(), 'lin-'));
  const r = join(d, 'repo');
  execFileSync('git', ['init', '-q', r]);
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'o@t'); g('config', 'user.name', 'o');
  writeFileSync(join(r, 'a.ts'), 'base\n'); g('add', '.'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  // 真实存在但与 base 无血缘: orphan 分支上的 commit
  g('checkout', '-q', '--orphan', 'unrelated');
  writeFileSync(join(r, 'z.ts'), 'unrelated\n'); g('add', '.'); g('commit', '-qm', 'unrelated');
  const unrelated = g('rev-parse', 'HEAD');
  g('checkout', '-q', base);
  ok(unrelated !== base && /^[0-9a-f]{40}$/.test(unrelated), '前提: unrelated 是真实存在的 commit');
  // 该 commit 真实存在（rev-parse 成功）但不是 base 后代 → integrate 必拒
  eq(g('cat-file', '-t', unrelated), 'commit', 'commit 对象确实存在（不是"对象不存在"那种空转）');
  const headBefore = g('rev-parse', 'HEAD');
  const rep = ORC.integrateWave({ repoDir: r, waveBase: base, groupTips: [{ group_id: 'g1', tip: unrelated }] });
  ok(!rep.ok && rep.overlaps.some((o) => /血统/.test(o.error ?? '')), 'SC-13: 真实但不相关的 commit 必须被血统校验拒');
  eq(g('rev-parse', 'HEAD'), headBefore, '拒绝路径不得改动 HEAD');
});

// ========== 21. R3 修正专项 ==========
console.log('\n[21] SC-R3: verify argv 沙箱 / anchor hub 门 / allowed 全组 / squash 防洗历史 / 复跑绑定 / 单入口');

t('[SC-R3-4] verify 结构化 argv: 注入串按字面传参、最小环境、原始输出不落盘、坏配方拒', () => {
  // 配方校验
  ok(FR.validateVerifyRecipe('npm test') !== null, '自由文本必拒');
  ok(FR.validateVerifyRecipe({ cmd: '/bin/sh', args: ['-c', 'x'] }) !== null, '带路径 cmd 必拒');
  ok(FR.validateVerifyRecipe({ cmd: '-rf', args: [] }) !== null, '前导 - 必拒');
  ok(FR.validateVerifyRecipe({ cmd: 'npm', args: ['test'] }) === null, '合法配方应过');
  // coverage gate 拒自由文本 verify
  const art0 = artifactWithFindings([{ sev: 'major', paths: ['src/a.ts'] }]);
  const strScm = { schema_version: 'v2', consensus_artifact_hash: art0.consensus_artifact_hash,
    scs: [{ id: 'SC-0', kind: 'fix', finding_ids: [art0.canonical_findings[0].id], change: 'c', holds: 'h', verify: 'npm test && curl evil' }] };
  ok(checkScCoverage({ manifest: strScm, artifact: art0 }).some((e) => /结构化|argv/.test(e)), 'coverage gate 必拒文本 verify');
  // 真实执行: 注入串是字面参数 + 凭证类环境变量不透传 + stdout 只留 hash
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const injTarget = join(env.d, 'INJECTED');
  const secret = ['sk-', 'fixture-leak-canary'].join(''); // 运行时拼接（静态文件不含 key 形态）
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0', 'SC-1'], paths: ['a.ts'] }], [['g1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('echo', [`x; touch ${injTarget}`, secret]) },
     { id: 'SC-1', kind: 'fix', finding_ids: ['f1'], change: 'c', holds: 'h', verify: VF('node', ['-e', 'process.exit(process.env.PG_FIXTURE_SECRET ? 3 : 0)']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'rv', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rv', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a.allocations[0], 'a.ts', 'fix\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'rv', plan, waveIndex: 0 }).ok, '集成应过');
  process.env.PG_FIXTURE_SECRET = secret;
  const v = FR.validateIntegration({ stateDir: env.stateDir, runId: 'rv', scManifest: scm, waveIndex: 0 });
  delete process.env.PG_FIXTURE_SECRET;
  ok(v.ok, '两条 verify 都应 PASS（env 未透传→SC-1 exit 0）: ' + JSON.stringify(v.results));
  ok(!existsSync(injTarget), 'SC-R3-4 核心: 注入串不得被 shell 解释执行');
  const onDisk = readFileSync(FR.runManifestPath(env.stateDir, 'rv'), 'utf8');
  ok(!onDisk.includes(secret), '输出原文/凭证不得落进 run manifest（只存 sha256）');
  ok(v.results[0].stdout === undefined && typeof v.results[0].stdout_sha256 === 'string', '只存摘要 hash 不存原文');
});

// ========== D7: validate 依赖准备 + fail-closed 分类（另一会话实测的阻断洞） ==========
console.log('\n[D7] fix-run validate: 裸 worktree 软链依赖 + 候选改依赖清单 fail-closed + UNRUNNABLE 同等阻断');

t('[D7-①] 裸 worktree + 需依赖的 recipe（npx/npm 等）→ UNRUNNABLE 且阻断（确定性判据：命令语义，不猜 exit/stdout）', () => {
  const env = mkRunEnv({ files: ['a.ts'] }); // 主仓无 node_modules（坑④场景叠加①）
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }], [['g1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('npm', ['test']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'd7a', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'd7a', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a.allocations[0], 'a.ts', 'fix\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'd7a', plan, waveIndex: 0 }).ok, '集成应过');
  const v = FR.validateIntegration({ stateDir: env.stateDir, runId: 'd7a', scManifest: scm, waveIndex: 0 });
  eq(v.ok, false, 'D7 核心断言: UNRUNNABLE 必须使 ok=false（同等阻断，不是软提醒）——这是本次最该守住的一条');
  eq(v.results[0].status, 'UNRUNNABLE', 'verify.cmd=npm 且无 node_modules 时必须确定性判 UNRUNNABLE，不得真跑产出无意义的原生报错');
  ok(v.results[0].note.includes('node 工具链'), 'note 必须说明是 node 工具链缺依赖，不是猜的启发式');
  eq(v.results[0].exit_code, null, 'UNRUNNABLE 不应有 exit_code（从未真正执行）');
});

t('[D7-②] 候选改了 package.json → 不建软链（避免用主仓依赖跑候选代码产出静默错误结果）+ UNRUNNABLE 且原因点名依赖清单文件', () => {
  const env = mkRunEnv({ files: ['a.ts', 'package.json'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  // 主仓有 node_modules（本该可以软链，若不是候选改了依赖清单）
  mkdirSync(join(env.r, 'node_modules'), { recursive: true });
  writeFileSync(join(env.r, 'node_modules', '.marker'), 'present\n');
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['package.json'] }], [['g1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'package.json']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'd7b', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'd7b', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a.allocations[0], 'package.json', '{"name":"changed-by-candidate"}\n'); // 候选改了依赖清单
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'd7b', plan, waveIndex: 0 }).ok, '集成应过');
  const v = FR.validateIntegration({ stateDir: env.stateDir, runId: 'd7b', scManifest: scm, waveIndex: 0 });
  eq(v.ok, false, 'D7 核心断言: 候选改依赖清单时必须阻断（UNRUNNABLE 同等阻断）');
  eq(v.results[0].status, 'UNRUNNABLE');
  ok(v.results[0].note.includes('package.json'), '原因必须点名具体是哪个依赖清单文件');
  ok(v.results[0].note.includes('fail-closed'), '原因必须说明是主动跳过（fail-closed），不是环境本身坏了');
  // 不得建软链——否则就是用主仓依赖集跑了候选代码，产出的是静默错误结果
  const runM = readJson(FR.runManifestPath(env.stateDir, 'd7b'));
  const integWt = runM.integration_worktree.path;
  ok(!existsSync(join(integWt, 'node_modules')), 'D7 fail-closed 核心: 候选改了依赖清单时绝不能建软链');
});

t('[D7-③] 自包含 recipe（不依赖 node 工具链）在主仓无 node_modules 时 → 正常 PASS（守住坑④：主仓无依赖不是错误）', () => {
  const env = mkRunEnv({ files: ['a.ts'] }); // 主仓无 node_modules
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }], [['g1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) }]); // 自包含：纯 shell test，不需要项目依赖
  FR.initRun({ stateDir: env.stateDir, runId: 'd7c', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'd7c', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a.allocations[0], 'a.ts', 'fix\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'd7c', plan, waveIndex: 0 }).ok, '集成应过');
  const v = FR.validateIntegration({ stateDir: env.stateDir, runId: 'd7c', scManifest: scm, waveIndex: 0 });
  ok(v.ok, 'D7 坑④核心: 主仓没有 node_modules 本身不是错误，自包含 recipe 必须正常 PASS: ' + JSON.stringify(v.results));
  eq(v.results[0].status, 'PASS');
  ok(!v.results[0].note, '正常 PASS 不应带诊断 note');
});

t('[D7-④] 主仓有 node_modules、候选未改依赖清单 → 真软链，需依赖的 recipe 借软链真正跑通（不只是安全网，是修复本身）', () => {
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  mkdirSync(join(env.r, 'node_modules'), { recursive: true });
  writeFileSync(join(env.r, 'node_modules', '.marker'), 'present\n');
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }], [['g1']],
    // recipe 本身不在 DEP_TOOLCHAIN_CMDS 里（用 test 而不是 npm，避免撞上①的确定性分类），
    // 但真实依赖 node_modules 是否存在——只有软链生效这条才能过。
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-e', 'node_modules/.marker']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'd7d', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'd7d', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a.allocations[0], 'a.ts', 'fix\n'); // 未触碰依赖清单
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'd7d', plan, waveIndex: 0 }).ok, '集成应过');
  const v = FR.validateIntegration({ stateDir: env.stateDir, runId: 'd7d', scManifest: scm, waveIndex: 0 });
  ok(v.ok, 'D7 修复本身核心: 软链生效后，需要 node_modules 的 recipe 必须真正跑通: ' + JSON.stringify(v.results));
  eq(v.results[0].status, 'PASS');
  const runM = readJson(FR.runManifestPath(env.stateDir, 'd7d'));
  ok(existsSync(join(runM.integration_worktree.path, 'node_modules', '.marker')), '软链必须真的生效（穿透可见主仓 node_modules 内容）');
});

t('[R2-F2] 跨波: wave1 建的软链不得让 wave2「改了依赖清单」被归成 runnable（gpt 复审 finding 2，P1）', () => {
  // integration worktree 是 run 级跨波复用，波间只 `git checkout --detach`——不清 untracked，
  // 所以 wave1 建的 node_modules 软链原地活到 wave2。旧实现把「wtModules 已存在」的早返回
  // 放在依赖清单 diff **之前**，于是 wave2 即便改了 package.json 也走不到清单检查，
  // 被归成 runnable，然后在**旧依赖**下跑出 PASS。阻断谓词没错，是分类前提被短路。
  const env = mkRunEnv({ files: ['a.ts', 'package.json'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  mkdirSync(join(env.r, 'node_modules'), { recursive: true });
  writeFileSync(join(env.r, 'node_modules', '.marker'), 'present\n');
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }, { id: 'g2', sc_ids: ['SC-1'], paths: ['package.json'] }],
    [['g1'], ['g2']],
    [
      { id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) },
      { id: 'SC-1', kind: 'fix', finding_ids: ['f1'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'package.json']) }
    ]);
  FR.initRun({ stateDir: env.stateDir, runId: 'r2f2', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });

  // ---- wave 1: 不碰依赖清单 → 应建软链并 PASS ----
  const a1 = FR.allocate({ stateDir: env.stateDir, runId: 'r2f2', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a1.allocations[0], 'a.ts', 'fixed a\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'r2f2', plan, waveIndex: 0 }).ok, 'wave1 集成应过');
  const v1 = FR.validateIntegration({ stateDir: env.stateDir, runId: 'r2f2', scManifest: scm, waveIndex: 0 });
  ok(v1.ok, 'wave1 应 PASS: ' + JSON.stringify(v1.results));
  const integWt = readJson(FR.runManifestPath(env.stateDir, 'r2f2')).integration_worktree.path;
  const wtModules = join(integWt, 'node_modules');
  ok(lstatSync(wtModules).isSymbolicLink(), '前提: wave1 确实建了软链（这条软链就是 wave2 的旁路来源）');

  // ---- wave 2: 改依赖清单，而 wave1 的软链还在 ----
  const a2 = FR.allocate({ stateDir: env.stateDir, runId: 'r2f2', plan, waveIndex: 1, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a2.allocations[0], 'package.json', '{"name":"changed-by-wave2"}\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'r2f2', plan, waveIndex: 1 }).ok, 'wave2 集成应过');
  ok(lstatSync(wtModules).isSymbolicLink(), '前提: 波间 checkout --detach 不清 untracked，软链仍在（旁路成立的必要条件）');
  const v2 = FR.validateIntegration({ stateDir: env.stateDir, runId: 'r2f2', scManifest: scm, waveIndex: 1 });
  eq(v2.ok, false, 'R2-F2 核心断言: 已有软链不得让「候选改了依赖清单」被放行（旧实现此处 ok=true）');
  eq(v2.results[0].status, 'UNRUNNABLE', '必须归 UNRUNNABLE，不是 PASS/FAIL——依赖与候选不一致，结果无意义');
  ok(v2.results[0].note.includes('package.json'), 'reason 必须点名具体哪个依赖清单文件');
  ok(v2.results[0].note.includes('残留'), 'reason 必须说明有前一波留下的 node_modules 残留（区别于裸 worktree 那条路径）');
  ok(lstatSync(wtModules).isSymbolicLink(), '不得删除已有 node_modules——已阻断，删了不多买一分安全，误删真实依赖不可逆');
  // 阻断必须一路传到 finalize，不能只停在 validate（finalizeRun 的契约是**抛错**，不是返回 ok:false）
  let finThrew = null;
  try { FR.finalizeRun({ stateDir: env.stateDir, runId: 'r2f2' }); } catch (e) { finThrew = e.message; }
  ok(finThrew && /未通过 orchestrator 复跑验证/.test(finThrew), 'finalizeRun 必须拒绝（validation.ok !== true → 抛错）: ' + finThrew);
});

t('[R2-F2] changedFiles 抛错时归 UNRUNNABLE，不归 runnable（算不出实改集就不敢判「依赖没变」）', () => {
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(join(env.r, 'node_modules'), { recursive: true });
  const wt = join(env.d, 'bare-wt');
  mkdirSync(wt, { recursive: true });
  const r = FR.prepareDependencies({ repoDir: env.r, wt, sourceCandidate: 'd'.repeat(40), integratedTip: env.cand });
  eq(r.unrunnable, true, '实改集算不出来必须 fail-closed 判 UNRUNNABLE');
  ok(/实改集|fail-closed/.test(r.reason ?? ''), 'reason 必须说明是算不出实改集，不是依赖清单变了');
  ok(!existsSync(join(wt, 'node_modules')), '算不出来时不得建软链');
});

t('[SC-R3-5/D2] anchor hub: 共享 hub 把 8 组并成 1 组 → 产出 plan 但如实记录 7 组并行度损失（不再阻断）；changed-set 拦 tracked-but-unchanged', () => {
  // hub 检测（R3 反例复刻: 8 条 finding 各带共享 .gitignore + 独立文件）
  const specs = Array.from({ length: 8 }, (_, i) => ({ sev: 'major', paths: ['.gitignore', `src/u${i}.ts`] }));
  const art = artifactWithFindings(specs);
  const fid = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const scm = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: specs.map((_, i) => ({ id: `SC-${i}`, kind: 'fix', finding_ids: [fid(i)], change: 'c', holds: 'h', verify: VF() })) };
  const r = buildFixPlan({ artifact: art, manifest: scm });
  // D2（2026-08-02 重定）: 并行度不是正确性属性——hub 命中不再阻断产出 plan。
  // 旧断言是 `r.degraded === true`，那把「跑得不够并行」当成了「计划有缺陷」，
  // 在 mivo-canvas 上两次把正当交付整个卡死（13 条缺陷真在同一模块里，三条出路全是伪造）。
  eq(r.degraded, false, 'D2: hub 命中不得阻断产出 plan: ' + JSON.stringify(r.reasons ?? []));
  ok(Array.isArray(r.plan.parallelism_notes) && r.plan.parallelism_notes.length > 0, 'D2: hub 事实必须落进 plan.parallelism_notes');
  ok(r.plan.parallelism_notes.some((x) => /hub 路径 \.gitignore/.test(x)), 'note 必须点名具体 hub 路径');
  // 关键: note 必须给出**联合**度量的真实损失(1 → 8 = 7 组)，不是只报占比。
  // 占比只是代理指标，分组数才是它宣称的那个量。
  ok(r.plan.parallelism_notes.some((x) => /分组数会从 1 增到 8（并行度损失 7 组）/.test(x)), 'note 必须如实给出联合度量的损失量: ' + JSON.stringify(r.plan.parallelism_notes));
  ok(r.plan.parallelism_notes.some((x) => /记录，不阻断/.test(x)), 'note 必须自陈是记录而非阻断，不许读起来像错误');

  // 对照: 去掉 hub → 8 组全并行
  const specs2 = Array.from({ length: 8 }, (_, i) => ({ sev: 'major', paths: [`src/u${i}.ts`] }));
  const art2 = artifactWithFindings(specs2);
  const fid2 = (i) => art2.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const scm2 = { schema_version: 'v2', consensus_artifact_hash: art2.consensus_artifact_hash,
    scs: specs2.map((_, i) => ({ id: `SC-${i}`, kind: 'fix', finding_ids: [fid2(i)], change: 'c', holds: 'h', verify: VF() })) };
  const r2 = buildFixPlan({ artifact: art2, manifest: scm2 });
  ok(!r2.degraded, JSON.stringify(r2.reasons ?? []));
  eq(r2.plan.waves[0].length, 8, '无 hub → 8 组全并行（owner 目标: 拉满也可以）');
  eq(r2.plan.parallelism_notes, [], '无 hub 命中时 notes 必须是空数组（形状稳定，hash 才确定）');
  // changed-set 层: anchor 指向 tracked-but-unchanged 文件 → 拒（validator）
  const chg = new Set(['src/changed.ts']);
  const mkV2 = (paths) => mkVerdictFor('claude-adversarial', bundle, { findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: paths, evidence: 'e', status: 'closed' }], closed_finding_ids: ['F1'] });
  eq(validateVerdict(mkV2(['src/changed.ts']), { changedPaths: chg }).length, 0, '实改文件应过');
  ok(validateVerdict(mkV2(['.gitignore']), { changedPaths: chg }).some((e) => /实改文件集/.test(e)), 'SC-R3-5: 锚点不在被审 diff 上必拒');
});

t('[D2-冗余连接对] 逐路径「移除后是否增加分组数」在 source+test 成对时恒为 0 → 那个判据会 fail-open；联合度量看得见 4× 损失', () => {
  // 这条钉住的是**为什么不采纳**跨会话提案方的判据（逐路径 after > before）。
  // 4 条 SC 各含 [a.mjs, a.test.mjs, xN.mjs]：真实可并行度 4，被这对冗余连接压成 1 组。
  const items = Array.from({ length: 4 }, (_, i) => ({ sc_id: `SC-${i}`, paths: ['a.mjs', 'a.test.mjs', `x${i}.mjs`] }));
  eq(FP.groupByConflict(items).length, 1, '前提: 冗余连接对把 4 组压成 1 组');
  // 逐路径探测: 移除任一条，另一条仍连着全部 → 分组数不变 → 「不是串行化成因」→ 放行
  for (const p of ['a.mjs', 'a.test.mjs']) {
    eq(FP.groupCountIgnoring(items, new Set([p])), 1, `逐路径判据在 ${p} 上看不到损失（这正是它 fail-open 的原因）`);
  }
  // 联合度量: 两条一起移除 → 4 组。损失真实存在，只是不由任何**单条**路径引起。
  eq(FP.groupCountIgnoring(items, new Set(['a.mjs', 'a.test.mjs'])), 4, '联合度量必须看见 4× 损失');
  // 报文必须用**联合**度量: 这个形状下逐路径度量恒为「不是成因」，联合度量才报出损失。
  // 少了这条断言，把报文的度量改回逐路径会红 0——门读起来在度量损失，实际度量的是别的东西。
  const notes = hubViolations(items, 0.5, 'fix');
  eq(notes.length, 2, '两条 hub 路径都应被记录');
  ok(notes.every((x) => /分组数会从 1 增到 4（并行度损失 3 组）/.test(x)), '报文必须给出联合度量的损失，不得逐路径算成「不是成因」: ' + JSON.stringify(notes));
});

t('[D2] groupCountIgnoring: 余集为空的 SC 各算独立一组,不得丢弃', () => {
  // 独立成块: 「联合度量」与「空余集计数」是两条判定。合在一块时「度量改回逐路径」和
  // 「丢弃空余集」会红同一个块,分辨不出是哪条在起作用。
  // 丢弃空余集会低估分组数,把并行度损失算小——门于是少报损失,读起来像"没那么严重"。
  const allShared = [{ sc_id: 'S1', paths: ['h.mjs'] }, { sc_id: 'S2', paths: ['h.mjs'] }, { sc_id: 'S3', paths: ['h.mjs'] }];
  eq(FP.groupCountIgnoring(allShared, new Set(['h.mjs'])), 3, '余集为空的 SC 各算独立一组（不再与任何人冲突 = 可自由并行）');
  eq(FP.groupByConflict(allShared).length, 1, '对照: 未忽略时它们本是 1 组');
});

t('[D2] parallelism_notes 必须参与 fix_plan_hash（正常链路下删改 notes 会被重算检出；不防同 UID 改脚本）', () => {
  // 独立成块（不并进 SC-R3-5/D2）: 「不阻断」与「notes 入 hash」是两条判定，
  // 合在一块时「改回阻断」和「把 notes 移出 hash」会红同一个块，分辨不出是哪条在起作用。
  const specs = Array.from({ length: 8 }, (_, i) => ({ sev: 'major', paths: ['.gitignore', `src/u${i}.ts`] }));
  const art = artifactWithFindings(specs);
  const fid = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const scm = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: specs.map((_, i) => ({ id: `SC-${i}`, kind: 'fix', finding_ids: [fid(i)], change: 'c', holds: 'h', verify: VF() })) };
  const r = buildFixPlan({ artifact: art, manifest: scm });
  ok(!r.degraded && r.plan.parallelism_notes.length > 0, '前提: 本场景应产出带 notes 的 plan');
  const stripped = { ...r.plan, parallelism_notes: [] };
  ok(computeFixPlanHash(stripped) !== r.plan.fix_plan_hash, 'D2: 摘掉 notes 必须让 fix_plan_hash 变化（push-guard 重算即对不上）');
});

t('[SC-R3-7] write_paths 对 verify 组同样强制（else-if 旁路已修）', () => {
  const env = mkRunEnv({ files: ['e2e/x.test.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'v1', sc_ids: ['SC-V'], paths: ['e2e/x.test.ts'], verify: true }], [['v1']],
    [{ id: 'SC-V', kind: 'verify', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'e2e/x.test.ts']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'rV7', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rV7', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  // verify worker 改 write_paths 之外的测试文件（旧 else-if 只查"像测试路径"→ 放行 = R3 输入 A）
  workGroup(env, a.allocations[0], 'sneaky.spec.ts', 'not allowed\n');
  const r = FR.integrate({ stateDir: env.stateDir, runId: 'rV7', plan, waveIndex: 0 });
  ok(!r.ok && r.errors.some((e) => /越域改动/.test(e)), 'SC-R3-7: verify 组越 write_paths 改测试文件必拒');
});

t('[SC-R3-8] 洗历史: 中间 commit 藏密钥再恢复（net diff 干净）→ squash 后最终历史无处容身', () => {
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }], [['g1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'rL', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rL', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  const wt = a.allocations[0].worktree;
  const laundered = ['LAUNDERED_', 'SECRET_TOKEN'].join('');
  // commit1: 越域写入密钥文件; commit2: 删掉它 + 改 allowed 文件 → net diff 只剩 a.ts（R3 输入 B）
  writeFileSync(join(wt, 'oops.key'), laundered + '\n');
  execFileSync('git', ['-C', wt, 'add', '.'], { encoding: 'utf8' });
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'c1'], { encoding: 'utf8' });
  rmSync(join(wt, 'oops.key'));
  writeFileSync(join(wt, 'a.ts'), 'fixed\n');
  execFileSync('git', ['-C', wt, 'add', '-A'], { encoding: 'utf8' });
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'c2'], { encoding: 'utf8' });
  const r = FR.integrate({ stateDir: env.stateDir, runId: 'rL', plan, waveIndex: 0 });
  ok(r.ok, 'net diff ⊆ allowed → 集成放行: ' + JSON.stringify(r.errors ?? []));
  // v1（merge 保留 worker commits）时密钥躺在最终历史里随 push 出境; squash 后链上只有最终树
  const log = env.g('log', '-p', `${env.cand}..${r.integrated_tip}`);
  ok(!log.includes(laundered), 'SC-R3-8 核心: 洗历史的中间 commit 不得进最终历史');
  eq(env.g('rev-list', `${env.cand}..${r.integrated_tip}`).split('\n').filter(Boolean).length, 1, '最终链只有 squash');
});

t('[SC-R3-3] 复跑绑定: 空/换/漏项 sc-manifest 不得造 vacuous PASS', () => {
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }], [['g1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'rM', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rM', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a.allocations[0], 'a.ts', 'fix\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'rM', plan, waveIndex: 0 }).ok);
  // 空 manifest（R3 反例: 循环零次 every=true）→ 必 throw
  let threw = false;
  try { FR.validateIntegration({ stateDir: env.stateDir, runId: 'rM', scManifest: { scs: [] }, waveIndex: 0 }); }
  catch (e) { threw = /sc_manifest_hash 不符/.test(e.message); }
  ok(threw, 'SC-R3-3: 空/换 manifest 必拒（vacuous PASS 被拦）');
  // init 时就绑漏项 manifest → validate 报缺本波 SC（不是静默跳过）
  const scmMiss = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: [{ id: 'SC-OTHER', kind: 'fix', finding_ids: ['fx'], change: 'c', holds: 'h', verify: VF() }] };
  FR.initRun({ stateDir: env.stateDir, runId: 'rM2', repoDir: env.r, plan, scManifest: scmMiss, sourceArtifact: art, featureBranch: null });
  const a2 = FR.allocate({ stateDir: env.stateDir, runId: 'rM2', plan, waveIndex: 0, worktreeRoot: join(env.d, 'wt2'), artifact: art, scManifest: scmMiss });
  workGroup(env, a2.allocations[0], 'a.ts', 'fix2\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'rM2', plan, waveIndex: 0 }).ok);
  threw = false;
  try { FR.validateIntegration({ stateDir: env.stateDir, runId: 'rM2', scManifest: scmMiss, waveIndex: 0 }); }
  catch (e) { threw = /缺本波 SC/.test(e.message); }
  ok(threw, 'SC-R3-3: 绑定的 manifest 漏本波 SC → 必拒（exact 全覆盖）');
});

t('[SC-R3-11] 单入口: fix-orchestrate 独立 CLI 已删（直跑非零退出并指向 fix-run）', () => {
  let code = 0, out = '';
  try { execFileSync('node', [join(S, 'fix-orchestrate.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { code = e.status ?? 1; out = String(e.stderr ?? '') + String(e.stdout ?? ''); }
  ok(code !== 0, 'fix-orchestrate 直跑必须非零退出');
  ok(/单入口|fix-run/.test(out), '错误信息应指向 fix-run 单入口: ' + out.slice(0, 120));
});

// ========== 22. R4 修正专项 ==========
console.log('\n[22] R4: cleanup integration 归属 / consensus changed-set / replan 不可逆 / finalize CAS');

t('[R4-P0/R5-P0] cleanup 归属 = 创建印记而非内容相等: 撞值 HEAD/同名分支/伪造记录全拒', () => {
  const d = mkdtempSync(join(tmpdir(), 'r4p0-'));
  const r = join(d, 'repo');
  execFileSync('git', ['init', '-q', r]);
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'o@t'); g('config', 'user.name', 'o');
  writeFileSync(join(r, 'f.ts'), 'x\n'); g('add', '.'); g('commit', '-qm', 'base');
  const cand = g('rev-parse', 'HEAD');
  const wtRoot = join(d, 'wt'); mkdirSync(wtRoot);
  // R5-P0 反例: 他人 detached worktree 在预测路径上，HEAD **恰好 == source_candidate**
  // （内容相等撞值——R4 版的 knownHeads 会放行并删掉）
  const predicted = join(wtRoot, 'runX-integration');
  g('worktree', 'add', '-q', '--detach', predicted, cand);
  const sentinel = join(predicted, 'UNSAVED.txt');
  writeFileSync(sentinel, '他人未提交数据\n');
  // 同名他人分支，tip 也 == source_candidate（同样撞值）
  g('branch', 'fix/runX/integration', cand);
  // ① manifest 无 integration_worktree 记录 → 本 run 从未创建 → 一个字都不碰
  const manifest = { repo_dir: r, run_id: 'runX', source_candidate: cand, integration_branch: 'fix/runX/integration',
    waves: [{ worktree_root: wtRoot, base: cand, allocations: [], tips: null, integrated_tip: null }] };
  const res = ORC.cleanupRun({ manifest });
  ok(existsSync(sentinel), 'R5-P0 核心①: 无创建记录 = 不碰预测路径（HEAD 撞值也无关）');
  ok(!res.steps.some((s) => s.startsWith('wt-removed')), '不得移除任何 worktree: ' + JSON.stringify(res.steps));
  eq(g('rev-parse', 'refs/heads/fix/runX/integration'), cand, '同名他人分支必须原封不动');
  ok(res.errors.some((e) => /拒绝删除分支.*integration|≠ 记录的 integrated_tip|无记录/.test(e)) || res.steps.includes('br-refused:integration'),
    'integration 分支无记录 tip 必须拒删: ' + JSON.stringify(res));
  // ② 伪造 integration_worktree 记录（nonce 对不上他人 worktree 的 owner 印记）→ 拒
  const manifest1b = { ...manifest, integration_worktree: { path: predicted, nonce: 'deadbeef'.repeat(4) } };
  const res1b = ORC.cleanupRun({ manifest: manifest1b });
  ok(existsSync(sentinel), 'R5-P0 核心②: 伪造记录 nonce 印记不符必拒');
  ok(res1b.errors.some((e) => /owner 印记缺失\/不匹配/.test(e)), JSON.stringify(res1b.errors));
  // ③ worktree 缺席 + 同名他人分支 tip 撞值 == 记录之外的任意点 → 无记录 tip 拒删
  g('branch', 'fix/runX/g1', cand); // 撞值: tip == 本 run 的 base/source_candidate
  const manifest2 = { repo_dir: r, run_id: 'runX', source_candidate: cand, integration_branch: null,
    waves: [{ worktree_root: wtRoot, base: cand, tips: null, allocations: [{ group_id: 'g1', worktree: join(wtRoot, 'runX-g1'), branch: 'fix/runX/g1', base: cand, owner_nonce: 'x'.repeat(32) }] }] };
  const res2 = ORC.cleanupRun({ manifest: manifest2 });
  ok(res2.errors.some((e) => /无记录 tip|归属无法确认/.test(e)), 'worktree 缺席且无记录 tip 必拒删（撞值 tip 不放行）: ' + JSON.stringify(res2.errors));
  eq(g('rev-parse', 'refs/heads/fix/runX/g1'), cand, '他人分支原封不动');
  // ④ 有记录 tip 但分支被移动 → CAS 拒；tip 完全一致 → CAS 删除成功
  writeFileSync(join(r, 'f.ts'), 'w\n'); g('add', '.'); g('commit', '-qm', 'w');
  const recTip = g('rev-parse', 'HEAD');
  g('checkout', '-q', cand);
  g('branch', '-f', 'fix/runX/g1', recTip);
  const manifest3 = { ...manifest2, waves: [{ ...manifest2.waves[0], tips: [{ group_id: 'g1', tip: cand }] }] }; // 记录 ≠ 实际
  const res3 = ORC.cleanupRun({ manifest: manifest3 });
  ok(res3.errors.some((e) => /≠ 记录/.test(e)), '记录 tip 不匹配必拒: ' + JSON.stringify(res3.errors));
  const manifest4 = { ...manifest2, waves: [{ ...manifest2.waves[0], tips: [{ group_id: 'g1', tip: recTip }] }] };
  const res4 = ORC.cleanupRun({ manifest: manifest4 });
  ok(res4.steps.includes('br-deleted:g1'), 'tip 一致时 CAS 删除成功: ' + JSON.stringify(res4));
});

t('[D8-3] delta 轮漏传 parent 必拒；首轮无 parent 必须仍放行', () => {
  const D2 = [{ round: 2 }, { round: 2 }, { round: 2 }];
  // ① round>=2 且完全不传 parent → 必拒。SC-3 原本只校验「传了但传错源」（见 fixture
  // 「SC-3: 同 base 错源必拒」；此处不写行号——行号会随插行漂移，D8-3 已让上一版漂过一次），
  // **漏传**却静默出 pass artifact（parent_artifact_hash: null），谱系门对最常见的漏参路径失效。
  const delta = consensusFor(bundle, D2).artifact;
  ok(delta.gate_result === 'fail' && delta.fail_reasons.some((e) => /delta 轮|parent/.test(e)),
    'D8-3: delta 轮漏传 parent 必须 fail-closed: ' + JSON.stringify(delta.fail_reasons ?? []));
  // ② 首轮无 parent 必须放行——守住「别把新门开成误拦首轮」这个坑（首轮本就没有上一轮）。
  const first = consensusFor(bundle).artifact;
  eq(first.gate_result, 'pass', '首轮无 parent 必须放行: ' + JSON.stringify(first.fail_reasons ?? []));
  eq(first.parent_artifact_hash, null, '首轮 parent_artifact_hash 记 null');
  // ③ delta 轮带上 parent → 放行，且 exact 谱系落进 artifact
  const bound = consensusFor(bundle, D2, { parentArtifactHash: first.consensus_artifact_hash }).artifact;
  eq(bound.gate_result, 'pass', 'delta 轮带 parent 必须放行: ' + JSON.stringify(bound.fail_reasons ?? []));
  eq(bound.parent_artifact_hash, first.consensus_artifact_hash, 'delta 轮必须记录 exact parent');
});

// 独立成块（不并进上面）: 上面钉的是「delta 轮要 parent」，这里钉的是「用 max 而非首席 round」。
// 两条判定合在一个 t() 里，删整道门和把 max 换成 verdicts[0].round 会红同一个块——
// 变异红集无法分辨是哪条判定在起作用（第 8 类）。拆开后前者红 2 块、后者红 1 块。
t('[D8-3] 三席 round 不一致时按最大值要求 parent（不得因不一致而 fail-open）', () => {
  // 「三席 round 必须一致」是另一条不变量，本轮不在范围内；此处只钉住不一致时的方向。
  const mixed = consensusFor(bundle, [{ round: 1 }, { round: 2 }, { round: 1 }]).artifact;
  ok(mixed.gate_result === 'fail' && mixed.fail_reasons.some((e) => /delta 轮/.test(e)),
    'D8-3: 混合 round 取最大值 → 仍要求 parent: ' + JSON.stringify(mixed.fail_reasons ?? []));
});

t('[R5-P1] runConsensusGate 缺实改集 fail-closed；[R5-P2] crash 窗口凭创建印记仍可回收', () => {
  // R5-P1a: 核心 API 缺 changedPaths/repoDir → 不产 pass artifact（调用方漏传 = T1 该拦的疏忽）
  const vs0 = [
    mkVerdictFor('claude-adversarial', bundle),
    mkVerdictFor('codex-adversarial', bundle),
    mkVerdictFor('upstream-preview', bundle)
  ];
  const r0 = runConsensusGate(vs0, { bundle });
  ok(r0.gate_result === 'fail' && r0.fail_reasons.some((e) => /实改集/.test(e)),
    'R5-P1: 缺实改集必须 fail-closed: ' + JSON.stringify(r0.fail_reasons ?? []));
  // R5-P2: integrate 完成但 tips/integrated_tip 未落盘（crash 窗口）→ cleanup 凭 owner 印记仍可回收
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }], [['g1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'rz', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rz', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a.allocations[0], 'a.ts', 'fix\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'rz', plan, waveIndex: 0 }).ok);
  // 模拟 crash: 抹掉 tips/integrated_tip（但 integration_worktree 创建记录在 ensure 时已先落盘）
  const mPath = FR.runManifestPath(env.stateDir, 'rz');
  const crashed = readJson(mPath);
  ok(crashed.integration_worktree?.nonce, '前提: 创建记录已在 integrate 早期落盘');
  crashed.waves[0].tips = null;
  crashed.waves[0].integrated_tip = null;
  crashed.waves[0].squash_commits = null;
  const res = ORC.cleanupRun({ manifest: crashed });
  ok(res.steps.includes('wt-removed:integration'), 'R5-P2: crash 窗口的 integration worktree 凭印记回收: ' + JSON.stringify(res.steps));
  ok(res.steps.includes('wt-removed:g1'), '组 worktree 同样凭印记回收（tips 未落盘不影响）');
  ok(!existsSync(a.allocations[0].worktree), '组 worktree 已删');
});

t('[R5-P1] finalize: feature branch 在其他 worktree 检出 → 拒（update-ref 不得绕过检出保护）', () => {
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }], [['g1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'rw', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rw', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a.allocations[0], 'a.ts', 'fix\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'rw', plan, waveIndex: 0 }).ok);
  ok(FR.validateIntegration({ stateDir: env.stateDir, runId: 'rw', scManifest: scm, waveIndex: 0 }).ok);
  // 主 checkout 切走（走 update-ref 路径），feat 检出在另一个 worktree（clean、基线 = 起点）
  env.g('checkout', '-qb', 'elsewhere');
  const otherWt = join(env.d, 'other-wt');
  env.g('worktree', 'add', '-q', otherWt, 'feat');
  let threw = false;
  try { FR.finalizeRun({ stateDir: env.stateDir, runId: 'rw' }); }
  catch (e) { threw = /worktree 检出.*拒绝前推|检出保护/.test(e.message); }
  ok(threw, 'R5-P1 核心: feat 在他处检出时 update-ref 必拒');
  eq(execFileSync('git', ['-C', otherWt, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', '他处 worktree 基线不得被污染');
  // 取消检出后 → CAS 前推成功
  env.g('worktree', 'remove', '--force', otherWt);
  const fin = FR.finalizeRun({ stateDir: env.stateDir, runId: 'rw' });
  eq(env.g('rev-parse', 'refs/heads/feat'), fin.final_candidate);
});

t('[R4-P1] consensus 入口自算 changed-set: tracked-but-unchanged hub 在 runConsensusGate 就被拦', () => {
  // 真 git 仓: candidate 只改 u1.ts；finding 锚 u1.ts + 未实改的 hub.ts
  const d = mkdtempSync(join(tmpdir(), 'r4cs-'));
  const r = join(d, 'repo');
  execFileSync('git', ['init', '-q', r]);
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'o@t'); g('config', 'user.name', 'o');
  writeFileSync(join(r, 'u1.ts'), 'base\n'); writeFileSync(join(r, 'hub.ts'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');
  const b0 = g('rev-parse', 'HEAD');
  writeFileSync(join(r, 'u1.ts'), 'changed\n'); g('add', '.'); g('commit', '-qm', 'change u1');
  const c0 = g('rev-parse', 'HEAD');
  const bnd = mkBundle(b0, c0);
  const mkVs = (paths) => [
    mkVerdictFor('claude-adversarial', bnd, { findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: paths, evidence: 'e1', status: 'closed' }], closed_finding_ids: ['F1'] }),
    mkVerdictFor('codex-adversarial', bnd, { findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: paths, evidence: 'e1', status: 'closed' }], closed_finding_ids: ['F1'] }),
    mkVerdictFor('upstream-preview', bnd)
  ];
  // 带未实改 hub → 入口 fail（R4 反例: 旧实现 consensusFor 不传 changedPaths 照过）
  const bad = runConsensusGate(mkVs(['u1.ts', 'hub.ts']), { bundle: bnd, repoDir: r });
  ok(bad.gate_result === 'fail' && bad.fail_reasons.some((e) => /实改文件集/.test(e)),
    'R4-P1 核心: live 共识入口必须拦 tracked-but-unchanged 锚点: ' + JSON.stringify(bad.fail_reasons));
  // 只锚实改文件 → pass
  const good = runConsensusGate(mkVs(['u1.ts']), { bundle: bnd, repoDir: r });
  eq(good.gate_result, 'pass', JSON.stringify(good.fail_reasons ?? []));
});

t('[R4-P1] replan 状态不可被 allocate 重放清除（串行重派不可逆）', () => {
  const env = mkRunEnv({ files: ['shared.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['shared.ts'] }, { id: 'g2', sc_ids: ['SC-1'], paths: ['shared.ts'] }],
    [['g1', 'g2']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF() },
     { id: 'SC-1', kind: 'fix', finding_ids: ['f1'], change: 'c', holds: 'h', verify: VF() }]
  );
  FR.initRun({ stateDir: env.stateDir, runId: 'rp', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rp', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  for (const al of a.allocations) {
    writeFileSync(join(al.worktree, 'shared.ts'), `${al.group_id}\n`);
    execFileSync('git', ['-C', al.worktree, 'commit', '-qam', al.group_id], { encoding: 'utf8' });
  }
  const r = FR.integrate({ stateDir: env.stateDir, runId: 'rp', plan, waveIndex: 0 });
  ok(!r.ok && r.replan_required, '前提: 已进入 replan');
  // R4 反例: 再 allocate 同 wave → v1 会静默重建 wave 清掉 replan → 现在必须拒
  let threw = false;
  try { FR.allocate({ stateDir: env.stateDir, runId: 'rp', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm }); }
  catch (e) { threw = /串行重派状态，禁止重新 allocate/.test(e.message); }
  ok(threw, 'R4-P1 核心: replan 后 allocate 重放必拒');
  const m = readJson(FR.runManifestPath(env.stateDir, 'rp'));
  ok(m.waves[0].replan && m.waves[0].replan.order.length === 2, 'replan 状态与证据必须保留');
});

t('[R4-P1] finalize 未检出路径 CAS: feature branch 被并发推进 → 拒（不再 branch -f 覆盖）', () => {
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }], [['g1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'rc', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rc', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a.allocations[0], 'a.ts', 'fix\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'rc', plan, waveIndex: 0 }).ok);
  ok(FR.validateIntegration({ stateDir: env.stateDir, runId: 'rc', scManifest: scm, waveIndex: 0 }).ok);
  // 并发场景: feat 被别的进程推进一个合法 commit C；主 checkout 切去别的分支（走 branch -f 路径）
  env.g('checkout', '-qb', 'elsewhere');
  const concurrent = env.g('commit-tree', `${env.cand}^{tree}`, '-p', env.cand, '-m', 'concurrent C');
  env.g('update-ref', 'refs/heads/feat', concurrent);
  let threw = false;
  try { FR.finalizeRun({ stateDir: env.stateDir, runId: 'rc' }); }
  catch (e) { threw = /CAS 失败|已不在 run 起点/.test(e.message); }
  ok(threw, 'R4-P1 核心: 并发推进的 feat 不得被 branch -f 静默覆盖');
  eq(env.g('rev-parse', 'refs/heads/feat'), concurrent, '并发 commit C 必须还在');
  // 恢复到起点 → CAS 前推成功
  env.g('update-ref', 'refs/heads/feat', env.cand);
  const fin = FR.finalizeRun({ stateDir: env.stateDir, runId: 'rc' });
  eq(env.g('rev-parse', 'refs/heads/feat'), fin.final_candidate, '起点未动时 CAS 前推成功');
});

t('[R6-P1] CAS 删除不得绕过检出保护: 记录 tip 一致但分支正被 worktree 检出 → 拒', () => {
  const d = mkdtempSync(join(tmpdir(), 'r6p1-'));
  const r = join(d, 'repo');
  execFileSync('git', ['init', '-q', r]);
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'o@t'); g('config', 'user.name', 'o');
  writeFileSync(join(r, 'f.ts'), 'x\n'); g('add', '.'); g('commit', '-qm', 'base');
  const cand = g('rev-parse', 'HEAD');
  writeFileSync(join(r, 'f.ts'), 'w\n'); g('add', '.'); g('commit', '-qm', 'w');
  const T = g('rev-parse', 'HEAD');
  g('checkout', '-q', cand);
  // 分支在另一 worktree 检出（clean），allocation worktree 缺席，记录 tip == 实际 tip
  g('branch', 'fix/rq/g1', T);
  const otherWt = join(d, 'other');
  g('worktree', 'add', '-q', otherWt, 'fix/rq/g1');
  const wtRoot = join(d, 'wt'); mkdirSync(wtRoot);
  const manifest = { repo_dir: r, run_id: 'rq', source_candidate: cand, integration_branch: null,
    waves: [{ worktree_root: wtRoot, base: cand, tips: [{ group_id: 'g1', tip: T }],
      allocations: [{ group_id: 'g1', worktree: join(wtRoot, 'rq-g1'), branch: 'fix/rq/g1', base: cand, owner_nonce: 'x'.repeat(32) }] }] };
  const res = ORC.cleanupRun({ manifest });
  ok(res.errors.some((e) => /正被某个 worktree 检出/.test(e)), 'R6-P1 核心: CAS 删除前必须查检出: ' + JSON.stringify(res.errors));
  ok(res.steps.includes('br-refused:g1'));
  eq(g('rev-parse', 'refs/heads/fix/rq/g1'), T, '分支必须原封不动');
  eq(execFileSync('git', ['-C', otherWt, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', '检出该分支的 worktree 基线不得被破坏');
  // 取消检出后 → CAS 删除放行
  g('worktree', 'remove', '--force', otherWt);
  const res2 = ORC.cleanupRun({ manifest });
  ok(res2.steps.includes('br-deleted:g1'), '无人检出时 CAS 删除成功: ' + JSON.stringify(res2));
});

t('[R6-P2] integration 记录路径为唯一权威: 后续波换 worktree_root 不分叉第二个 worktree', () => {
  const env = mkRunEnv({ files: ['a.ts', 'e2e/x.test.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }, { id: 'v1', sc_ids: ['SC-V'], paths: ['e2e/x.test.ts'], verify: true }],
    [['g1'], ['v1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) },
     { id: 'SC-V', kind: 'verify', finding_ids: ['f1'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'e2e/x.test.ts']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'rf', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a1 = FR.allocate({ stateDir: env.stateDir, runId: 'rf', plan, waveIndex: 0, worktreeRoot: env.wtRoot, artifact: art, scManifest: scm });
  workGroup(env, a1.allocations[0], 'a.ts', 'fix\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'rf', plan, waveIndex: 0 }).ok);
  ok(FR.validateIntegration({ stateDir: env.stateDir, runId: 'rf', scManifest: scm, waveIndex: 0 }).ok);
  // wave2 换一个 worktree_root（R6 反例: v1 实现会在 root2 分叉出第二个 integration worktree）
  const root2 = join(env.d, 'wt2'); mkdirSync(root2);
  const a2 = FR.allocate({ stateDir: env.stateDir, runId: 'rf', plan, waveIndex: 1, worktreeRoot: root2, artifact: art, scManifest: scm });
  workGroup(env, a2.allocations[0], 'e2e/x.test.ts', 'test\n');
  ok(FR.integrate({ stateDir: env.stateDir, runId: 'rf', plan, waveIndex: 1 }).ok);
  const m = readJson(FR.runManifestPath(env.stateDir, 'rf'));
  ok(!existsSync(join(root2, 'rf-integration')), 'R6-P2 核心: 不得在新 root 分叉第二个 integration worktree');
  eq(m.integration_worktree.path, join(env.wtRoot, 'rf-integration'), '记录路径保持唯一权威');
  ok(FR.validateIntegration({ stateDir: env.stateDir, runId: 'rf', scManifest: scm, waveIndex: 1 }).ok);
  // cleanup 后无泄漏: 本 run 的 worktree 全部回收
  const res = ORC.cleanupRun({ manifest: readJson(FR.runManifestPath(env.stateDir, 'rf')) });
  eq((res.errors ?? []).length, 0, JSON.stringify(res.errors));
  ok(!existsSync(join(env.wtRoot, 'rf-integration')) && !existsSync(a1.allocations[0].worktree) && !existsSync(a2.allocations[0].worktree), '全部回收，无泄漏');
});

t('[R7-P1] 删除竞态: 预检查后、删除前被抢先检出 → 复查检出并按记录 tip 补偿回滚', () => {
  const d = mkdtempSync(join(tmpdir(), 'r7p1-'));
  const r = join(d, 'repo');
  execFileSync('git', ['init', '-q', r]);
  const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
  g('config', 'user.email', 'o@t'); g('config', 'user.name', 'o');
  writeFileSync(join(r, 'f.ts'), 'x\n'); g('add', '.'); g('commit', '-qm', 'base');
  const cand = g('rev-parse', 'HEAD');
  writeFileSync(join(r, 'f.ts'), 'w\n'); g('add', '.'); g('commit', '-qm', 'w');
  const T = g('rev-parse', 'HEAD');
  g('checkout', '-q', cand);
  g('branch', 'fix/rt/g1', T);
  const wtRoot = join(d, 'wt'); mkdirSync(wtRoot);
  const racerWt = join(d, 'racer');
  // exec 注入: 在 update-ref -d 落地前一刻，racer 抢先 worktree add 检出该分支
  // （复刻 R7 的 PATH-wrapper probe: 预检查已过、删除未落地的窗口）
  const realExec = (argv) => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  let raced = false;
  const exec = (argv) => {
    if (!raced && argv.includes('update-ref') && argv.includes('-d')) {
      raced = true;
      realExec(['git', '-C', r, 'worktree', 'add', '-q', racerWt, 'fix/rt/g1']);
    }
    return realExec(argv);
  };
  const manifest = { repo_dir: r, run_id: 'rt', source_candidate: cand, integration_branch: null,
    waves: [{ worktree_root: wtRoot, base: cand, tips: [{ group_id: 'g1', tip: T }],
      allocations: [{ group_id: 'g1', worktree: join(wtRoot, 'rt-g1'), branch: 'fix/rt/g1', base: cand, owner_nonce: 'x'.repeat(32) }] }] };
  const res = ORC.cleanupRun({ manifest, exec });
  ok(raced, '前提: 竞态确已发生在预检查之后');
  ok(res.steps.includes('br-restored:g1'), 'R7-P1 核心: 删除后复查必须检出竞态并回滚: ' + JSON.stringify(res.steps));
  ok(res.errors.some((e) => /竞态.*恢复|补偿回滚/.test(e)), '必须显式报告竞态: ' + JSON.stringify(res.errors));
  eq(g('rev-parse', 'refs/heads/fix/rt/g1'), T, '分支必须被精确恢复到记录 tip');
  eq(execFileSync('git', ['-C', racerWt, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'racer worktree 基线无损（不再是 No commits yet）');
});

t('[R8-P1] 删除后复查命令失败 → 按不安全处理: group 与 integration 两条路径都必须补偿恢复', () => {
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), 'r8p1-'));
    const r = join(d, 'repo');
    execFileSync('git', ['init', '-q', r]);
    const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
    g('config', 'user.email', 'o@t'); g('config', 'user.name', 'o');
    writeFileSync(join(r, 'f.ts'), 'x\n'); g('add', '.'); g('commit', '-qm', 'base');
    const cand = g('rev-parse', 'HEAD');
    writeFileSync(join(r, 'f.ts'), 'w\n'); g('add', '.'); g('commit', '-qm', 'w');
    const T = g('rev-parse', 'HEAD');
    g('checkout', '-q', cand);
    return { d, r, g, cand, T };
  };
  // exec 包装: 预检查放行；racer 在删除前抢先检出；**删除后的复查命令失败**（R8 反例）
  const wrap = (r, branch, racerWt) => {
    const real = (argv) => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' });
    let listCalls = 0, deleted = false;
    return (argv) => {
      const isList = argv.includes('worktree') && argv.includes('list');
      if (isList) {
        listCalls++;
        if (deleted) throw new Error('worktree list 失败（模拟 IO 错误，exit 42）');
        return real(argv);
      }
      if (argv.includes('update-ref') && argv.includes('-d')) {
        real(['git', '-C', r, 'worktree', 'add', '-q', racerWt, branch]); // 竞态检出
        const out = real(argv);
        deleted = true;
        return out;
      }
      return real(argv);
    };
  };
  // ① group 分支路径
  const A = mk();
  A.g('branch', 'fix/r8/g1', A.T);
  const racerA = join(A.d, 'racerA');
  const wtRootA = join(A.d, 'wt'); mkdirSync(wtRootA);
  const mA = { repo_dir: A.r, run_id: 'r8', source_candidate: A.cand, integration_branch: null,
    waves: [{ worktree_root: wtRootA, base: A.cand, tips: [{ group_id: 'g1', tip: A.T }],
      allocations: [{ group_id: 'g1', worktree: join(wtRootA, 'r8-g1'), branch: 'fix/r8/g1', base: A.cand, owner_nonce: 'x'.repeat(32) }] }] };
  const rA = ORC.cleanupRun({ manifest: mA, exec: wrap(A.r, 'fix/r8/g1', racerA) });
  ok(rA.steps.includes('br-restored:g1'), 'R8-P1 核心(group): 复查失败必须按不安全处理并恢复: ' + JSON.stringify(rA.steps));
  ok(rA.errors.some((e) => /删除后复查失败/.test(e) && e.includes(A.T)), '错误必须说明复查失败 + 完整 expected tip: ' + JSON.stringify(rA.errors));
  eq(A.g('rev-parse', 'refs/heads/fix/r8/g1'), A.T, '分支必须精确恢复');
  eq(execFileSync('git', ['-C', racerA, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'racer worktree 基线无损');
  // ② integration 分支路径（同一 helper，不得漂移）
  const B = mk();
  B.g('branch', 'fix/r8/integration', B.T);
  const racerB = join(B.d, 'racerB');
  const wtRootB = join(B.d, 'wt'); mkdirSync(wtRootB);
  const mB = { repo_dir: B.r, run_id: 'r8', source_candidate: B.cand, integration_branch: 'fix/r8/integration',
    waves: [{ worktree_root: wtRootB, base: B.cand, tips: [], allocations: [], integrated_tip: B.T }] };
  const rB = ORC.cleanupRun({ manifest: mB, exec: wrap(B.r, 'fix/r8/integration', racerB) });
  ok(rB.steps.includes('br-restored:integration'), 'R8-P1 核心(integration): 同样必须恢复: ' + JSON.stringify(rB.steps));
  eq(B.g('rev-parse', 'refs/heads/fix/r8/integration'), B.T, 'integration 分支必须精确恢复');
  eq(execFileSync('git', ['-C', racerB, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'racer worktree 基线无损');
  // ③ 预检查阶段复查失败 → fail-closed 不删（destructive step 前的异常也不得逃逸）
  const C = mk();
  C.g('branch', 'fix/r8/g1', C.T);
  const wtRootC = join(C.d, 'wt'); mkdirSync(wtRootC);
  const mC = { repo_dir: C.r, run_id: 'r8', source_candidate: C.cand, integration_branch: null,
    waves: [{ worktree_root: wtRootC, base: C.cand, tips: [{ group_id: 'g1', tip: C.T }],
      allocations: [{ group_id: 'g1', worktree: join(wtRootC, 'r8-g1'), branch: 'fix/r8/g1', base: C.cand, owner_nonce: 'x'.repeat(32) }] }] };
  const execC = (argv) => {
    if (argv.includes('worktree') && argv.includes('list')) throw new Error('worktree list 全程失败');
    return execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  };
  const rC = ORC.cleanupRun({ manifest: mC, exec: execC });
  ok(rC.errors.some((e) => /无法读取 git worktree 列表|无法确认检出状态/.test(e)), '预检查失败必须 fail-closed: ' + JSON.stringify(rC.errors));
  eq(C.g('rev-parse', 'refs/heads/fix/r8/g1'), C.T, '预检查失败时分支不得被删');
});

t('[R9] 删除命令抛错 = 结果不确定: 已落地→恢复 / 仍在原位→安全拒 / 第三方抢占→不覆盖', () => {
  const mk = (branch) => {
    const d = mkdtempSync(join(tmpdir(), 'r9-'));
    const r = join(d, 'repo');
    execFileSync('git', ['init', '-q', r]);
    const g = (...a) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
    g('config', 'user.email', 'o@t'); g('config', 'user.name', 'o');
    writeFileSync(join(r, 'f.ts'), 'x\n'); g('add', '.'); g('commit', '-qm', 'base');
    const cand = g('rev-parse', 'HEAD');
    writeFileSync(join(r, 'f.ts'), 'w\n'); g('add', '.'); g('commit', '-qm', 'w');
    const T = g('rev-parse', 'HEAD');
    g('checkout', '-q', cand);
    g('branch', branch, T);
    const wtRoot = join(d, 'wt'); mkdirSync(wtRoot);
    const manifest = { repo_dir: r, run_id: 'r9', source_candidate: cand, integration_branch: null,
      waves: [{ worktree_root: wtRoot, base: cand, tips: [{ group_id: 'g1', tip: T }],
        allocations: [{ group_id: 'g1', worktree: join(wtRoot, 'r9-g1'), branch, base: cand, owner_nonce: 'x'.repeat(32) }] }] };
    return { d, r, g, cand, T, manifest };
  };
  const real = (argv) => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' });

  // ① R9 反例: 真实删除已落地（且 racer 已检出），但执行器在回执前抛错
  //    → 旧实现记 br-refused 走人，ref 已消失、racer 被打成 unborn
  const A = mk('fix/r9/a');
  const racerA = join(A.d, 'racerA');
  const execA = (argv) => {
    if (argv.includes('update-ref') && argv.includes('-d')) {
      real(['git', '-C', A.r, 'worktree', 'add', '-q', racerA, 'fix/r9/a']);
      real(argv);                                    // 删除真实落地
      throw new Error('update-ref 回执丢失（模拟进程被杀 / wrapper exit 42）');
    }
    return real(argv);
  };
  const rA = ORC.cleanupRun({ manifest: A.manifest, exec: execA });
  ok(rA.steps.includes('br-restored:g1'), 'R9 核心: 删除已落地却报错 → 必须恢复而非记 br-refused: ' + JSON.stringify(rA.steps));
  ok(rA.errors.some((e) => /结果不确定/.test(e) && e.includes(A.T)), '错误须说明结果不确定 + 完整 expected tip: ' + JSON.stringify(rA.errors));
  eq(A.g('rev-parse', 'refs/heads/fix/r9/a'), A.T, '分支必须精确恢复');
  eq(execFileSync('git', ['-C', racerA, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'racer 基线无损');

  // ② 删除真的没发生（ref 仍在记录 tip 原位）→ 安全记 br-refused，不误报恢复
  const B = mk('fix/r9/b');
  const execB = (argv) => {
    if (argv.includes('update-ref') && argv.includes('-d')) throw new Error('删除被拒（old 不匹配 / 权限）');
    return real(argv);
  };
  const rB = ORC.cleanupRun({ manifest: B.manifest, exec: execB });
  ok(rB.steps.includes('br-refused:g1'), 'ref 仍在原位应记 br-refused: ' + JSON.stringify(rB.steps));
  ok(!rB.steps.some((s) => s.startsWith('br-restored')), '不得误报恢复');
  ok(rB.errors.some((e) => /仍在记录 tip 原位/.test(e)), JSON.stringify(rB.errors));
  eq(B.g('rev-parse', 'refs/heads/fix/r9/b'), B.T, '分支未动');

  // ③ 删除落地后第三方抢占同名 ref（不同 tip）→ 绝不覆盖，记 br-restore-fail
  const C = mk('fix/r9/c');
  const execC = (argv) => {
    if (argv.includes('update-ref') && argv.includes('-d')) {
      real(argv);                                                     // 删除落地
      real(['git', '-C', C.r, 'update-ref', 'refs/heads/fix/r9/c', C.cand]); // 第三方抢占（tip = cand ≠ T）
      throw new Error('回执丢失');
    }
    return real(argv);
  };
  const rC = ORC.cleanupRun({ manifest: C.manifest, exec: execC });
  ok(rC.steps.includes('br-restore-fail:g1'), '第三方抢占应记 br-restore-fail: ' + JSON.stringify(rC.steps));
  ok(rC.errors.some((e) => /第三方已抢占，绝不覆盖/.test(e)), JSON.stringify(rC.errors));
  eq(C.g('rev-parse', 'refs/heads/fix/r9/c'), C.cand, '第三方 ref 必须原封不动');
});

// ========== 23. SC-B1: family 归因数据契约 + SC-B4: 加固清单十类文档一致性 ==========
console.log('\n[23] SC-B1 family 归因（invariant/family_id 冻结+逐字相等） / SC-B4 hardening-checklist.md 十类文档一致性');

t('[SC-B1] actionable finding 缺 invariant/family_id → degraded；suggestion 不强制', () => {
  // withAnchorPaths 的 fixture 便利默认值只在字段**完全未出现**（undefined）时补——这里显式传
  // null 表示「测试故意不给」，绕开默认值以测出 validator 真实的必填校验（而不是被 fixture 便利
  // 逻辑掩盖）。
  const noInv = mkVerdictFor('claude-adversarial', bundle, {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'src/x.ts', anchor_paths: ['src/x.ts'], invariant: null, family_id: 'FAM-1', evidence: 'e', status: 'closed' }],
    closed_finding_ids: ['F1']
  });
  ok(validateVerdict(noInv).some((e) => /F1.*缺 invariant/.test(e)), 'actionable finding 缺 invariant 必须报错');
  const noFam = mkVerdictFor('claude-adversarial', bundle, {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'blocker', anchor: 'src/x.ts', anchor_paths: ['src/x.ts'], invariant: 'inv', family_id: null, evidence: 'e', status: 'closed' }],
    closed_finding_ids: ['F1']
  });
  ok(validateVerdict(noFam).some((e) => /F1.*缺 family_id/.test(e)), 'actionable finding 缺 family_id 必须报错');
  // suggestion 级不强制——两个字段都不给也应过（其余字段齐全）
  const sugg = mkVerdictFor('claude-adversarial', bundle, {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'suggestion', anchor: 'src/x.ts', anchor_paths: ['src/x.ts'], evidence: 'e', status: 'closed' }],
    closed_finding_ids: ['F1']
  });
  eq(validateVerdict(sugg).length, 0, 'suggestion 级 finding 不强制 invariant/family_id');
});

t('[SC-B1/D1] family_id 引用合法性: 同 family 的 invariant 必须逐字一致（同 verdict 内自洽）', () => {
  const mkTwo = (inv1, inv2) => mkVerdictFor('claude-adversarial', bundle, {
    findings: [
      { id: 'F1', primary_face: 'A', severity: 'major', anchor: 'src/x.ts', anchor_paths: ['src/x.ts'], invariant: inv1, family_id: 'FAM-SHARED', evidence: 'e1', status: 'closed' },
      { id: 'F2', primary_face: 'A', severity: 'major', anchor: 'src/y.ts', anchor_paths: ['src/y.ts'], invariant: inv2, family_id: 'FAM-SHARED', evidence: 'e2', status: 'closed' }
    ],
    closed_finding_ids: ['F1', 'F2']
  });
  ok(validateVerdict(mkTwo('同一个不变量', '另一个不变量')).some((e) => /family_id=FAM-SHARED.*不一致/.test(e)), '同 family_id 但 invariant 不同必须报错');
  eq(validateVerdict(mkTwo('同一个不变量', '同一个不变量')).length, 0, '同 family_id 且 invariant 逐字一致应过');
});

t('[SC-B1/D1] consensus-gate 冻结 invariant + 派生 family_key（内容身份，不是 family_id 标签）到 canonical finding', () => {
  const srcBundle2 = mkBundle(SHA_A, SHA_B);
  const fdA = { id: 'FA', primary_face: 'A', severity: 'major', anchor: 'src/shared.ts#0', anchor_paths: ['src/shared.ts'], invariant: 'first-invariant', family_id: 'FAM-X', evidence: 'ev-shared', status: 'closed' };
  // 第二席同一条 finding（同 canonicalFindingKey：face+anchor+evidence 指纹一致）携带不同的
  // invariant/family_id 文本——冻结逻辑只取首个 origin 的 invariant，不做跨 origin 语义裁决/
  // 合并；family_key 则从「冻结后的 invariant」派生，与 origin 到达顺序无关。
  const fdB = { ...fdA, id: 'FB', invariant: 'second-invariant-should-not-win', family_id: 'FAM-Y-should-not-win' };
  const v1x = mkVerdictFor('claude-adversarial', srcBundle2, { findings: [fdA], closed_finding_ids: ['FA'] });
  const v2x = mkVerdictFor('codex-adversarial', srcBundle2, { findings: [fdB], closed_finding_ids: ['FB'] });
  const v3x = mkVerdictFor('upstream-preview', srcBundle2, { findings: [], closed_finding_ids: [] });
  const changedPaths = new Set(['src/shared.ts']);
  const artifact = runConsensusGate([v1x, v2x, v3x], { bundle: srcBundle2, changedPaths });
  eq(artifact.gate_result, 'pass', JSON.stringify(artifact.fail_reasons ?? []));
  eq(artifact.canonical_findings.length, 1, '两席同一条 finding 应聚为 1 条 canonical');
  const cf = artifact.canonical_findings[0];
  eq(cf.invariant, 'first-invariant', 'canonical 必须冻结首个 origin（claude-adversarial）的 invariant');
  eq(cf.family_key, familyKeyOf('first-invariant'), 'canonical 的 family_key 必须从冻结后的 invariant 派生（与 familyKeyOf 重算值一致）');
  ok(cf.family_key !== familyKeyOf('second-invariant-should-not-win'), 'family_key 不得跟着第二席的 invariant 走');
  eq(cf.origins.length, 2, '两席的 origin 都必须保留（审②-F2 全量保留不变）');
  // D1: origin_family_ids 保留每个 origin 自己的本地标签，供人工回溯，但不参与机器分组
  ok(cf.origin_family_ids.some((o) => o.reviewer === 'claude-adversarial' && o.family_id === 'FAM-X'), 'origin_family_ids 必须留痕首席标签');
  ok(cf.origin_family_ids.some((o) => o.reviewer === 'codex-adversarial' && o.family_id === 'FAM-Y-should-not-win'), 'origin_family_ids 必须留痕次席标签');
});

t('[SC-B1/D1] sc-coverage-gate: SC 的 invariant/family_key 必须逐字等于共识产物冻结值——缺失/错配一律 fail-closed', () => {
  const art = artifactWithFindings([{ sev: 'major', paths: ['src/attr.ts'], invariant: '真实不变量', family_id: 'FAM-ATTR' }]);
  const fid = art.canonical_findings[0].id;
  eq(art.canonical_findings[0].invariant, '真实不变量');
  eq(art.canonical_findings[0].family_key, familyKeyOf('真实不变量'));
  const realKey = art.canonical_findings[0].family_key;
  const mkOne = (over = {}) => ({ schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: [{ id: 'SC-0', kind: 'fix', finding_ids: [fid], change: 'c', holds: 'h', verify: VF(), invariant: '真实不变量', family_key: realKey, ...over }] });
  // 正确逐字复制 → 过
  eq(checkScCoverage({ manifest: mkOne(), artifact: art }).length, 0, '逐字复制归因字段应过覆盖门');
  // 缺 invariant → 拒
  const missingInv = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: [{ id: 'SC-0', kind: 'fix', finding_ids: [fid], change: 'c', holds: 'h', verify: VF(), family_key: realKey }] };
  ok(checkScCoverage({ manifest: missingInv, artifact: art }).some((e) => /必须携带 invariant/.test(e)), '缺 invariant 必须拒');
  // 缺 family_key → 拒
  const missingFam = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: [{ id: 'SC-0', kind: 'fix', finding_ids: [fid], change: 'c', holds: 'h', verify: VF(), invariant: '真实不变量' }] };
  ok(checkScCoverage({ manifest: missingFam, artifact: art }).some((e) => /必须携带 family_key/.test(e)), '缺 family_key 必须拒');
  // invariant 与共识产物不逐字相等（字段错配/归因漂移）→ 拒
  ok(checkScCoverage({ manifest: mkOne({ invariant: '被改写的不变量' }), artifact: art }).some((e) => /不逐字相等.*invariant|invariant.*不逐字相等/.test(e) || /字段错配\/归因漂移/.test(e)),
    'invariant 与冻结值不一致必须拒');
  // family_key 与共识产物不逐字相等（不是从 familyKeyOf 重算得到的值，比如手误改了几位）→ 拒
  ok(checkScCoverage({ manifest: mkOne({ family_key: 'fk1-' + '0'.repeat(64) }), artifact: art }).some((e) => /字段错配\/归因漂移/.test(e)), 'family_key 与冻结值不一致必须拒');
});

t('[SC-B1] fix-orchestrate.familyContext: 同 family 的其它 manifestation 跨组可见，且各自带 sc_id 引用；未归族 finding 得 null；缺 artifact/scManifest 必须 fail-closed（D3）', () => {
  const art = artifactWithFindings([
    { sev: 'major', paths: ['src/fam-a.ts'], invariant: '共享不变量', family_id: 'FAM-SHARE' },
    { sev: 'major', paths: ['src/fam-b.ts'], invariant: '共享不变量', family_id: 'FAM-SHARE' }, // 与上条同 invariant → 同 family_key，不同路径 → 分到不同冲突组
    { sev: 'suggestion', paths: ['docs/note.md'] } // 不归族
  ]);
  const idOf = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const scManifest = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: withScAttribution([
      { id: 'SC-A', kind: 'fix', finding_ids: [idOf(0)], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-B', kind: 'fix', finding_ids: [idOf(1)], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-C', kind: 'fix', finding_ids: [idOf(2)], change: 'c', holds: 'h', verify: VF() }
    ], art) };
  const plan = buildFixPlan({ artifact: art, manifest: scManifest });
  ok(!plan.degraded, JSON.stringify(plan.reasons ?? []));
  eq(plan.plan.groups.length, 3, '三条 SC 路径互不相交，各自独立组（family 关系不影响分组——分组逻辑不改）');
  const ctxA = ORC.familyContext({ artifact: art, manifest: scManifest, scIds: ['SC-A'] });
  ok(ctxA['SC-A'], 'SC-A 应有 family_context');
  eq(ctxA['SC-A'].family_key, familyKeyOf('共享不变量'));
  eq(ctxA['SC-A'].manifestations.length, 1, 'SC-A 应看到同 family 的另一条 manifestation（跨组可见）');
  eq(ctxA['SC-A'].manifestations[0].finding_id, idOf(1));
  eq(ctxA['SC-A'].manifestations[0].sc_id, 'SC-B', 'manifestation 必须带上已分到的 sc_id 引用（同 family 前序 finding 引用）');
  ok(ctxA['SC-A'].audit_instruction.includes('未点名处'), '审计指令文本必须要求排查未点名路径');
  const ctxC = ORC.familyContext({ artifact: art, manifest: scManifest, scIds: ['SC-C'] });
  eq(ctxC['SC-C'], null, '未归族（suggestion）finding 的 SC 应得 null family_context');

  // D3（gpt 终审阻断修复）: allocateWave 的 artifact/scManifest 现在必填——不传必须 fail-closed
  // 抛错，不再静默产出 family_context=null（那会让"强制覆盖全部路径"悄悄退化成部分覆盖）。
  const d23 = mkdtempSync(join(tmpdir(), 'famctx-'));
  const r23 = join(d23, 'repo');
  execFileSync('git', ['init', '-q', r23]);
  const g23 = (...a) => execFileSync('git', ['-C', r23, ...a], { encoding: 'utf8' }).trim();
  g23('config', 'user.email', 'o@t'); g23('config', 'user.name', 'o');
  mkdirSync(join(r23, 'src'), { recursive: true });
  writeFileSync(join(r23, 'src', 'fam-a.ts'), 'base\n');
  g23('add', '.'); g23('commit', '-qm', 'base');
  const cand23 = g23('rev-parse', 'HEAD');
  const wtRoot23 = join(d23, 'wt'); mkdirSync(wtRoot23);
  const planShape = { schema_version: 'v1', capacity: 8, groups: [{ id: 'g1', sc_ids: ['SC-A'], paths: ['src/fam-a.ts'] }], waves: [['g1']] };
  const withCtx = ORC.allocateWave({ repoDir: r23, worktreeRoot: wtRoot23, runId: 'famctx1', plan: planShape, waveIndex: 0, waveBase: cand23, artifact: art, scManifest });
  ok(withCtx.allocations[0].family_context, '传 artifact+scManifest 时 allocation 应带 family_context');
  eq(withCtx.allocations[0].family_context['SC-A'].family_key, familyKeyOf('共享不变量'));
  let threwNoArtifact = false;
  try { ORC.allocateWave({ repoDir: r23, worktreeRoot: wtRoot23, runId: 'famctx2', plan: planShape, waveIndex: 0, waveBase: cand23, scManifest }); }
  catch (e) { threwNoArtifact = /缺 artifact/.test(e.message); }
  ok(threwNoArtifact, 'D3: 缺 artifact 必须 fail-closed 抛错，不得静默产出 family_context=null');
  let threwNoManifest = false;
  try { ORC.allocateWave({ repoDir: r23, worktreeRoot: wtRoot23, runId: 'famctx3', plan: planShape, waveIndex: 0, waveBase: cand23, artifact: art }); }
  catch (e) { threwNoManifest = /缺 scManifest/.test(e.message); }
  ok(threwNoManifest, 'D3: 缺 scManifest 必须 fail-closed 抛错');
  // 真旧版 artifact（actionable finding 缺 family_key）同样不做静默兼容——找到一条真正
  // actionable（major/blocker）的 canonical finding 摘掉 family_key（不能盲摘 index 0，
  // 排序后 index 0 可能恰好是 suggestion 级、本就没有该字段的那条，摘了等于没摘）
  const oldArt = JSON.parse(JSON.stringify(art));
  const actionableIdx = oldArt.canonical_findings.findIndex((f) => f.severity === 'blocker' || f.severity === 'major');
  ok(actionableIdx !== -1, '前提: 必须存在至少一条 actionable canonical finding');
  delete oldArt.canonical_findings[actionableIdx].family_key;
  let threwOldFormat = false;
  try { ORC.allocateWave({ repoDir: r23, worktreeRoot: wtRoot23, runId: 'famctx4', plan: planShape, waveIndex: 0, waveBase: cand23, artifact: oldArt, scManifest }); }
  catch (e) { threwOldFormat = /疑似旧版 consensus artifact/.test(e.message); }
  ok(threwOldFormat, 'D3: actionable finding 缺 family_key（真旧版 artifact）必须 fail-closed，不静默产出不完整的 family_context');
});

// family_key 集合（去重）——SKILL.md repair-mode watermark 描述的判据本体：
// 「对照共识产物 canonical_findings 的 family_key」判断相邻两个 candidate 之间是否出现新 family。
// D1: 绑定 family_key（内容派生），不是 family_id（reviewer 席内本地标签，两个不同 reviewer
// 可能各自合法地把同一标签用来指不同的不变量，按标签比较毫无意义——见下方两条反例 fixture）。
// watermark 本身没有代码实现（是 SKILL.md 里 lead 遵循的过程规则，D2 owner 拍板：有意不建
// 生产计数器），这里验证的是它的**机器前提**：给定两份 consensus artifact，能否机器化判定
// 「是否出现新 family」。
function familyKeySet(artifact) {
  return new Set((artifact.canonical_findings ?? []).map((f) => f.family_key).filter(Boolean));
}
function newFamilies(prevArtifact, nextArtifact) {
  const prev = familyKeySet(prevArtifact);
  return [...familyKeySet(nextArtifact)].filter((k) => !prev.has(k));
}

t('[SC-B1-WM] repair-mode watermark 的机器前提: family_key 已可从 canonical_findings 取得，「是否出现新 family」可机器判定（原 SKILL.md 脚手架条款的解除对象，D2 重锚 family_key）', () => {
  // candidate-N: 两个既有 family（inv-x / inv-z）
  const artN = artifactWithFindings([
    { sev: 'major', paths: ['src/x.ts'], invariant: 'inv-x', family_id: 'FAM-X' },
    { sev: 'major', paths: ['src/z.ts'], invariant: 'inv-z', family_id: 'FAM-Z' }
  ]);
  // candidate-N+1（出现新 family）: 沿用 inv-x/inv-z，新增 inv-y
  const artNextNew = artifactWithFindings([
    { sev: 'major', paths: ['src/x.ts'], invariant: 'inv-x', family_id: 'FAM-X' },
    { sev: 'major', paths: ['src/z.ts'], invariant: 'inv-z', family_id: 'FAM-Z' },
    { sev: 'blocker', paths: ['src/y.ts'], invariant: 'inv-y', family_id: 'FAM-Y' }
  ]);
  // candidate-N+1'（无新 family）: family 集合是 N 的真子集（只剩 inv-x）
  const artNextSubset = artifactWithFindings([
    { sev: 'major', paths: ['src/x.ts'], invariant: 'inv-x', family_id: 'FAM-X' }
  ]);

  // ① 三份都真走了 validator + consensus-gate（不是手搭的假 artifact），且都真达成共识
  for (const [label, art] of [['N', artN], ['N+1(new)', artNextNew], ["N+1'(subset)", artNextSubset]]) {
    eq(art.gate_result, 'pass', `candidate-${label} 应真实达成共识: ` + JSON.stringify(art.fail_reasons ?? []));
  }

  // ② canonical_findings 确实携带 family_key——不是被可选跳过（脚手架条款要解除的核心前提）
  for (const [label, art] of [['N', artN], ['N+1(new)', artNextNew], ["N+1'(subset)", artNextSubset]]) {
    ok(art.canonical_findings.length > 0, `candidate-${label} 应至少有一条 canonical finding`);
    for (const f of art.canonical_findings) {
      ok(typeof f.family_key === 'string' && f.family_key.length > 0, `candidate-${label} 的 canonical finding ${f.id} 必须真携带 family_key（不是「暂不可判」的字段缺失态）`);
    }
  }

  // ③ 由 N 与 N+1 可判出「出现了新 family（inv-y）」——水位线所需输入确实可得
  const detectedNew = newFamilies(artN, artNextNew);
  eq(detectedNew, [familyKeyOf('inv-y')], '对照 canonical_findings 的 family_key 必须能判出新 family（水位线机器前提成立）');

  // ④ 反向: N+1' 的 family 集合是 N 的子集 → 判出「无新 family」
  const detectedNone = newFamilies(artN, artNextSubset);
  eq(detectedNone, [], 'family 集合是子集时必须判出「无新 family」（不得把子集误判成新 family）');
});

t('[SC-B1-WM/D1-反例①] 两席合法共用同一 family_id 标签但描述不同 invariant → family_key 不同 → 不得合并（gpt 终审实测复现的阻断项）', () => {
  // reviewer A 与 reviewer B 各自在自己的 verdict 里都合法地用了 "F1" 这个本地标签——
  // 但 A 的 F1 说的是"状态单一 writer"，B 的 F1 说的是"删除须 reconciliation"，两者语义
  // 无关。两条 finding 锚在不同文件/不同 evidence，canonicalFindingKey 不会把它们去重合并，
  // 因此产出两条独立的 canonical finding；本例断言：即便两者的 origin family_id 标签字符串
  // 相同（都是 "F1"），下游 family_key 分组也绝不会把它们当同一 family。
  const srcBundle3 = mkBundle(SHA_A, SHA_B);
  const fdWriter = { id: 'FW', primary_face: 'A', severity: 'major', anchor: 'src/writer.ts#0', anchor_paths: ['src/writer.ts'], invariant: '状态字段必须只有一个写入 owner', family_id: 'F1', evidence: 'ev-writer', status: 'closed' };
  const fdDelete = { id: 'FD', primary_face: 'A', severity: 'major', anchor: 'src/deleter.ts#0', anchor_paths: ['src/deleter.ts'], invariant: '删除操作必须走事务性 reconciliation', family_id: 'F1', evidence: 'ev-deleter', status: 'closed' };
  const vA = mkVerdictFor('claude-adversarial', srcBundle3, { findings: [fdWriter], closed_finding_ids: ['FW'] });
  const vB = mkVerdictFor('codex-adversarial', srcBundle3, { findings: [fdDelete], closed_finding_ids: ['FD'] });
  const vC = mkVerdictFor('upstream-preview', srcBundle3, { findings: [], closed_finding_ids: [] });
  const changedPaths = new Set(['src/writer.ts', 'src/deleter.ts']);
  const artifact = runConsensusGate([vA, vB, vC], { bundle: srcBundle3, changedPaths });
  eq(artifact.gate_result, 'pass', JSON.stringify(artifact.fail_reasons ?? []));
  eq(artifact.canonical_findings.length, 2, '两条不相关 finding 必须保持独立的 canonical 记录（锚点/证据都不同，不因同标签合并）');
  const cfWriter = artifact.canonical_findings.find((f) => f.anchor === fdWriter.anchor);
  const cfDelete = artifact.canonical_findings.find((f) => f.anchor === fdDelete.anchor);
  ok(cfWriter && cfDelete, '两条 canonical finding 都必须存在');
  ok(cfWriter.family_key !== cfDelete.family_key, 'D1 核心: 同 family_id 标签（都是 F1）但不同 invariant 的两条 finding，family_key 必须不同（不得被旧实现按标签字符串误合并）');
  // 派工包层面同样验证不会被错误合并
  const scManifest = { schema_version: 'v2', consensus_artifact_hash: artifact.consensus_artifact_hash,
    scs: withScAttribution([
      { id: 'SC-W', kind: 'fix', finding_ids: [cfWriter.id], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-D', kind: 'fix', finding_ids: [cfDelete.id], change: 'c', holds: 'h', verify: VF() }
    ], artifact) };
  const ctx = ORC.familyContext({ artifact, manifest: scManifest, scIds: ['SC-W', 'SC-D'] });
  eq(ctx['SC-W'].manifestations.length, 0, 'SC-W 不得把 SC-D 当成同 family 的 manifestation（两者 family_key 不同）');
  eq(ctx['SC-D'].manifestations.length, 0, 'SC-D 同理不得把 SC-W 当成同 family 的 manifestation');
});

t('[SC-B1-WM/D1-反例②] 同一 invariant 被标了不同的 family_id 标签 → family_key 相同 → 必须正确合并', () => {
  // 同一份 verdict 里，reviewer 疏忽把同一个不变量的两处表现标成了不同的本地标签
  // （family_id 分别是 "LABEL-A" 与 "LABEL-B"），但 invariant 文本逐字相同——这在
  // verdict-validate 层是合法的（自洽校验只检查"同标签下 invariant 必须一致"，不禁止
  // "同 invariant 用不同标签"）。family_key 从 invariant 派生，必须能看穿标签差异，
  // 正确判定这两条属于同一 family。
  const art = artifactWithFindings([
    { sev: 'major', paths: ['src/p1.ts'], invariant: '缓存失效必须与写路径同一事务', family_id: 'LABEL-A' },
    { sev: 'major', paths: ['src/p2.ts'], invariant: '缓存失效必须与写路径同一事务', family_id: 'LABEL-B' }
  ]);
  const idOf = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  eq(art.canonical_findings[0].family_key, art.canonical_findings[1].family_key,
    'D1 核心: 同 invariant 但不同 family_id 标签，两条 canonical finding 的 family_key 必须相同');
  const scManifest = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: withScAttribution([
      { id: 'SC-P1', kind: 'fix', finding_ids: [idOf(0)], change: 'c', holds: 'h', verify: VF() },
      { id: 'SC-P2', kind: 'fix', finding_ids: [idOf(1)], change: 'c', holds: 'h', verify: VF() }
    ], art) };
  const ctx = ORC.familyContext({ artifact: art, manifest: scManifest, scIds: ['SC-P1', 'SC-P2'] });
  eq(ctx['SC-P1'].manifestations.length, 1, 'SC-P1 必须看到 SC-P2 是同 family 的另一处 manifestation（正确合并，不因标签不同而漏检）');
  eq(ctx['SC-P1'].manifestations[0].sc_id, 'SC-P2');
  eq(ctx['SC-P2'].manifestations.length, 1, 'SC-P2 同理必须看到 SC-P1');
});

t('[SC-B4] hardening-checklist.md 文档一致性: 十类齐全 + 第 10 类判据所有权/跨门兼容展开 + hub⊥coverage 实证案例', () => {
  const doc = readFileSync(join(S, '../skills/submit-pr/references/hardening-checklist.md'), 'utf8');
  ok(doc.includes('| 10 |') && doc.includes('判据所有权与跨门兼容'), '文档必须有第 10 类表格行');
  ok(doc.includes('第 10 类展开'), '文档必须有第 10 类的展开小节');
  ok(doc.includes('形态①') && doc.includes('形态②'), '文档必须区分两种形态');
  ok(doc.includes('hub 门') && doc.includes('coverage 门') && doc.includes('单文件 PR'), '文档必须给出 hub⊥coverage 死锁的实证案例');
  ok(doc.includes('可移除性'), '文档必须点出 D1 的可移除性判据作为真正解法');
  ok(doc.includes('十类'), '文档标题/正文必须已更新为十类（不留九类残留表述于用法边界段）');
  // 单一来源提醒必须在场，防止未来又四处手抄数字
  ok(doc.includes('hardening-registry.mjs'), '文档必须点名单一来源常量文件');
});

t('[D6] schemas/review-verdict.schema.json 的 class_id maximum 必须与 hardening-registry.mjs 的 HARDENING_CLASS_COUNT 一致（不能只靠注释提醒，机器断言）', () => {
  const schema = JSON.parse(readFileSync(join(S, '..', 'schemas', 'review-verdict.schema.json'), 'utf8'));
  const classIdSchema = schema.properties?.hardening_coverage?.items?.properties?.class_id;
  ok(classIdSchema, 'schema 必须有 hardening_coverage.items.properties.class_id 节点');
  eq(classIdSchema.maximum, HARDENING_CLASS_COUNT, `schema 的 class_id maximum（${classIdSchema.maximum}）必须等于 HARDENING_CLASS_COUNT（${HARDENING_CLASS_COUNT}）——两处手抄数字漂移必须被机器抓到，不能只靠代码注释里的"务必同步"提醒`);
  eq(classIdSchema.minimum, 1, 'class_id minimum 应恒为 1');
});

t('[SC-B2] pr-body.mjs: MUST-FIX 按 family 去重 + ARCHIVE 措辞「已登记接受」+ 不外泄证据原文', () => {
  // secretEvidence 是每条 finding 的 evidence 原文（模拟三审 verdict 里可能带内部路径/上下文
  // 的证据长文本）——canonical finding 结构上从不携带 evidence（consensus-gate.mjs 只用它算
  // 语义指纹，不落进 canonical 记录），本测试直接断言：即便 evidence 里塞了独特的敏感标记，
  // 生成的 PR body 段里也不会出现该标记（真正验证「不外泄」，不是靠 canonical 记录本就没有
  // 这个字段来空转过关）。
  const secretEvidence = (tag) => `内部路径 /etc/very-secret/${tag}.txt 与凭证片段 SECRET-MARKER-${tag} 不得外泄`;
  const art = artifactWithFindings([
    { sev: 'major', paths: ['src/fam-1.ts'], invariant: '共享的不变量文本', family_id: 'FAM-SHARE', evidence: secretEvidence('A') },
    { sev: 'major', paths: ['src/fam-2.ts'], invariant: '共享的不变量文本', family_id: 'FAM-SHARE', evidence: secretEvidence('B') },
    { sev: 'blocker', paths: ['src/solo.ts'], invariant: '独立的不变量', family_id: 'FAM-SOLO', evidence: secretEvidence('C') },
    { sev: 'major', paths: ['src/arch.ts'], invariant: '残余风险不变量', family_id: 'FAM-ARCH', evidence: secretEvidence('D') }
  ]);
  const idOf = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const manifest = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash, scs: withScAttribution([
    { id: 'SC-1', kind: 'fix', finding_ids: [idOf(0)], change: 'c', holds: 'h', verify: VF() },
    { id: 'SC-2', kind: 'fix', finding_ids: [idOf(1)], change: 'c', holds: 'h', verify: VF() },
    { id: 'SC-3', kind: 'fix', finding_ids: [idOf(2)], change: 'c', holds: 'h', verify: VF() },
    { id: 'SC-ARCH', kind: 'archive', finding_ids: [idOf(3)], change: 'c', holds: 'README.md 含约定文案', verify: VF('grep', ['-q', 'x', 'README.md']) }
  ], art) };
  const section = buildInvariantsSection({ artifact: art, manifest });
  ok(section.startsWith(SECTION_START) && section.endsWith(SECTION_END), '生成段必须被 marker 完整包围');
  // MUST-FIX 按 family 去重: FAM-SHARE 只出现一次 invariant 文本，但两条 manifestation 都列出
  const shareCount = (section.match(/共享的不变量文本/g) ?? []).length;
  eq(shareCount, 1, '同 family 的 invariant 文本只应出现一次（去重）');
  ok(section.includes('SC-1') && section.includes('SC-2'), '同 family 的两条 manifestation（各自 sc_id）都必须列出');
  ok(section.includes('独立的不变量') && section.includes('SC-3'), 'FAM-SOLO 也必须列出');
  // ARCHIVE 措辞: 必须是「已登记接受」，不得出现「已修复」
  ok(section.includes('已登记接受'), 'ARCHIVE 项措辞必须是「已登记接受」');
  ok(!section.includes('已修复'), 'ARCHIVE 段不得出现「已修复」措辞（D2: 不是修复，是文档化接受）');
  // 不外泄敏感证据原文——四条 finding 的 evidence 里各自唯一的 SECRET-MARKER-{A,B,C,D} 一个都
  // 不得出现在生成的段落里（真正的反证：先证明这些字符串确实在输入里，再证明它们不在输出里）
  for (const tag of ['A', 'B', 'C', 'D']) {
    ok(secretEvidence(tag).length > 0); // 前提健全性
    ok(!section.includes(`SECRET-MARKER-${tag}`), `finding evidence 里的敏感标记 SECRET-MARKER-${tag} 不得出现在 PR body 锚点段`);
  }
});

t('[SC-B2] pr-body.mjs: 幂等 upsert——marker 存在则整段替换保留 owner 手写正文；不存在则追加', () => {
  const artA = artifactWithFindings([{ sev: 'major', paths: ['src/v1.ts'], invariant: '版本一不变量', family_id: 'FAM-V1' }]);
  const manifestA = { schema_version: 'v2', consensus_artifact_hash: artA.consensus_artifact_hash,
    scs: withScAttribution([{ id: 'SC-1', kind: 'fix', finding_ids: [artA.canonical_findings[0].id], change: 'c', holds: 'h', verify: VF() }], artA) };
  const sectionA = buildInvariantsSection({ artifact: artA, manifest: manifestA });

  // 首次生成: owner 手写正文保留在前，marker 段追加在后
  const ownerBody = '## 这是 owner 手写的正文\n\n一些说明文字。';
  const firstBody = upsertInvariantsSection(ownerBody, sectionA);
  ok(firstBody.startsWith(ownerBody), '首次生成必须保留 owner 手写正文在前');
  ok(firstBody.includes(SECTION_START) && firstBody.includes('版本一不变量'), '首次生成必须包含锚点段内容');

  // 第二轮（换了新 artifact/manifest）: 只替换 marker 段，owner 手写正文原样不变
  const artB = artifactWithFindings([{ sev: 'major', paths: ['src/v2.ts'], invariant: '版本二不变量', family_id: 'FAM-V2' }]);
  const manifestB = { schema_version: 'v2', consensus_artifact_hash: artB.consensus_artifact_hash,
    scs: withScAttribution([{ id: 'SC-2', kind: 'fix', finding_ids: [artB.canonical_findings[0].id], change: 'c', holds: 'h', verify: VF() }], artB) };
  const sectionB = buildInvariantsSection({ artifact: artB, manifest: manifestB });
  const secondBody = upsertInvariantsSection(firstBody, sectionB);
  ok(secondBody.startsWith(ownerBody), '二次 upsert 必须保留 owner 手写正文不变');
  ok(secondBody.includes('版本二不变量'), '二次 upsert 必须换成新内容');
  ok(!secondBody.includes('版本一不变量'), '二次 upsert 不得残留旧版本内容（整段替换，不是追加）');
  eq((secondBody.match(new RegExp(SECTION_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1, 'marker 不得重复叠加');

  // 幂等: 用同一份 section 再 upsert 一次，结果必须字节级不变
  const thirdBody = upsertInvariantsSection(secondBody, sectionB);
  eq(thirdBody, secondBody, '同内容重复 upsert 必须幂等（字节级不变）');
});

t('[SC-B4-D4] pr-body.mjs: checkpoint 六件套用独立第二对 marker，不与 MUST-FIX/ARCHIVE 锚点段互相覆盖', () => {
  const art = artifactWithFindings([{ sev: 'major', paths: ['src/ckpt.ts'], invariant: '取消后任何迟到的 start 都不得重新激活', family_id: 'FAM-CKPT' }]);
  const manifest = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: withScAttribution([{ id: 'SC-1', kind: 'fix', finding_ids: [art.canonical_findings[0].id], change: 'c', holds: 'h', verify: VF() }], art) };
  const invariantsSection = buildInvariantsSection({ artifact: art, manifest });
  const checkpoint = {
    trigger: '触发条件①: 上一轮修复漏了对称的另一半',
    invariants: [{ family: 'cancel-race', statement: '取消后任何迟到的 start 都不得重新激活' }],
    state_owners: [{ field: 'session.status', owner: 'SessionManager.transition()', lifecycle: 'created→active→cancelled|completed' }],
    event_state_matrix: [{ event: 'late-start', state: 'cancelled', action: '拒绝', reason: '终态后到达的 start 必须被拒绝，不得重新激活' }],
    symmetry_audit: [{ path: 'cancel', status: 'covered', note: '已加 guard' }, { path: '迟到', status: 'covered' }],
    normalization: [{ semantic: '终态判定', consolidated_to: 'isTerminal(status)' }],
    tests: [{ name: 'late-start-after-cancel.test.ts', distinguishes: '旧补丁只挡了同步路径，本测试对异步迟到路径同样断言拒绝，对旧补丁应该红' }]
  };
  const checkpointSection = buildCheckpointSection(checkpoint);
  ok(checkpointSection.startsWith(CHECKPOINT_SECTION_START) && checkpointSection.endsWith(CHECKPOINT_SECTION_END), 'checkpoint 段必须被自己的 marker 完整包围');
  ok(checkpointSection.includes('取消后任何迟到的 start 都不得重新激活'), '六件套第 1 项内容必须渲染进去');
  ok(checkpointSection.includes('late-start-after-cancel.test.ts'), '六件套第 6 项内容必须渲染进去');

  // 两段各自独立 upsert：先写不变量段，再写 checkpoint 段——互不覆盖
  let body = upsertInvariantsSection('', invariantsSection);
  body = upsertCheckpointSection(body, checkpointSection);
  ok(body.includes(SECTION_START) && body.includes(CHECKPOINT_SECTION_START), '两对 marker 必须同时存在');
  ok(body.includes('src/ckpt.ts') || body.includes('FAM-CKPT') || body.includes(art.canonical_findings[0].family_key), '不变量段内容必须还在');
  ok(body.includes('late-start-after-cancel.test.ts'), 'checkpoint 段内容必须还在');

  // 重新生成不变量段（比如 SC 变了）→ 只替换自己的 marker 段，checkpoint 段原样不动
  const art2 = artifactWithFindings([{ sev: 'major', paths: ['src/ckpt2.ts'], invariant: '另一条不变量', family_id: 'FAM-CKPT2' }]);
  const manifest2 = { schema_version: 'v2', consensus_artifact_hash: art2.consensus_artifact_hash,
    scs: withScAttribution([{ id: 'SC-2', kind: 'fix', finding_ids: [art2.canonical_findings[0].id], change: 'c', holds: 'h', verify: VF() }], art2) };
  const body2 = upsertInvariantsSection(body, buildInvariantsSection({ artifact: art2, manifest: manifest2 }));
  ok(body2.includes('另一条不变量'), '不变量段必须换成新内容');
  ok(body2.includes('late-start-after-cancel.test.ts'), 'D4 核心: 重新生成不变量段不得吃掉 checkpoint 段（旧契约的矛盾就在这里）');

  // 反过来: 重新生成 checkpoint 段，不变量段原样不动
  const checkpoint2 = { ...checkpoint, tests: [{ name: 'other-test.test.ts', distinguishes: '换一批测试' }] };
  const body3 = upsertCheckpointSection(body2, buildCheckpointSection(checkpoint2));
  ok(body3.includes('other-test.test.ts') && !body3.includes('late-start-after-cancel.test.ts'), 'checkpoint 段必须换成新内容（整段替换）');
  ok(body3.includes('另一条不变量'), 'D4 核心: 重新生成 checkpoint 段不得吃掉不变量段');
});

t('[SC-B4-D4] pr-body.mjs: 半残/重复 marker → fail loud 拒绝写入，不得静默追加第二段', () => {
  const section = buildInvariantsSection({ artifact: artifactWithFindings([{ sev: 'major', paths: ['src/x.ts'], invariant: 'x', family_id: 'FX' }]), manifest: { schema_version: 'v2', scs: [] } });
  // 只有 start，没有 end（上一次写入过程中被截断/被人手改坏）
  const halfStart = `owner 正文\n${SECTION_START}\n一些残留内容但没有 end`;
  let threw1 = false;
  try { upsertInvariantsSection(halfStart, section); } catch (e) { threw1 = /残缺\/重复/.test(e.message); }
  ok(threw1, '只有 start 没有 end 必须 fail loud');
  // 只有 end，没有 start
  const halfEnd = `owner 正文\n一些残留内容\n${SECTION_END}`;
  let threw2 = false;
  try { upsertInvariantsSection(halfEnd, section); } catch (e) { threw2 = /残缺\/重复/.test(e.message); }
  ok(threw2, '只有 end 没有 start 必须 fail loud');
  // start 重复两次
  const dupStart = `${SECTION_START}\nA\n${SECTION_START}\nB\n${SECTION_END}`;
  let threw3 = false;
  try { upsertInvariantsSection(dupStart, section); } catch (e) { threw3 = /残缺\/重复/.test(e.message); }
  ok(threw3, 'start 重复两次必须 fail loud');
  // end 出现在 start 之前（顺序损坏）
  const reversed = `${SECTION_END}\n中间\n${SECTION_START}`;
  let threw4 = false;
  try { upsertInvariantsSection(reversed, section); } catch (e) { threw4 = /顺序损坏/.test(e.message); }
  ok(threw4, 'end 在 start 之前必须 fail loud（顺序损坏）');
  // 合法的一对 marker 仍应正常工作（对照组：不是所有输入都拒）
  const healthy = `owner 正文\n${SECTION_START}\n旧内容\n${SECTION_END}`;
  const result = upsertInvariantsSection(healthy, section);
  ok(result.includes('owner 正文') && !result.includes('旧内容'), '合法 marker 对照组必须正常替换，不受上面异常路径影响');
  // 两对独立 marker（invariants + checkpoint）各自的半残检测互不干扰——只坏了 checkpoint 段的
  // marker 时，upsertInvariantsSection 不应受影响（各自扫描自己的 marker，不会扫到对方的）
  const onlyCheckpointBroken = `${SECTION_START}\nok\n${SECTION_END}\n${CHECKPOINT_SECTION_START}\n半残 checkpoint，没有 end`;
  const okResult = upsertInvariantsSection(onlyCheckpointBroken, section);
  ok(!okResult.includes('半残') || okResult.includes(CHECKPOINT_SECTION_START), '不变量段自己的 marker 完好时，checkpoint 段损坏不应影响 upsertInvariantsSection 本身');
  let threwCkpt = false;
  try { upsertCheckpointSection(onlyCheckpointBroken, buildCheckpointSection({})); } catch (e) { threwCkpt = /残缺\/重复/.test(e.message); }
  ok(threwCkpt, 'checkpoint 段自己的 marker 半残时，upsertCheckpointSection 必须 fail loud');
});

// ========== PR-B1 意图契约（SC-4/5/18，2026-08-06） ==========

t('[B1-SC4] intent marker 经 pr_body 参与 review_input_hash：改 marker 必换 hash', () => {
  const intentA = '目标: 修 X\n非目标: 不动 Y\n验收: 测试 Z 绿';
  const intentB = '目标: 修 X 并顺手改 Y\n非目标: (无)\n验收: 测试 Z 绿';
  const bodyA = `正文开头\n\n${buildMarkerBlock(intentA)}\n\n正文结尾`;
  const bodyB = `正文开头\n\n${buildMarkerBlock(intentB)}\n\n正文结尾`;
  ok(computeReviewInputHash({ ...bundle, pr_body: bodyA }) !== computeReviewInputHash({ ...bundle, pr_body: bodyB }),
    '仅 marker 区块不同的两个 body 必须产生不同 review_input_hash');
  eq(extractIntentMarker(bodyA).trim(), intentA);
});

t('[B1-SC18] 文件与 marker digest 不一致 → MISMATCH exit 1', () => {
  const intent = '目标: A\n非目标: B\n验收: C';
  const res = evaluateIntent({ fileContent: '目标: A（本机偷偷改过）', prBody: buildMarkerBlock(intent) });
  eq(res.status, 'MISMATCH');
  eq(res.exit, 1);
  // 一致（含行尾空白/CRLF 归一化差异）→ OK
  const same = evaluateIntent({ fileContent: `${intent.replace(/\n/g, '\r\n')}  \n`, prBody: buildMarkerBlock(intent) });
  eq(same.status, 'OK');
  eq(same.exit, 0);
});

t('[B1-SC5] 双缺 fallback：生成 [auto-generated] marker，落 body 后才 OK 且 fallback 结果入锅', () => {
  const bareBody = '这个 PR 修复了 X 的空指针问题。\n\n细节略。';
  const res = evaluateIntent({ fileContent: null, prBody: bareBody });
  eq(res.status, 'FALLBACK');
  eq(res.exit, 2);
  ok(res.marker_block.includes('[auto-generated]'), 'fallback 意图必须显式标注 auto-generated');
  // 模拟 lead 把 marker 写回 body 后重跑 → REBUILT(缺文件)/OK，且新 body 的 hash 与裸 body 不同（入锅证据）
  const bodyWithMarker = `${bareBody}\n\n${res.marker_block}`;
  const rerun = evaluateIntent({ fileContent: null, prBody: bodyWithMarker });
  eq(rerun.status, 'REBUILT');
  eq(rerun.exit, 0);
  ok(computeReviewInputHash({ ...bundle, pr_body: bodyWithMarker }) !== computeReviewInputHash({ ...bundle, pr_body: bareBody }),
    'fallback 生成的 marker 必须改变 review_input_hash（入锅）');
  // 半残 marker（只有 start 没有 end）按缺失处理
  eq(extractIntentMarker(`${bareBody}\n<!-- pr-intent:start -->\n目标: 半残`), null);
  // 文件在、marker 缺 → MARKER_MISSING exit 2，输出的区块内容与文件一致
  const mm = evaluateIntent({ fileContent: '目标: 只有文件', prBody: bareBody });
  eq(mm.status, 'MARKER_MISSING');
  eq(mm.exit, 2);
  ok(mm.marker_block.includes('目标: 只有文件'));
  ok(fallbackIntentFromBody('').includes('目标句待 owner 补写'));
});

t('[B1-F1] CLI 级 REBUILT 无条件落盘：exit 0 时 .pr-intent.md 必然存在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b1f1-'));
  const bodyPath = join(dir, 'body.md');
  const intentPath = join(dir, '.pr-intent.md');
  const intent = '目标: CLI 重建\n非目标: 无\n验收: 文件落盘';
  writeFileSync(bodyPath, `正文\n\n${buildMarkerBlock(intent)}\n`);
  const out = execFileSync(process.execPath, [join(S, 'intent-check.mjs'), '--pr-body', bodyPath, '--intent-file', intentPath], { encoding: 'utf8' });
  eq(JSON.parse(out).status, 'REBUILT');
  ok(existsSync(intentPath), 'REBUILT exit 0 后工作副本必须已落盘（审①B1-F1：不设 --write 开关）');
  eq(readFileSync(intentPath, 'utf8').trim(), intent);
  // 重跑同参数 → 两副本一致 OK
  const out2 = execFileSync(process.execPath, [join(S, 'intent-check.mjs'), '--pr-body', bodyPath, '--intent-file', intentPath], { encoding: 'utf8' });
  eq(JSON.parse(out2).status, 'OK');
  rmSync(dir, { recursive: true, force: true });
});

// ========== PR-B2 size-gate 双闸（SC-6/7/19/20/21，2026-08-06） ==========
console.log('\n[B2] size-gate 双闸（真实 git 仓）');
{
  const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}-${i}`).join('\n') + '\n';
  const mkRepo = () => {
    const d = mkdtempSync(join(tmpdir(), 'sg-'));
    const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'fx@test'); g('config', 'user.name', 'fx');
    writeFileSync(join(d, 'a.txt'), '1\n'); g('add', '.'); g('commit', '-qm', 'base');
    return { d, g, base: g('rev-parse', 'HEAD') };
  };

  t('[B2-SC6] 统计契约: add+delete 非测试行/排除并集/binary 不计行/rename 原样/配置 fallback 与 repo 源', () => {
    const { d, g, base } = mkRepo();
    g('checkout', '-qb', 'feat');
    writeFileSync(join(d, 'src.js'), lines(300, 's'));
    mkdirSync(join(d, 'tests'), { recursive: true });
    writeFileSync(join(d, 'tests/x.test.js'), lines(500, 't'));
    writeFileSync(join(d, 'package-lock.json'), lines(1000, 'l'));
    writeFileSync(join(d, 'img.bin'), Buffer.from([0, 1, 2, 255, 0, 7]));
    g('add', '.'); g('commit', '-qm', 'f1');
    // 纯 rename（内容不变）→ numstat 0/0,贡献 0 行（rename 按 numstat 原样,不重复计整文件）
    g('mv', 'a.txt', 'renamed.txt');
    g('add', '.'); g('commit', '-qm', 'f2');
    // 无 pr-rules.json → default 配置
    const r1 = computeSizeReport({ repoDir: d, baseRef: base });
    eq(r1.config_source, 'default');
    eq(r1.counted_lines, 300, 'src 300;纯 rename 0 行(numstat 原样)');
    ok(r1.excluded_files.includes('tests/x.test.js') && r1.excluded_files.includes('package-lock.json'));
    ok(r1.binary_files.includes('img.bin'), 'binary 不计行但上报');
    rmSync(d, { recursive: true, force: true });
    // 第二仓：配置在 base(main) 树上 → source='base'，排除并集生效
    const R2 = mkRepo();
    mkdirSync(join(R2.d, 'agent-use/docs'), { recursive: true });
    writeFileSync(join(R2.d, 'agent-use/docs/pr-rules.json'), JSON.stringify({ sizeGate: { budgetLines: 100, warnRatio: 0.5, excludePaths: ['(^|/)vendor/'], _comment: '测试' } }));
    R2.g('add', '.'); R2.g('commit', '-qm', 'rules');
    const base2 = R2.g('rev-parse', 'HEAD');
    R2.g('checkout', '-qb', 'feat');
    writeFileSync(join(R2.d, 'src.js'), lines(300, 's'));
    mkdirSync(join(R2.d, 'vendor'), { recursive: true });
    writeFileSync(join(R2.d, 'vendor/lib.js'), lines(400, 'v'));
    R2.g('add', '.'); R2.g('commit', '-qm', 'f1');
    const r2 = evaluateSize(computeSizeReport({ repoDir: R2.d, baseRef: base2 }));
    eq(r2.config_source, 'base');
    ok(r2.excluded_files.includes('vendor/lib.js'), '配置排除与内置排除取并集');
    eq(r2.result, 'STOP', '300 行 ≥ 预算 100');
    // 审 B2-F1 复现已死：被测 PR 自带宽配置（天价预算+排除自己）→ 配置仍取 base 树，照样 STOP
    writeFileSync(join(R2.d, 'agent-use/docs/pr-rules.json'), JSON.stringify({ sizeGate: { budgetLines: 999999, excludePaths: ['^src\\.js$', '^huge\\.js$'] } }));
    writeFileSync(join(R2.d, 'huge.js'), lines(5000, 'h'));
    R2.g('add', '.'); R2.g('commit', '-qm', '自改闸门尝试');
    const r3 = evaluateSize(computeSizeReport({ repoDir: R2.d, baseRef: base2 }));
    eq(r3.config_source, 'base', '候选树的配置修改不得生效');
    eq(r3.config.budgetLines, 100);
    ok(r3.counted_files.includes('huge.js') && r3.counted_files.includes('src.js'), '候选自写的排除不得生效');
    eq(r3.result, 'STOP');
    rmSync(R2.d, { recursive: true, force: true });
  });

  t('[B2-SC7] 三档边界: <75% PASS / ≥75% WARN / ≥100% STOP;STOP CLI exit 1', () => {
    const cfg = { budgetLines: 800, warnRatio: 0.75, excludePaths: [] };
    const at = (n) => evaluateSize({ counted_lines: n, config: cfg }).result;
    eq(at(599), 'PASS'); eq(at(600), 'WARN'); eq(at(799), 'WARN'); eq(at(800), 'STOP');
    // CLI STOP → exit 1（配置提交在 base 树上）
    const { d, g } = mkRepo();
    mkdirSync(join(d, 'agent-use/docs'), { recursive: true });
    writeFileSync(join(d, 'agent-use/docs/pr-rules.json'), JSON.stringify({ sizeGate: { budgetLines: 50 } }));
    g('add', '.'); g('commit', '-qm', 'rules');
    const base = g('rev-parse', 'HEAD');
    g('checkout', '-qb', 'feat');
    writeFileSync(join(d, 'big.js'), lines(200, 'b'));
    g('add', '.'); g('commit', '-qm', 'big');
    let code = 0;
    try { execFileSync(process.execPath, [join(S, 'size-gate.mjs'), '--repo-dir', d, '--base', base], { encoding: 'utf8' }); }
    catch (e) { code = e.status; }
    eq(code, 1, 'STOP 必须非零退出');
    rmSync(d, { recursive: true, force: true });
  });

  t('[B2-SC19] base 树配置 malformed 一律 fail-closed(不回退默认);缺失才 fallback', () => {
    const commitRules = (content) => {
      const { d, g } = mkRepo();
      mkdirSync(join(d, 'agent-use/docs'), { recursive: true });
      writeFileSync(join(d, 'agent-use/docs/pr-rules.json'), content);
      g('add', '.'); g('commit', '-qm', 'rules');
      return { d, ref: g('rev-parse', 'HEAD') };
    };
    const cases = [
      JSON.stringify({ sizeGate: { budgetLines: '800' } }),
      JSON.stringify({ sizeGate: { warnRatio: 1.5 } }),
      JSON.stringify({ sizeGate: { excludePaths: ['([bad'] } }),
      JSON.stringify({ sizeGate: [] }),
      '{broken'
    ];
    for (const content of cases) {
      const { d, ref } = commitRules(content);
      let threw = false;
      try { loadSizeGateConfig(d, ref); } catch { threw = true; }
      ok(threw, `应 fail-closed: ${content.slice(0, 60)}`);
      rmSync(d, { recursive: true, force: true });
    }
    // base 树无该文件 / 无 sizeGate 字段 → fallback 默认
    const { d: d2, g: g2, base: b2 } = mkRepo();
    eq(loadSizeGateConfig(d2, b2).source, 'default');
    mkdirSync(join(d2, 'agent-use/docs'), { recursive: true });
    writeFileSync(join(d2, 'agent-use/docs/pr-rules.json'), JSON.stringify({ titleTypes: [] }));
    g2('add', '.'); g2('commit', '-qm', 'no-sizegate');
    eq(loadSizeGateConfig(d2, g2('rev-parse', 'HEAD')).source, 'default');
    rmSync(d2, { recursive: true, force: true });
  });

  t('[B2-SC20+SC21] push-guard 终闸: 入口 PASS→修复轮膨胀→终版 STOP 拒 push;豁免绑 head 变更即失效', () => {
    const d = mkdtempSync(join(tmpdir(), 'sgpg-'));
    const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'fx@test'); g('config', 'user.name', 'fx');
    writeFileSync(join(d, 'a.txt'), '1\n'); g('add', '.'); g('commit', '-qm', 'base');
    mkdirSync(join(d, 'agent-use/docs'), { recursive: true });
    writeFileSync(join(d, 'agent-use/docs/pr-rules.json'), JSON.stringify({ sizeGate: { budgetLines: 100, warnRatio: 0.75 } }));
    g('add', '.'); g('commit', '-qm', 'rules'); // 配置必须在 base 树上（审 B2-F1 后语义）
    const base2 = g('rev-parse', 'HEAD');
    g('remote', 'add', 'origin', 'https://github.com/o/r.git');
    g('update-ref', 'refs/remotes/origin/main', base2);
    g('checkout', '-qb', 'feat');
    writeFileSync(join(d, 'src.js'), lines(50, 's')); g('add', '.'); g('commit', '-qm', 'r1');
    // 入口闸(50+1 行 < 75)应 PASS/WARN 以下
    const entry = evaluateSize(computeSizeReport({ repoDir: d, baseRef: base2 }));
    eq(entry.result, 'PASS', `入口应 PASS,实际 ${entry.result}:${entry.counted_lines}`);
    // 修复轮膨胀
    writeFileSync(join(d, 'src2.js'), lines(120, 'x')); g('add', '.'); g('commit', '-qm', 'r2-膨胀');
    const head2 = g('rev-parse', 'HEAD');
    const b2 = mkBundle(base2, head2);
    const { artifact: art2 } = consensusFor(b2);
    const man2 = { repo: 'o/r', remote: 'origin', branch: 'feat', expected_sha: head2, purpose: 'feature', consensus_artifact_hash: art2.consensus_artifact_hash };
    const rStop = checkPushGuard({ repoDir: d, manifest: man2, artifact: art2, bundle: b2, constitution });
    ok(!rStop.ok && rStop.errors.some((e) => /size 终闸 STOP/.test(e)), `终版膨胀必须拒 push: ${rStop.errors.join(';')}`);
    // 有效豁免（绑当前 head）→ 放行且回执标 exempted
    const exOk = { repo: 'o/r', branch: 'feat', base_sha: base2, head_sha: head2, lineCount: 171, at: '2026-08-06T00:00:00Z', reason: 'owner 当次豁免' };
    const rEx = checkPushGuard({ repoDir: d, manifest: man2, artifact: art2, bundle: b2, constitution, sizeExemption: exOk });
    ok(rEx.ok, rEx.errors.join(';'));
    ok(rEx.size_report.exempted === true && rEx.size_report.result === 'STOP');
    // 豁免绑旧 head（head 又变了）→ 失效
    writeFileSync(join(d, 'src3.js'), 'one-more-line\n'); g('add', '.'); g('commit', '-qm', 'r3');
    const head3 = g('rev-parse', 'HEAD');
    const b3 = mkBundle(base2, head3);
    const { artifact: art3 } = consensusFor(b3);
    const man3 = { ...man2, expected_sha: head3, consensus_artifact_hash: art3.consensus_artifact_hash };
    const rStale = checkPushGuard({ repoDir: d, manifest: man3, artifact: art3, bundle: b3, constitution, sizeExemption: exOk });
    ok(!rStale.ok && rStale.errors.some((e) => /head 变化即失效/.test(e)), `旧豁免必须失效: ${rStale.errors.join(';')}`);
    // 豁免字段缺失/空 reason → 无效
    ok(exemptionInvalidReason({ ...exOk, reason: ' ' }, { head_sha: head2 }) !== null);
    ok(exemptionInvalidReason((({ reason, ...rest }) => rest)(exOk), { head_sha: head2 }) !== null);
    rmSync(d, { recursive: true, force: true });
  });
}

// ========== 24. D1 派工契约 / D2 格式预检 / D3 域外通道（2026-08-06 三缺陷修复） ==========
console.log('\n[24] D1 dispatch-contract · D2 pr-format-gate · D3 out_of_scope_notes');

// ── D1: 派工包机器契约段 ──
t('[D1-DC] emit→check 闭环: 三席 × round 1/2 的 emit 输出必过自身 check（正向）', () => {
  for (const seat of SEATS) {
    for (const round of [1, 2]) {
      const text = emitContract({ seat, round });
      const r = checkDispatchPackage(text, { seat, round });
      ok(r.ok, `emit 输出必过 check: seat=${seat} round=${round} missing=${JSON.stringify(r.missing)}`);
      // 契约段被粘进更大的派工包文本里也必须过（check 是 substring 匹配，不是整体等值）
      ok(checkDispatchPackage(`前言\n${text}\n后记`, { seat, round }).ok, '嵌入更大文本仍应过');
    }
  }
});

t('[D1-DC] 反向: 逐个删掉任一必需字面值 → check 必拦且点名该项（含四个 canonical gate_id）', () => {
  const seat = 'upstream-preview', round = 1;
  const text = emitContract({ seat, round });
  const lits = requiredLiterals({ seat, round });
  ok(lits.length >= 10, `必需字面值数量异常: ${lits.length}`);
  for (const lit of lits) {
    // 用不可能出现在契约里的替换串抹掉该字面值的全部出现
    const broken = text.split(lit).join('§ABSENT§');
    const r = checkDispatchPackage(broken, { seat, round });
    ok(!r.ok, `抹掉「${lit}」后 check 必须拦`);
    ok(r.missing.includes(lit), `missing 必须点名「${lit}」，得到 ${JSON.stringify(r.missing)}`);
  }
  // D1 事故本体: 第三席派工包缺 gate_id 就是这条路径
  for (const g of DEFAULT_REQUIREMENTS.third_seat_required_gates) {
    ok(lits.includes(g), `第三席必需字面值必须含 canonical gate_id「${g}」`);
    ok(!checkDispatchPackage(text.split(g).join('x'), { seat, round }).ok, `缺 ${g} 必拦`);
  }
});

t('[D1-DC] 单一真相源: gate 集合从 requirements 派生——新增第 5 个 gate，emit 与 requiredLiterals 同时自动跟上', () => {
  const seat = 'upstream-preview', round = 1;
  const requirements = { third_seat_required_gates: [...DEFAULT_REQUIREMENTS.third_seat_required_gates, 'brand-new-gate'] };
  const text = emitContract({ seat, round, requirements });
  ok(text.includes('brand-new-gate'), 'emit 必须自动包含新增 gate_id（否则就是手写清单，回到 D1 的漂移）');
  ok(requiredLiterals({ seat, round, requirements }).includes('brand-new-gate'), 'requiredLiterals 同样必须自动跟上');
  // 反向: 默认契约的 emit 文本里不该出现它（证明上一条不是常量硬编码巧合）
  ok(!emitContract({ seat, round }).includes('brand-new-gate'), '默认契约不应含该 gate');
});

t('[D1-DC] digest 反漂移: 粘贴陈旧契约段必被拦（旧 digest 与当前重算值失配）', () => {
  const seat = 'upstream-preview', round = 1;
  const requirements = { third_seat_required_gates: [...DEFAULT_REQUIREMENTS.third_seat_required_gates, 'brand-new-gate'] };
  const oldText = emitContract({ seat, round });               // 契约变更**前**生成的段落
  const rStale = checkDispatchPackage(oldText, { seat, round, requirements }); // 用变更**后**的契约校验
  ok(!rStale.ok, '陈旧契约段必须被拦');
  ok(rStale.missing.some((m) => m.startsWith('contract_digest=')), `失配必须体现在 digest 上: ${JSON.stringify(rStale.missing)}`);
  ok(rStale.missing.includes('brand-new-gate'), '同时必须点名缺失的新 gate');
  // 只改 digest 一个字符（其余字面值都在）→ 仍必须拦
  const d = contractDigest(contractSpec({ seat, round }));
  const tampered = emitContract({ seat, round }).replace(d, d.slice(0, -1) + (d.endsWith('0') ? '1' : '0'));
  const rT = checkDispatchPackage(tampered, { seat, round });
  ok(!rT.ok && rT.missing.length === 1 && rT.missing[0] === `contract_digest=${d}`, `改一字必拦且只报 digest: ${JSON.stringify(rT.missing)}`);
  // 正向对照: 未改动的 emit 文本在同一契约下必过（确认上面不是全都在拦）
  ok(checkDispatchPackage(emitContract({ seat, round }), { seat, round }).ok, '未改动必过');
});

t('[D1-DC] 两侧同源（D1 核心不变量）: 契约段声明的 gate 集合 == validator 强制的集合', () => {
  const spec = contractSpec({ seat: 'upstream-preview', round: 1 });
  // 正向: 恰好按契约声明的 gate 集合构造 verdict → validator 必过
  const gates = spec.required_gate_ids.map((g) => ({ gate_id: g, result: 'pass', evidence: `${g} ok` }));
  const vOk = mkVerdictFor('upstream-preview', bundle, { gate_checks: gates });
  eq(validateVerdict(vOk).length, 0, '按契约构造的 verdict 必过 validator');
  // 反向: 逐个摘掉一个 gate → validator 必拒（证明契约不是多写的装饰）
  for (const g of spec.required_gate_ids) {
    const vBad = mkVerdictFor('upstream-preview', bundle, { gate_checks: gates.filter((x) => x.gate_id !== g) });
    ok(validateVerdict(vBad).some((e) => e.includes(g)), `摘掉 ${g} 后 validator 必须点名它`);
  }
  // 反向: 自创 gate_id（2026-08-06 实测事故形态）→ validator 拒
  const vSelf = mkVerdictFor('upstream-preview', bundle, { gate_checks: [{ gate_id: '格式检查', result: 'pass', evidence: 'e' }] });
  ok(validateVerdict(vSelf).length >= spec.required_gate_ids.length, '自创 gate_id 必须每个必填门各报一次');
  // 对抗席契约不含 gate 要求，但必须要求恰好七面
  const advSpec = contractSpec({ seat: 'claude-adversarial', round: 1 });
  eq(advSpec.required_gate_ids, [], '对抗席不承担 gate_checks 必填');
  eq(advSpec.required_faces, ALL_FACES, '对抗席必须七面');
  eq(advSpec.faces_exact, true);
  eq(advSpec.hardening, { required: true, checklist_version: HARDENING_CHECKLIST_VERSION, class_count: HARDENING_CLASS_COUNT });
  eq(contractSpec({ seat: 'claude-adversarial', round: 2 }).hardening, { required: false }, 'round>=2 不强制穷举（与 validator 同条件）');
  eq(contractSpec({ seat: 'upstream-preview', round: 1 }).hardening, { required: false }, '第三席不强制穷举');
});

t('[D1-DC] 非法输入 fail-closed: seat/round 非法一律 throw，不产出半成品契约', () => {
  for (const bad of [{ seat: 'nope', round: 1 }, { seat: 'claude-adversarial', round: 0 },
    { seat: 'claude-adversarial', round: 1.5 }, { seat: 'claude-adversarial', round: NaN },
    { seat: undefined, round: 1 }, { seat: 'claude-adversarial', round: undefined }]) {
    let threw = false;
    try { emitContract(bad); } catch { threw = true; }
    ok(threw, `非法输入必须 throw: ${JSON.stringify(bad)}`);
  }
});

// ── D2: PR 格式确定性预检 ──
const FG_CFG = { featureSections: ['变更说明', '提交前自检', '备注'], bugfixSections: ['变更说明', '怎么修的', '备注'], titleTypes: ['feat', 'fix', 'chore', 'docs'], lightTypes: ['chore', 'docs'] };
const FG_BODY_FULL = '## 变更说明\n做了 X\n\n## 提交前自检\n- [x] ok\n\n## 备注\n无\n';

t('[D2-FG] 正向: 三段齐全 + 合法 title type → PASS（不该拦的没拦）', () => {
  const r = evaluateFormat({ title: 'feat(canvas): 加 X', body: FG_BODY_FULL, config: FG_CFG });
  eq(r.result, 'PASS', JSON.stringify(r.reasons));
  eq(r.template, 'feature');
  eq(r.missing_sections, []);
  eq(r.title_type_ok, true);
  eq(r.sections_checked, true);
  // 无 scope、带 ! 的破坏性标记都合法
  eq(evaluateFormat({ title: 'feat: 加 X', body: FG_BODY_FULL, config: FG_CFG }).result, 'PASS');
  eq(evaluateFormat({ title: 'feat(a)!: 加 X', body: FG_BODY_FULL, config: FG_CFG }).result, 'PASS');
});

t('[D2-FG] 反向（D2 事故本体）: 缺一个必填段落 → FAIL 且恰好点名该段落', () => {
  const body = '## 变更说明\n做了 X\n\n## 提交前自检\n- [x] ok\n'; // 缺「备注」
  const r = evaluateFormat({ title: 'feat: 加 X', body, config: FG_CFG });
  eq(r.result, 'FAIL');
  eq(r.missing_sections, ['备注'], '必须恰好点名缺的那一段');
  eq(r.present_sections, ['变更说明', '提交前自检']);
  ok(r.reasons.some((x) => x.includes('## 备注')), '错误文案必须给出可直接照抄的标题');
  // 三段全缺
  eq(evaluateFormat({ title: 'feat: 加 X', body: '随便写点什么', config: FG_CFG }).missing_sections, FG_CFG.featureSections);
});

t('[D2-FG] 段落存在性用标题锚定，不做全文 substring（口径对齐 review-pr）', () => {
  // 正文里出现同名词句但没有标题 → 必须仍判 FAIL（否则硬判层失去拦截力）
  const sneaky = '## 变更说明\nX\n\n## 提交前自检\n- [x] ok\n\n备注：无\n';
  eq(evaluateFormat({ title: 'feat: X', body: sneaky, config: FG_CFG }).missing_sections, ['备注']);
  ok(!hasSection('备注：无', '备注'), '裸文本不算段落');
  ok(hasSection('### 备注', '备注'), 'h3 算');
  ok(hasSection('## 3. 备注（可选）', '备注'), '标题行内含关键词算');
  ok(!hasSection('#备注', '备注'), '缺空格不算标题');
});

t('[D2-FG] 模板选择: fix→bugfixSections；lightTypes→免段落检查（不该拦的没拦）', () => {
  const bugfixBody = '## 变更说明\nX\n\n## 怎么修的\nY\n\n## 备注\n无\n';
  const rFix = evaluateFormat({ title: 'fix: 修 Y', body: bugfixBody, config: FG_CFG });
  eq(rFix.template, 'bugfix');
  eq(rFix.result, 'PASS', JSON.stringify(rFix.reasons));
  // 拿 feature 的段落集喂 fix → 缺 bugfix 特有段落
  eq(evaluateFormat({ title: 'fix: 修 Y', body: FG_BODY_FULL, config: FG_CFG }).missing_sections, ['怎么修的']);
  // light 类不查段落，但 title type 仍查
  const rChore = evaluateFormat({ title: 'chore: 杂活', body: '啥也没有', config: FG_CFG });
  eq(rChore.template, 'light');
  eq(rChore.result, 'PASS');
  eq(rChore.sections_checked, false);
  eq(evaluateFormat({ title: 'chore 杂活', body: '啥也没有', config: FG_CFG }).result, 'FAIL', 'light 类的 title 形态仍要查');
});

t('[D2-FG] 反向: title type 不在白名单 / 形态不合 → FAIL', () => {
  for (const bad of ['wat: 啥', 'feat 缺冒号', 'feat:', 'feat: ', '加个功能', 'FEAT: 大写', 'feat(a: 括号不闭合']) {
    const r = evaluateFormat({ title: bad, body: FG_BODY_FULL, config: FG_CFG });
    eq(r.result, 'FAIL', `title「${bad}」应判 FAIL: ${JSON.stringify(r)}`);
    eq(r.title_type_ok, false);
  }
});

t('[D2-FG-ALIGN] 初版分叉三例必拦（本门比 review-pr 宽 = Phase 1 放行、第三席仍 fail = D2 死锁复活）', () => {
  // 初版正则 `(\([^)]*\))?!?:\s*\S` 放行了这三个，review-pr 的 `(\([^)]+\))?!?: .+` 判 fail
  for (const bad of ['feat(): x', 'feat(scope):x', 'feat:x']) {
    const r = evaluateFormat({ title: bad, body: FG_BODY_FULL, config: FG_CFG });
    eq(r.title_type_ok, false, `「${bad}」必须判不合规（初版分叉用例）`);
    eq(r.result, 'FAIL');
  }
  // 正向对照: 合法形态照旧放行（收紧不得误伤）
  for (const good of ['feat(scope): x', 'feat: x', 'feat!: x', 'feat(a)!: x', 'feat:  两个空格也合法']) {
    eq(evaluateFormat({ title: good, body: FG_BODY_FULL, config: FG_CFG }).title_type_ok, true, `「${good}」不得被误伤`);
  }
});

t('[D2-FG-ALIGN] 含糊词黑名单（review-pr formatIssues 同层判据，漏掉即换一扇门复活死锁）', () => {
  for (const bad of ['feat: 优化', 'fix: 调整', 'feat: 更新 ', 'feat: bug', 'feat: update', 'feat: 若干', 'feat: 一些', 'feat: MISC']) {
    const r = evaluateFormat({ title: bad, body: FG_BODY_FULL, config: FG_CFG });
    eq(r.title_vague, true, `「${bad}」应命中含糊词: ${JSON.stringify(r.reasons)}`);
    eq(r.result, 'FAIL');
  }
  // 正向: 含糊词只在**结尾**才算（词出现在描述中间不拦）
  for (const good of ['feat: 优化渲染路径', 'fix: 调整了阈值到 32px', 'feat: update 之后再收敛']) {
    eq(evaluateFormat({ title: good, body: FG_BODY_FULL, config: FG_CFG }).title_vague, false, `「${good}」不得误判含糊`);
  }
  eq(evaluateFormat({ title: '随便', body: FG_BODY_FULL, config: { ...EMPTY_FORMAT_CONFIG } }).title_vague, null, '未声明 titleTypes 时该项为 null（SKIP），不是 false');
});

t('[D2-FG-ALIGN] self-review 勾选率: 段落存在且 <80% → FAIL；段落不存在不强制', () => {
  const withList = (done, total) => `${FG_BODY_FULL}\n## Self-review\n${Array.from({ length: total }, (_, i) => `- [${i < done ? 'x' : ' '}] 第${i + 1}项`).join('\n')}\n`;
  eq(evaluateFormat({ title: 'feat: x', body: withList(1, 3), config: FG_CFG }).result, 'FAIL', '1/3 应拦');
  eq(evaluateFormat({ title: 'feat: x', body: withList(3, 3), config: FG_CFG }).result, 'PASS', '3/3 应放行');
  eq(evaluateFormat({ title: 'feat: x', body: withList(4, 5), config: FG_CFG }).result, 'PASS', '4/5=80% 恰好放行（不是 <=）');
  const noSec = evaluateFormat({ title: 'feat: x', body: FG_BODY_FULL, config: FG_CFG });
  eq(noSec.checklist.has_section, false);
  eq(noSec.result, 'PASS', '没写 self-review 段落时不强制（作者自发写了才校验）');
  // 只统计该段落到下一个标题之间的复选框——别处的 TODO 不进分母
  const other = `${FG_BODY_FULL}\n## Self-review\n- [x] 做完了\n\n## 后续 TODO\n- [ ] 另开 issue\n- [ ] 再一条\n`;
  const r = evaluateFormat({ title: 'feat: x', body: other, config: FG_CFG });
  eq(r.checklist, { has_section: true, total: 1, done: 1, ratio: 1 }, '下一个标题之后的复选框不得计入分母');
  eq(r.result, 'PASS');
  // light 类不算勾选率（与段落检查同层豁免）
  eq(evaluateFormat({ title: 'chore: x', body: withList(0, 3), config: FG_CFG }).result, 'PASS');
});

// 从源码文本里**严格**抽出两条 regex，不执行任何跨仓文本（去 eval，2026-08-06 第五轮）。
// 初版用贪婪 `(\/.+\/[a-z]*);` + eval：实测把
//   `const TITLE_VAGUE_RE = /foo/; globalThis.__x = 1; /bar/;`
// 整段捕获并执行（sentinel 真被赋值）。review-pr 是本机受信源码、且只在 fixture 期运行，
// 但**没有必要**执行跨仓文本——改为 body/flags 分组 + new RegExp(body, flags)。
export function extractRegexLiterals(src) {
  const type = src.match(/^const TITLE_TYPE_RE\s*=\s*new RegExp\(`([^`\n]+)`\);\s*$/m);
  // body 只吃「非转义斜杠、非换行」的字符，因此吃不进 `; globalThis...` 那种尾巴
  const vague = src.match(/^const TITLE_VAGUE_RE[ \t]*=[ \t]*\n?[ \t]*\/((?:[^/\\\n]|\\.)+)\/([a-z]*);[ \t]*$/m);
  return { typeTemplate: type?.[1] ?? null, vagueBody: vague?.[1] ?? null, vagueFlags: vague?.[2] ?? null };
}
// 上游源码的 **exact** 期望值。任何一个字变了 → 探针 loud fail → 强制人工重审对齐
// （而不是"16 条 case 恰好还全过"就放行——实测删掉 `^` 后 16 条全绿但正则已变宽，静默漂移）。
const RP_EXPECT_TYPE = '^(${prRules.titleTypes.join(\'|\')})(\\\\([^)]+\\\\))?!?: .+';
const RP_EXPECT_VAGUE_BODY = ':\\s*(bug|update|improve|fix issue|优化|调整|更新|misc|若干|一些)\\s*$';
const RP_EXPECT_VAGUE_FLAGS = 'i';

t('[D2-FG-ALIGN] 跨仓对齐探针: 严格抽取（不 eval）+ 上游源码 exact 断言 + 裁决逐条比对（缺席则如实 skip）', () => {
  const RP = join(process.env.HOME ?? '', '.claude/skills/review-pr/scripts/context.mjs');
  if (!existsSync(RP)) { console.log('       ↳ SKIP: 本机未安装 review-pr，跨仓对齐无法实测（如实记录，不当通过）'); return; }
  const { typeTemplate, vagueBody, vagueFlags } = extractRegexLiterals(readFileSync(RP, 'utf8'));
  ok(typeTemplate && vagueBody !== null, 'review-pr 源码形态变了，探针需重写（这本身就是要人看的信号）');
  // exact 断言: 上游改任何一个字（含只删一个 ^ 这种"case 全过但语义已变宽"的漂移）都必须 loud fail
  eq(typeTemplate, RP_EXPECT_TYPE, 'review-pr 的 TITLE_TYPE_RE 源码变了 —— 必须人工重新对齐 titleTypeRe 后同步本期望值');
  eq(vagueBody, RP_EXPECT_VAGUE_BODY, 'review-pr 的 TITLE_VAGUE_RE 变了 —— 必须人工重新对齐后同步本期望值');
  eq(vagueFlags, RP_EXPECT_VAGUE_FLAGS, 'review-pr 的 TITLE_VAGUE_RE flags 变了 —— 同上');
  const types = FG_CFG.titleTypes;
  const theirType = new RegExp(typeTemplate.replace('${prRules.titleTypes.join(\'|\')}', types.join('|')).replace(/\\\\/g, '\\'));
  const theirVague = new RegExp(vagueBody, vagueFlags); // 不 eval
  const mineType = titleTypeReRef(types);
  const cases = ['feat(scope): x', 'feat: x', 'feat(): x', 'feat(scope):x', 'feat:x', 'feat!: x', 'feat(a)!: x',
    'wat: x', 'feat: ', 'feat:', 'feat:  x', 'prefix feat: x', 'feat: 优化', 'feat: 优化渲染',
    'fix: 调整', 'feat: update', 'feat: 一些', 'FEAT: X'];
  for (const c of cases) {
    eq(mineType.test(c), theirType.test(c), `title type 裁决必须与 review-pr 一致: 「${c}」`);
    eq(TITLE_VAGUE_RE_REF.test(c), theirVague.test(c), `含糊词裁决必须与 review-pr 一致: 「${c}」`);
  }
  // `prefix feat: x` 是锚点漂移的反例哨兵: 上游删掉 `^` 后它会变 true，本仓仍 false → 立刻不一致
  eq(mineType.test('prefix feat: x'), false, '锚点必须在行首（本例是 ^ 漂移的哨兵）');
});

t('[D2-FG-ALIGN] 严格抽取器: 不执行跨仓文本，且吃不进注入的尾巴（去 eval 的反证）', () => {
  // 初版贪婪 + eval 会把整段吞下并执行；严格 body 只吃非转义斜杠/非换行字符
  globalThis.__fixtureProbeSentinel = undefined;
  const injected = 'const TITLE_VAGUE_RE = /foo/; globalThis.__fixtureProbeSentinel = 1; /bar/;\n';
  const r = extractRegexLiterals(injected);
  eq(globalThis.__fixtureProbeSentinel, undefined, '抽取器绝不得执行源码文本（初版 eval 会把 sentinel 置 1）');
  // 注意断言方向: 带尾巴的整行**整条拒收**（返回 null）比"抽出 foo 忽略尾巴"更 fail-closed——
  // 形态异常就该让调用侧 loud fail 去叫人看。初稿在这里断言 expected='foo'，跑基线时红了，
  // 是断言写错不是实现错（实现要求 `;` 后必须直接行尾）。
  eq(r.vagueBody, null, '带尾巴的异常行必须整条拒收（返回 null → 调用侧 loud fail）');
  // 反证「初版 eval 确实会执行」: 就地重演初版的贪婪+eval 逻辑，sentinel 必被置 1。
  // 这条替代了「改生产代码跑整套变异」——本属性在 fixture 内部，变异注入反而验不到（见交卷说明）。
  globalThis.__fixtureProbeSentinel = undefined;
  const greedy = injected.match(/const TITLE_VAGUE_RE\s*=\s*\/(.+)\/([a-z]*);/);
  ok(greedy, '前提: 初版的贪婪 regex 确实能匹配这行');
  eq(greedy[1], 'foo/; globalThis.__fixtureProbeSentinel = 1; /bar', '初版贪婪捕获会把整段尾巴吞进来');
  // eslint-disable-next-line no-eval -- 刻意重演初版行为以证明它会执行；只在本用例内、输入是本文件字面量
  try { eval(`/${greedy[1]}/${greedy[2]}`); } catch { /* 语法错也算没执行成功 */ }
  eq(globalThis.__fixtureProbeSentinel, 1, '初版 eval 路径确实会执行注入代码——这就是去 eval 的理由');
  globalThis.__fixtureProbeSentinel = undefined;
  // 形态异常一律返回 null → 调用侧 loud fail，不静默放行
  for (const bad of ['const TITLE_VAGUE_RE = someFn();\n', 'let TITLE_VAGUE_RE = /x/i;\n',
    '// const TITLE_VAGUE_RE = /x/i;\n',
    'const TITLE_VAGUE_RE =\n\n  /x/i;\n',                    // 跨空行 = 可能抓到无关 literal，必须拒
    'const TITLE_VAGUE_RE =\n  someFn();\n  /x/i;\n']) {      // 声明与 literal 之间夹了别的语句
    eq(extractRegexLiterals(bad).vagueBody, null, `形态异常必须抽不出（返回 null 让调用侧 loud fail）: ${JSON.stringify(bad)}`);
  }
  // 合法的换行排版**应当**抽得出（只允许一个换行 + 缩进；初稿断言它必须为 null，跑基线时红了，
  // 是断言过严不是实现错——同一批里我写错两条断言，都是靠真跑基线而不是假定全绿才发现的）
  eq(extractRegexLiterals('const TITLE_VAGUE_RE =\n  /x/i;\n').vagueBody, 'x', '一个换行的合法排版应抽得出');
  eq(extractRegexLiterals('const TITLE_TYPE_RE = someOther(`x`);\n').typeTemplate, null, 'type 侧同理');
  // 正向: 正常形态抽得出且 flags 正确
  const good = extractRegexLiterals('const TITLE_VAGUE_RE = /:\\s*(a|b)\\s*$/i;\n');
  eq(good.vagueBody, ':\\s*(a|b)\\s*$');
  eq(good.vagueFlags, 'i');
});

t('[D2-FG-ALIGN] exact 源码断言的必要性: 只比 case 会放过静默漂移，exact 断言才拦得住（内存态）', () => {
  // 本属性朝**上游**（review-pr 源码变了要 loud fail），无法靠改本仓代码做变异验证——
  // 改 review-pr 仓是硬边界禁止的。改为内存态构造：拿真实期望串做一处「删掉 ^」的语义漂移，
  // 分别看「只比 18 条 case」与「exact 断言」两种口径的表现。
  const types = FG_CFG.titleTypes;
  const compile = (tpl) => new RegExp(tpl.replace('${prRules.titleTypes.join(\'|\')}', types.join('|')).replace(/\\\\/g, '\\'));
  const drifted = RP_EXPECT_TYPE.replace(/^\^/, ''); // 上游删掉行首锚点 = 悄悄变宽
  ok(drifted !== RP_EXPECT_TYPE, '前提: 漂移串确实与期望不同');
  const theirsDrifted = compile(drifted);
  const mine = titleTypeReRef(types);
  // ① 只比 case 的口径: 原有 18 条 case 里没有一条能发现这次漂移
  const CASES = ['feat(scope): x', 'feat: x', 'feat(): x', 'feat(scope):x', 'feat:x', 'feat!: x', 'feat(a)!: x',
    'wat: x', 'feat: ', 'feat:', 'feat:  x', 'feat: 优化', 'feat: 优化渲染', 'fix: 调整', 'feat: update', 'feat: 一些', 'FEAT: X'];
  eq(CASES.filter((c) => mine.test(c) !== theirsDrifted.test(c)), [], '前提: 这批 case 对该漂移完全无感（这正是"全绿≠已覆盖"）');
  // ② exact 断言的口径: 立刻不等 → 调用侧 loud fail
  ok(drifted !== RP_EXPECT_TYPE, 'exact 断言必然发现该漂移');
  // ③ 哨兵 case: 加了 `prefix feat: x` 之后，连"只比 case"也能抓到这一种漂移
  eq(mine.test('prefix feat: x'), false);
  eq(theirsDrifted.test('prefix feat: x'), true, '哨兵 case 对锚点漂移有感——两道口径互为兜底');
});

t('[D2-FG-ALIGN] titleTypes 是 regex fragment: 不得 escRe（初版 escRe 造成双向分叉）', () => {
  const types = ['feat|fix'];
  const theirs = new RegExp(`^(${types.join('|')})(\\([^)]+\\))?!?: .+`); // review-pr 口径
  const mine = titleTypeReRef(types);
  eq(mine.source, theirs.source, 'titleTypeRe 的 pattern 必须与 review-pr 逐字相同（不得 escRe）');
  // 三个实测分叉用例（初版：前两个假 FAIL、第三个假 PASS）
  for (const c of ['fix: x', 'feat: x', 'feat|fix: x']) {
    eq(mine.test(c), theirs.test(c), `「${c}」两侧必须同判（初版 escRe 在此双向分叉）`);
  }
  eq(mine.test('fix: x'), true, 'fragment 里的 fix 必须能匹配（初版判 false = 假 FAIL）');
  eq(mine.test('feat|fix: x'), false, '字面量 feat|fix 不得匹配（初版判 true = 假 PASS → D2 死锁）');
  // 普通 token 回归: 与旧行为完全一致
  eq(titleTypeReRef(['feat', 'fix']).source, '^(feat|fix)(\\([^)]+\\))?!?: .+');
  // 不可解析的 fragment → 抛错（fail-closed；CLI 侧转 exit 3），不静默降级。
  // 注意选例: `[` **能**编译（被 pattern 后面 `[^)]` 里的 `]` 闭合成字符类），拿它当"非法"
  // 会写出一条假成立的断言——初稿正是如此，自测时才发现。真非法的是 `(` / `*` / `+` / `a)`。
  for (const bad of ['(', '*', '+', 'a)']) {
    let threw = false;
    try { titleTypeReRef([bad]); } catch { threw = true; }
    ok(threw, `不可解析的 titleTypes fragment「${bad}」必须抛错，不得静默放行`);
    let threw2 = false;
    try { evaluateFormat({ title: 'feat: x', body: FG_BODY_FULL, config: { ...FG_CFG, titleTypes: [bad] } }); } catch { threw2 = true; }
    ok(threw2, `evaluateFormat 遇「${bad}」同样抛错（CLI 转 exit 3）`);
  }
  // 对照: `[` 能编译，因此它**不该**被期望抛错（锁住上面的选例理由，防有人"修正"回去）
  ok(titleTypeReRef(['[']) instanceof RegExp, '`[` 在本 pattern 里可编译——不得把它当非法用例');
});

t('[D2-FG] 配置未声明 → SKIP（显式"无判据"，不是 PASS；不硬编码任一目标仓的段落名）', () => {
  const r = evaluateFormat({ title: '随便', body: '空的', config: { ...EMPTY_FORMAT_CONFIG } });
  eq(r.result, 'SKIP', 'result 必须是 SKIP 而不是 PASS——否则"没判据"会被读成"检查通过"');
  eq(r.title_type_ok, null);
  eq(r.sections_checked, false);
  // 只声明 titleTypes → 只查标题，段落 SKIP 但整体不再 SKIP
  const partial = evaluateFormat({ title: 'feat: X', body: '空的', config: { ...EMPTY_FORMAT_CONFIG, titleTypes: ['feat'] } });
  eq(partial.result, 'PASS');
  eq(partial.sections_checked, false);
  eq(evaluateFormat({ title: 'wat: X', body: '空的', config: { ...EMPTY_FORMAT_CONFIG, titleTypes: ['feat'] } }).result, 'FAIL');
});

t('[D2-FG] malformed 配置 fail-closed 抛错，绝不回退默认（同 size-gate 口径）', () => {
  const d = mkdtempSync(join(tmpdir(), 'fg-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'x');
  mkdirSync(join(d, 'agent-use', 'docs'), { recursive: true });
  const writeRules = (obj, raw) => {
    writeFileSync(join(d, 'agent-use/docs/pr-rules.json'), raw ?? JSON.stringify(obj));
    g('add', '.'); g('commit', '-qm', 'r');
    return g('rev-parse', 'HEAD');
  };
  const expectThrow = (ref, re) => {
    let msg = null;
    try { loadFormatConfig(d, ref); } catch (e) { msg = e.message; }
    ok(msg && re.test(msg), `应 fail-closed 抛错并命中 ${re}，得到: ${msg}`);
  };
  expectThrow(writeRules({ featureSections: '变更说明' }), /featureSections 必须是非空字符串数组/);
  expectThrow(writeRules({ bugfixSections: [] }), /bugfixSections 声明了却是空数组/);
  expectThrow(writeRules({ titleTypes: ['feat', ''] }), /titleTypes 必须是非空字符串数组/);
  expectThrow(writeRules({ featureSections: ['a', 3] }), /featureSections 必须是非空字符串数组/);
  expectThrow(writeRules(null, '{ 坏 json'), /解析失败/);
  expectThrow(writeRules(null, '[1,2]'), /顶层必须是对象/);
  // 文件整个不存在 → default（无判据），不抛错
  const d2 = mkdtempSync(join(tmpdir(), 'fg2-'));
  const g2 = (...a) => execFileSync('git', ['-C', d2, ...a], { encoding: 'utf8' }).trim();
  g2('init', '-q', '-b', 'main'); g2('config', 'user.email', 'a@b.c'); g2('config', 'user.name', 'x');
  writeFileSync(join(d2, 'x.txt'), 'x'); g2('add', '.'); g2('commit', '-qm', 'r');
  const r = loadFormatConfig(d2, g2('rev-parse', 'HEAD'));
  eq(r.source, 'default');
  eq(r.config.featureSections, null);
  rmSync(d, { recursive: true, force: true }); rmSync(d2, { recursive: true, force: true });
});

t('[D2-FG-FC] 「真·缺文件」与「git 失败」必须分开: 前者 SKIP，后者 fail-closed 抛错（防假 SKIP）', () => {
  const d = mkdtempSync(join(tmpdir(), 'fgfc-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'x');
  writeFileSync(join(d, 'x.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'r');
  const head = g('rev-parse', 'HEAD');
  // 正向（唯一允许 SKIP 的情形）: ref 可解析、ls-tree 确认路径不存在
  eq(loadFormatConfig(d, head).source, 'default', '真·缺文件才允许 SKIP');
  eq(loadFormatConfig(d, 'main').source, 'default', '分支名同样可解析');
  // 反向: 坏 ref / 空 ref / 非 git 仓 —— 初版这三种全部静默返回 source=default（假 SKIP）
  const expectThrow = (dir, ref, re, label) => {
    let msg = null;
    try { loadFormatConfig(dir, ref); } catch (e) { msg = e.message; }
    ok(msg !== null, `${label} 必须抛错，不得静默 SKIP（初版正是静默）`);
    ok(re.test(msg), `${label} 的错误文案应命中 ${re}，得到: ${msg}`);
  };
  expectThrow(d, 'definitely-no-such-ref', /无法解析成 tree/, '坏 ref');
  expectThrow(d, '', /无法解析成 tree|不是 git 仓库/, '空 ref');
  const notRepo = mkdtempSync(join(tmpdir(), 'fgnr-'));
  expectThrow(notRepo, 'main', /不是 git 仓库|git 不可用/, '非 git 仓');
  // 对照: 路径存在时照常读出（三步判别没有把正常路径拦掉）
  mkdirSync(join(d, 'agent-use', 'docs'), { recursive: true });
  writeFileSync(join(d, 'agent-use/docs/pr-rules.json'), JSON.stringify({ titleTypes: ['feat'] }));
  g('add', '.'); g('commit', '-qm', 'cfg');
  const r2 = loadFormatConfig(d, g('rev-parse', 'HEAD'));
  eq(r2.source, 'base');
  eq(r2.config.titleTypes, ['feat']);
  rmSync(d, { recursive: true, force: true }); rmSync(notRepo, { recursive: true, force: true });
});

t('[D2-FG] 配置从 merge-base 树读: 候选侧自带宽配置绕不过闸（复刻 size-gate 审 B2-F1 防线）', () => {
  const d = mkdtempSync(join(tmpdir(), 'fgb-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'x');
  mkdirSync(join(d, 'agent-use', 'docs'), { recursive: true });
  const rulesPath = join(d, 'agent-use/docs/pr-rules.json');
  writeFileSync(rulesPath, JSON.stringify({ featureSections: ['变更说明', '备注'], titleTypes: ['feat'] }));
  g('add', '.'); g('commit', '-qm', 'base');
  const baseSha = g('rev-parse', 'HEAD');
  // 候选侧把段落要求改空（"我这个 PR 不需要段落"）
  g('checkout', '-qb', 'feat');
  writeFileSync(rulesPath, JSON.stringify({ featureSections: ['备注'], titleTypes: ['feat', 'wat'] }));
  g('add', '.'); g('commit', '-qm', 'widen');
  const mergeBase = g('merge-base', 'main', 'HEAD');
  eq(mergeBase, baseSha, '前提: merge-base 应是 base 提交');
  const fromBase = loadFormatConfig(d, mergeBase).config;
  eq(fromBase.featureSections, ['变更说明', '备注'], '必须读 merge-base 树的配置');
  eq(fromBase.titleTypes, ['feat'], '候选侧新增的 titleTypes 不得生效');
  // 对照: 若错误地读候选树，宽配置就会生效（本条锁的正是"没读候选树"）
  const fromHead = loadFormatConfig(d, g('rev-parse', 'HEAD')).config;
  eq(fromHead.featureSections, ['备注'], '前提对照: 候选树确实是宽配置');
  ok(evaluateFormat({ title: 'wat: X', body: '## 备注\n无\n', config: fromBase }).result === 'FAIL',
    '按 base 配置判: 候选侧自加的 type 与放宽的段落都不生效');
  ok(evaluateFormat({ title: 'wat: X', body: '## 备注\n无\n', config: fromHead }).result === 'PASS',
    '前提对照: 按候选配置判就会被绕过——这正是必须读 merge-base 的理由');
  rmSync(d, { recursive: true, force: true });
});

t('[D2-FG] config_hash 随配置变化（配置被换掉时可被上报/对账检出）', () => {
  const h = formatConfigHash(FG_CFG);
  eq(h, formatConfigHash({ ...FG_CFG, lightTypes: [...FG_CFG.lightTypes].reverse() }), 'lightTypes 顺序不影响 hash（内部排序）');
  ok(h !== formatConfigHash({ ...FG_CFG, featureSections: ['变更说明'] }), '段落集变化必须换 hash');
  ok(h !== formatConfigHash({ ...FG_CFG, titleTypes: ['feat'] }), 'titleTypes 变化必须换 hash');
  ok(h !== formatConfigHash({ ...FG_CFG, lightTypes: ['chore'] }), 'lightTypes 集合变化必须换 hash');
});

// ── D3: 域外真问题通道 out_of_scope_notes ──
const OOS_CHANGED = new Set(['src/changed.ts']);
const OOS_TRACKED = new Set(['src/changed.ts', 'src/legacy.ts', 'README.md']);
const mkNote = (over = {}) => ({ id: 'N1', note: '既有实现里 X 未加锁', evidence: 'src/legacy.ts:12 读改写无互斥', suggested_issue_title: 'legacy 路径缺锁', ...over });
const mkVoos = (over = {}) => mkVerdictFor('claude-adversarial', bundle, {
  findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: ['src/changed.ts'], evidence: 'e', status: 'closed' }],
  closed_finding_ids: ['F1'], ...over
});
const voosErrs = (over) => validateVerdict(mkVoos(over), { changedPaths: OOS_CHANGED, trackedPaths: OOS_TRACKED });

t('[D3-OOS] 正向（本通道存在的理由）: note 的 ref_paths 可以在实改集之外，只要是 tracked 文件', () => {
  eq(voosErrs({ out_of_scope_notes: [mkNote({ ref_paths: ['src/legacy.ts'] })] }), [], 'diff 外的 tracked 路径必须被接受');
  eq(voosErrs({ out_of_scope_notes: [mkNote()] }), [], 'ref_paths 可省略');
  eq(voosErrs({ out_of_scope_notes: [] }), [], '空数组合法');
  eq(voosErrs({}), [], '不带该字段仍合法（存量 verdict 向后兼容，不破）');
});

t('[D3-OOS] 对照（SC-R3-5 一个字没放宽）: 同一 diff 外路径放进 finding.anchor_paths 仍必拒', () => {
  const errs = validateVerdict(mkVerdictFor('claude-adversarial', bundle, {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: ['src/legacy.ts'], evidence: 'e', status: 'closed' }],
    closed_finding_ids: ['F1']
  }), { changedPaths: OOS_CHANGED, trackedPaths: OOS_TRACKED });
  ok(errs.some((e) => /实改文件集/.test(e)), `anchor_paths 的实改集校验必须仍然生效: ${JSON.stringify(errs)}`);
});

t('[D3-OOS] 反向: note 携带 finding 的机器字段 → 拒（防用旁路通道伪造绕过实改集校验的 finding）', () => {
  for (const k of ['anchor_paths', 'severity', 'primary_face', 'family_id', 'invariant', 'status', 'write_paths', 'allowed_paths']) {
    const errs = voosErrs({ out_of_scope_notes: [mkNote({ [k]: k === 'anchor_paths' ? ['src/legacy.ts'] : 'x' })] });
    ok(errs.some((e) => e.includes(`不得携带 ${k}`)), `note 携带 ${k} 必须被拒: ${JSON.stringify(errs)}`);
  }
});

t('[D3-OOS] 反向: 必填字段缺失 / id 撞号 / ref_paths 非法 → 逐条拒', () => {
  for (const k of ['id', 'note', 'evidence', 'suggested_issue_title']) {
    const n = mkNote(); delete n[k];
    ok(voosErrs({ out_of_scope_notes: [n] }).some((e) => e.includes(k === 'id' ? '缺 id' : `缺 ${k}`)), `缺 ${k} 必拒`);
    ok(voosErrs({ out_of_scope_notes: [mkNote({ [k]: '' })] }).length > 0, `${k} 为空串必拒`);
  }
  ok(voosErrs({ out_of_scope_notes: [mkNote(), mkNote()] }).some((e) => /id 重复/.test(e)), 'note id 重复必拒');
  ok(voosErrs({ out_of_scope_notes: [mkNote({ id: 'F1' })] }).some((e) => /撞号/.test(e)), 'note id 与 finding id 撞号必拒');
  ok(voosErrs({ out_of_scope_notes: [mkNote({ ref_paths: ['src/nope.ts'] })] }).some((e) => /tracked/.test(e)), '非 tracked 路径必拒');
  ok(voosErrs({ out_of_scope_notes: [mkNote({ ref_paths: ['src/'] })] }).length > 0, '目录必拒');
  ok(voosErrs({ out_of_scope_notes: [mkNote({ ref_paths: ['/abs/x.ts'] })] }).length > 0, '绝对路径必拒');
  ok(voosErrs({ out_of_scope_notes: [mkNote({ ref_paths: ['src/legacy.ts', 'src/legacy.ts'] })] }).some((e) => /ref_paths 重复/.test(e)), '重复必拒');
  ok(voosErrs({ out_of_scope_notes: [mkNote({ ref_paths: Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`) })] }).some((e) => /上限/.test(e)), '超上限必拒');
  ok(voosErrs({ out_of_scope_notes: [mkNote({ ref_paths: 'src/legacy.ts' })] }).some((e) => /必须是数组/.test(e)), 'ref_paths 非数组必拒');
  ok(voosErrs({ out_of_scope_notes: 'x' }).some((e) => /必须是数组/.test(e)), 'notes 非数组必拒');
  ok(voosErrs({ out_of_scope_notes: ['x'] }).some((e) => /必须是对象/.test(e)), 'note 元素非对象必拒');
});

t('[D3-OOS] 共识不受影响: 三席带 notes 仍 PASS，且 note 不进 canonical_findings / 不进 SC 台账', () => {
  const notes = [mkNote({ id: 'N1' })];
  const withNotes = { findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: ['src/changed.ts'], evidence: 'e', status: 'closed' }], closed_finding_ids: ['F1'], out_of_scope_notes: notes };
  const plain = { findings: withNotes.findings, closed_finding_ids: ['F1'] };
  const withN = consensusFor(bundle, [withNotes, withNotes, { ...withNotes, gate_checks: THIRD_GATES }]);
  eq(withN.artifact.gate_result, 'pass', JSON.stringify(withN.artifact.fail_reasons));
  const without = consensusFor(bundle, [plain, plain, { ...plain, gate_checks: THIRD_GATES }]);
  eq(without.artifact.gate_result, 'pass');
  // canonical_findings 数量与内容不因 notes 变化；note id 不出现在里面
  eq(withN.artifact.canonical_findings.length, without.artifact.canonical_findings.length, 'notes 不得新增 canonical finding');
  ok(!JSON.stringify(withN.artifact.canonical_findings).includes('N1'), 'note 不得泄进 canonical_findings');
  ok(!JSON.stringify(withN.artifact.canonical_findings).includes('legacy'), 'note 的证据不得进冲突图输入');
  // notes 入 verdict hash → artifact hash 变（不可事后追加/删改）
  ok(withN.artifact.consensus_artifact_hash !== without.artifact.consensus_artifact_hash, 'notes 必须参与 verdict_hashes → artifact hash（改了就换 hash）');
  const mutated = { ...withNotes, out_of_scope_notes: [mkNote({ id: 'N1', note: '改了一个字' })] };
  const withM = consensusFor(bundle, [mutated, mutated, { ...mutated, gate_checks: THIRD_GATES }]);
  eq(withM.artifact.gate_result, 'pass');
  ok(withM.artifact.consensus_artifact_hash !== withN.artifact.consensus_artifact_hash, '改 note 文本必须换 artifact hash');
  // note 不影响 conjunct④: 带 notes 的第三席 gate 全 pass 时照常放行；gate fail 仍拒（未被削弱）
  const gateFail = { ...withNotes, gate_checks: THIRD_GATES.map((g, i) => i === 0 ? { ...g, result: 'fail' } : g), verdict: 'REQUIRES_CHANGES' };
  const bad = consensusFor(bundle, [withNotes, withNotes, gateFail]);
  eq(bad.artifact.gate_result, 'fail', 'conjunct③④ 未被 notes 削弱');
});

t('[D3-OOS-WIRE] 接线层: runConsensusGate 只给 repoDir（不注入任何集合）时必须自算 tracked 集并校验 ref_paths', () => {
  // 为什么单独一条: 上面的 [D3-OOS] 用例都**注入** trackedPaths/changedPaths，锁的是 validator 的
  // 判定逻辑；而 live 路径（consensus-gate CLI）只给 repoDir。初版 runConsensusGate 只构造
  // changedPaths、从不构造 trackedPaths —— anchor_paths 侥幸被实改集检查吞掉，但 ref_paths 的
  // tracked 检查在 live 路径上一道都没有。「单元层锁住了、接线层没接上」，本条专测接线层。
  const d = mkdtempSync(join(tmpdir(), 'oosw-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'x');
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src/legacy.ts'), 'legacy\n');      // tracked 但本 PR 未改
  writeFileSync(join(d, 'src/changed.ts'), 'v1\n');
  g('add', '.'); g('commit', '-qm', 'base');
  const baseSha = g('rev-parse', 'HEAD');
  writeFileSync(join(d, 'src/changed.ts'), 'v2\n');         // 实改
  g('add', '.'); g('commit', '-qm', 'cand');
  const candSha = g('rev-parse', 'HEAD');

  const b = mkBundle(baseSha, candSha);
  const mk = (refPaths) => ({
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: ['src/changed.ts'], evidence: 'e', status: 'closed' }],
    closed_finding_ids: ['F1'],
    out_of_scope_notes: [{ id: 'N1', note: 'n', evidence: 'e', suggested_issue_title: 't', ...(refPaths ? { ref_paths: refPaths } : {}) }]
  });
  const run = (refPaths) => {
    const o = mk(refPaths);
    const vs = [mkVerdictFor('claude-adversarial', b, o), mkVerdictFor('codex-adversarial', b, o),
      mkVerdictFor('upstream-preview', b, { ...o, gate_checks: THIRD_GATES })];
    return runConsensusGate(vs, { bundle: b, repoDir: d }); // 只给 repoDir——live 路径的形态
  };
  // 正向: tracked-but-unchanged 的 ref_paths 必须放行（这是 D3 通道存在的理由，不得被误伤）
  eq(run(['src/legacy.ts']).gate_result, 'pass', 'diff 外的 tracked 路径必须放行: ' + JSON.stringify(run(['src/legacy.ts']).fail_reasons));
  eq(run(undefined).gate_result, 'pass', 'ref_paths 省略仍放行');
  // 反向（初版在 live 路径上放行了这条）: 编造一个不存在的路径 → 必须被 tracked 门拦下
  const bogus = run(['src/does-not-exist.ts']);
  eq(bogus.gate_result, 'fail', '不存在的 ref_paths 必须被 live 路径拦下（初版这里 fail-open）');
  ok(bogus.fail_reasons.some((r) => /tracked/.test(r)), `失败原因应点名 tracked: ${JSON.stringify(bogus.fail_reasons)}`);
  // 对照: anchor_paths 的实改集门在同一条 live 路径上仍然生效（未被本次接线改动影响）
  const o2 = mk(['src/legacy.ts']);
  o2.findings[0].anchor_paths = ['src/legacy.ts']; // tracked 但未改
  const vs2 = [mkVerdictFor('claude-adversarial', b, o2), mkVerdictFor('codex-adversarial', b, o2),
    mkVerdictFor('upstream-preview', b, { ...o2, gate_checks: THIRD_GATES })];
  const r2 = runConsensusGate(vs2, { bundle: b, repoDir: d });
  eq(r2.gate_result, 'fail');
  ok(r2.fail_reasons.some((x) => /实改文件集/.test(x)), 'SC-R3-5 在 live 路径上仍生效');
  rmSync(d, { recursive: true, force: true });
});

// ========== 汇总 + SKIPPED ==========
await Promise.all(pending);
console.log(`\n========== fixtures: ${pass} passed, ${failCount} failed ==========`);
console.log(`
[SKIPPED — 本仓无法验证、只能在 §5 P0-P2 真机出口验收（如实列出，本文件全绿不代表这些完成）]
- P0①〜⑫ 真机验证（cindy clone/fork、飞书绑定、preRunHook、missed-fire、deepseek effort、
  sessions.dispatch 端到端、goal --until-sc 在 mini、#814、NO_CHAT_CONTEXT、session meta、W-7 三前提）
- gh-snapshot 对真实 GitHub API（本轮已有录制契约测试覆盖 ETag/304/GraphQL 归一化；
  真实 API 行为差异等 P0 后在 mini 复核）；accepted 语义判定规则待真实数据
- cindy-dispatch 传输层实体（CINDY_DISPATCH_CMD 待 P0-⑦；四元组校验已被 CLI fixture 覆盖）
- 双 PR 并发修复不互踩 / cindy fork push 全链 / 与 review-pr 并发不撞锁 / 第三席 GitHub 零写（P2 真机）
- 飞书续聊分拣 sessionId/上下文/条目映射（P1 阻断出口）
- goal skill --until-sc 模式本体（owner 自有 skill，部署阶段改）
`);
if (failCount) { console.log('failed: ' + failures.join(' | ')); process.exit(1); }
