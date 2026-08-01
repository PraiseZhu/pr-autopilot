#!/usr/bin/env node
// pr-autopilot 回归 fixtures v3 — 审③后更新（对账用例全部固化）
// 每条用例前缀 [计划条款/审次编号]；末尾 SKIPPED 清单如实列出仓内验不了的项。
// 模拟密钥一律运行时拼接（静态文件不含完整 token/赋值形态）。
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const S = join(HERE, '..', 'scripts');
const W = join(HERE, '..', 'deploy', 'wrappers');

import { computeReviewInputHash } from '../scripts/review-input-hash.mjs';
import { validateVerdict } from '../scripts/verdict-validate.mjs';
import { runConsensusGate, recomputeArtifactHash } from '../scripts/consensus-gate.mjs';
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
import { buildFixPlan, computeFixPlanHash } from '../scripts/fix-plan.mjs';
import { normalizeRepoPath } from '../scripts/lib/common.mjs';
import { recoverFromReceipt } from '../scripts/pr-watch/finalize.mjs';
import { foldDispatchStates } from '../scripts/pr-watch/budget.mjs';
import { secretLint } from '../scripts/evolution/secret-lint.mjs';
import { classifyEscapes } from '../scripts/evolution/escape-classify.mjs';
import { checkLeases, alertWithFallback } from '../scripts/health/lease-check.mjs';
import { readJson, hashObject, canonicalJson } from '../scripts/lib/common.mjs';

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

function mkBundle(baseSha, candidateSha, over = {}) {
  return {
    base_sha: baseSha, candidate_sha: candidateSha, pr_title: 't', pr_body: 'b',
    touches_ui: false, matched_paths: [],
    ui_registry_config_hash: 'c'.repeat(64), pr_context_digest: 'd'.repeat(64), ...over
  };
}
// v2: 每条 finding 需 anchor_paths（机器分组字段）。测试 finding 未显式给时，
// 从 anchor 派生（去 :行号 后取路径部分；不像路径则回退占位），减少逐条改动。
function withAnchorPaths(findings) {
  return (findings ?? []).map((fd) => {
    if (Array.isArray(fd.anchor_paths)) return fd;
    const stripped = String(fd.anchor ?? '').replace(/:\d+(-\d+)?$/, '').trim();
    const looksPath = stripped && !/\s/.test(stripped) && !stripped.startsWith('/') && !stripped.includes('..');
    return { ...fd, anchor_paths: [looksPath ? stripped : 'src/_fixture.ts'] };
  });
}
function mkVerdictFor(reviewer, bundleObj, over = {}) {
  const base = {
    schema_version: 'v2', reviewer, run_status: 'ok', round: 1,
    base_sha: bundleObj.base_sha, candidate_sha: bundleObj.candidate_sha,
    review_input_hash: computeReviewInputHash(bundleObj),
    faces: reviewer === 'upstream-preview' ? THIRD_FACES : FULL_FACES,
    findings: [], gate_checks: reviewer === 'upstream-preview' ? THIRD_GATES : [],
    verdict: 'APPROVED', closed_finding_ids: [], ...over
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
  return { verdicts: vs, artifact: runConsensusGate(vs, { bundle: bundleObj, ...gateOpts }) };
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
  const runW = (transport) => {
    try {
      execFileSync(process.execPath, [join(W, 'cindy-dispatch.mjs')], {
        encoding: 'utf8', input: manifest,
        env: { ...process.env, CINDY_DISPATCH_CMD: transport }
      });
      return true;
    } catch { return false; }
  };
  const full = { session_id: 's1', agentKind: 'claude-code', provider: 'Cindy AI', model: 'z-ai/glm-5.2', effort: 'max' };
  ok(runW(mkTransport(JSON.stringify(full))), '四元组全齐应过');
  ok(!runW(mkTransport(JSON.stringify({ session_id: 's1' }))), '只回 session_id 应拒');
  for (const missing of ['agentKind', 'provider', 'model', 'effort']) {
    const { [missing]: _, ...part } = full;
    ok(!runW(mkTransport(JSON.stringify(part))), `缺 ${missing} 应拒`);
  }
  ok(!runW(mkTransport(JSON.stringify({ ...full, model: 'glm-5.2' }))), 'model 漂移应拒');
  ok(!runW(''), '无传输层配置应拒');
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

// 造一个带 N 条 canonical finding 的真共识 artifact（各 finding 指定 anchor_paths）
function artifactWithFindings(specs, bundleObj = bundle, gateOpts = {}) {
  // specs: [{fid_face, sev, paths}] —— 三席都 close 同一批以达共识。
  // 每条 anchor + evidence 唯一（防 canonical dedup 合并），便于按 anchor 反查 canonical id。
  const findings = specs.map((s, i) => ({ id: `f${i}`, primary_face: s.face ?? 'A', severity: s.sev, anchor: `${s.paths.join('|')}#${i}`, anchor_paths: s.paths, evidence: `ev-${i}-${s.paths.join(',')}`, status: 'closed' }));
  const ids = findings.map((f) => f.id);
  const art = consensusFor(bundleObj, [
    { findings, closed_finding_ids: ids },
    { findings, closed_finding_ids: ids },
    { findings: [], closed_finding_ids: [] } // 第三席无独立 finding
  ], gateOpts).artifact;
  ok(art.gate_result === 'pass', 'artifact 应达共识: ' + JSON.stringify(art.fail_reasons ?? []));
  return art;
}

t('[v2-coverage] SC 必须覆盖每条 blocker/major finding，绑定 artifact hash，拒悬空/漏项', () => {
  const art = artifactWithFindings([
    { sev: 'blocker', paths: ['server/lib/assetStore.ts'] },
    { sev: 'major', paths: ['src/store/documentSlice.ts'] },
    { sev: 'suggestion', paths: ['docs/x.md'] }
  ]);
  const ids = art.canonical_findings.map((f) => f.id);
  const blockerMajor = art.canonical_findings.filter((f) => f.severity !== 'suggestion').map((f) => f.id);
  const mk = (scs) => ({ schema_version: 'v1', consensus_artifact_hash: art.consensus_artifact_hash, scs });
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
  const alloc = ORC.allocateWave({ repoDir: r18, worktreeRoot: wtRoot, runId: 'run1', plan: plan18, waveIndex: 0, waveBase: candidate });
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
  const alloc2 = ORC.allocateWave({ repoDir: r18, worktreeRoot: wtRoot2, runId: 'run2', plan: plan18, waveIndex: 0, waveBase: candidate });
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
  const a1 = ORC.allocateWave({ repoDir: r19, worktreeRoot: wtRoot, runId: 'r', plan: plan19, waveIndex: 0, waveBase: cand });
  const wt1 = a1.allocations[0].worktree;
  writeFileSync(join(wt1, 'api.ts'), 'export const old = 1;\nexport const NEW_API = 2;\n');
  execFileSync('git', ['-C', wt1, 'add', '.'], { encoding: 'utf8' });
  execFileSync('git', ['-C', wt1, 'commit', '-qm', 'add api'], { encoding: 'utf8' });
  const tip1 = execFileSync('git', ['-C', wt1, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const int1 = ORC.integrateWave({ repoDir: r19, waveBase: cand, groupTips: [{ group_id: 'g1', tip: tip1 }] });
  ok(int1.ok);
  // wave2 base = wave1 集成 tip → verify 组能看见 NEW_API（审 R1-P1-5 核心）
  const a2 = ORC.allocateWave({ repoDir: r19, worktreeRoot: wtRoot, runId: 'r', plan: plan19, waveIndex: 1, waveBase: int1.integrated_tip });
  const wt2 = a2.allocations[0].worktree;
  ok(readFileSync(join(wt2, 'api.ts'), 'utf8').includes('NEW_API'), 'wave2 worktree 必须看见 wave1 的产物（否则依赖波形同虚设）');
  // 残骸: 把 g1 的 worktree 挪到与 base 无血缘的 orphan commit → 再 allocate 必须 fail-closed
  execFileSync('git', ['-C', wt1, 'checkout', '-q', '--orphan', 'orphan-br'], { encoding: 'utf8' });
  writeFileSync(join(wt1, 'junk.ts'), 'orphan\n');
  execFileSync('git', ['-C', wt1, 'add', '.'], { encoding: 'utf8' });
  execFileSync('git', ['-C', wt1, 'commit', '-qm', 'orphan'], { encoding: 'utf8' });
  let threw19 = false;
  try { ORC.allocateWave({ repoDir: r19, worktreeRoot: wtRoot, runId: 'r', plan: plan19, waveIndex: 0, waveBase: cand }); }
  catch (e) { threw19 = /残骸/.test(e.message); }
  ok(threw19, '与 base 无血缘的 worktree 残骸必须 fail-closed（不得拿它当本波用）');
  // 非法输入
  for (const bad of [{ waveBase: 'HEAD' }, { runId: 'a b' }]) {
    let t19 = false;
    try { ORC.allocateWave({ repoDir: r19, worktreeRoot: wtRoot, runId: bad.runId ?? 'r2', plan: plan19, waveIndex: 0, waveBase: bad.waveBase ?? cand }); }
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
  const scManifest = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash, scs: [
    { id: 'SC-0', kind: 'fix', finding_ids: [fid(0)], change: 'c', holds: 'h', verify: VF('test', ['-f', 'server/a.ts']) },
    { id: 'SC-1', kind: 'fix', finding_ids: [fid(1)], change: 'c', holds: 'h', verify: VF('test', ['-f', 'src/b.ts']) },
    { id: 'SC-2', kind: 'fix', finding_ids: [fid(2)], change: 'c', holds: 'h', verify: VF('test', ['-f', 'src/b2.ts']) },
    { id: 'SC-3', kind: 'fix', finding_ids: [fid(3)], change: 'c', holds: 'h', verify: VF('test', ['-f', 'src/c.ts']) }
  ] };
  const pr2 = buildFixPlan({ artifact: art, manifest: scManifest });
  ok(!pr2.degraded, 'plan 不该 degraded: ' + JSON.stringify(pr2.reasons ?? []));
  const plan = pr2.plan;
  eq(plan.waves.length, 1); eq(plan.waves[0].length, 3, '3 组并行（其中一组含两条撞车 SC）');

  // ---- 真实状态机 run（squash 集成）——SKILL Phase 2c 的命令序列逐一走真 ----
  const st = mkdtempSync(join(tmpdir(), 'pgrun-'));
  const wtR = join(st, 'wt'); mkdirSync(wtR);
  const symbolicBefore = git('symbolic-ref', '--short', 'HEAD');
  FR.initRun({ stateDir: st, runId: 'pg1', repoDir: repo, plan, scManifest, sourceArtifact: art, featureBranch: 'feat' });
  const al = FR.allocate({ stateDir: st, runId: 'pg1', plan, waveIndex: 0, worktreeRoot: wtR });
  eq(al.wave_base, HEAD, 'wave0 base == 源 artifact candidate（SC-R3-10）');
  for (const a of al.allocations) {
    for (const f of a.allowed_paths) {
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
  const al = ORC.allocateWave({ repoDir: r1, worktreeRoot: wtRoot, runId: 'ok1', plan: planC, waveIndex: 0, waveBase: cand });
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
  try { FR.allocate({ stateDir: env.stateDir, runId: 'r1', plan, waveIndex: 1, worktreeRoot: env.wtRoot }); }
  catch (e) { threw = /base 不可得|尚未集成/.test(e.message); }
  ok(threw, 'SC-8: 跳波 allocate 必拒（base 只能由 manifest 派生）');
  // wave1 正常
  const a1 = FR.allocate({ stateDir: env.stateDir, runId: 'r1', plan, waveIndex: 0, worktreeRoot: env.wtRoot });
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
  // 越域: g1 改 b.ts（不在自己 allowed_paths）→ 拒
  workGroup(env, a1.allocations[0], 'b.ts', 'g1 越域\n');
  workGroup(env, a1.allocations[1], 'b.ts', 'g2 改自己的\n');
  integ = FR.integrate({ stateDir: env.stateDir, runId: 'r1', plan, waveIndex: 0 });
  ok(!integ.ok && integ.errors.some((e) => /越域改动/.test(e)), 'SC-8: 越域改动必拒');
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
  const a1 = FR.allocate({ stateDir: env.stateDir, runId: 'r2', plan, waveIndex: 0, worktreeRoot: env.wtRoot });
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
  const a2 = FR.allocate({ stateDir: env.stateDir, runId: 'r2', plan, waveIndex: 1, worktreeRoot: env.wtRoot });
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
  // 两组的 allowed_paths 都含 shared.ts（计划认为可并行，实改却撞车）
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['shared.ts'] }, { id: 'g2', sc_ids: ['SC-1'], paths: ['shared.ts'] }],
    [['g1', 'g2']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'shared.ts']) },
     { id: 'SC-1', kind: 'fix', finding_ids: ['f1'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'shared.ts']) }]
  );
  FR.initRun({ stateDir: env.stateDir, runId: 'r3', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'r3', plan, waveIndex: 0, worktreeRoot: env.wtRoot });
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
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rv', plan, waveIndex: 0, worktreeRoot: env.wtRoot });
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

t('[SC-R3-5] anchor hub 污染: 共享 hub 把 8 组并成 1 组 → hub 门 degraded；changed-set 拦 tracked-but-unchanged', () => {
  // hub 门（R3 反例复刻: 8 条 finding 各带共享 .gitignore + 独立文件）
  const specs = Array.from({ length: 8 }, (_, i) => ({ sev: 'major', paths: ['.gitignore', `src/u${i}.ts`] }));
  const art = artifactWithFindings(specs);
  const fid = (i) => art.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const scm = { schema_version: 'v2', consensus_artifact_hash: art.consensus_artifact_hash,
    scs: specs.map((_, i) => ({ id: `SC-${i}`, kind: 'fix', finding_ids: [fid(i)], change: 'c', holds: 'h', verify: VF() })) };
  const r = buildFixPlan({ artifact: art, manifest: scm });
  ok(r.degraded && r.reasons.some((x) => /hub 路径/.test(x)), 'SC-R3-5: 共享 hub 必须 degraded: ' + JSON.stringify(r.reasons ?? r.plan?.waves));
  // 对照: 去掉 hub → 8 组全并行
  const specs2 = Array.from({ length: 8 }, (_, i) => ({ sev: 'major', paths: [`src/u${i}.ts`] }));
  const art2 = artifactWithFindings(specs2);
  const fid2 = (i) => art2.canonical_findings.find((f) => f.anchor.endsWith(`#${i}`)).id;
  const scm2 = { schema_version: 'v2', consensus_artifact_hash: art2.consensus_artifact_hash,
    scs: specs2.map((_, i) => ({ id: `SC-${i}`, kind: 'fix', finding_ids: [fid2(i)], change: 'c', holds: 'h', verify: VF() })) };
  const r2 = buildFixPlan({ artifact: art2, manifest: scm2 });
  ok(!r2.degraded, JSON.stringify(r2.reasons ?? []));
  eq(r2.plan.waves[0].length, 8, '无 hub → 8 组全并行（owner 目标: 拉满也可以）');
  // changed-set 层: anchor 指向 tracked-but-unchanged 文件 → 拒（validator）
  const chg = new Set(['src/changed.ts']);
  const mkV2 = (paths) => mkVerdictFor('claude-adversarial', bundle, { findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'x', anchor_paths: paths, evidence: 'e', status: 'closed' }], closed_finding_ids: ['F1'] });
  eq(validateVerdict(mkV2(['src/changed.ts']), { changedPaths: chg }).length, 0, '实改文件应过');
  ok(validateVerdict(mkV2(['.gitignore']), { changedPaths: chg }).some((e) => /实改文件集/.test(e)), 'SC-R3-5: 锚点不在被审 diff 上必拒');
});

t('[SC-R3-7] allowed_paths 对 verify 组同样强制（else-if 旁路已修）', () => {
  const env = mkRunEnv({ files: ['e2e/x.test.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'v1', sc_ids: ['SC-V'], paths: ['e2e/x.test.ts'], verify: true }], [['v1']],
    [{ id: 'SC-V', kind: 'verify', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'e2e/x.test.ts']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'rV7', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rV7', plan, waveIndex: 0, worktreeRoot: env.wtRoot });
  // verify worker 改 allowed 之外的测试文件（旧 else-if 只查"像测试路径"→ 放行 = R3 输入 A）
  workGroup(env, a.allocations[0], 'sneaky.spec.ts', 'not allowed\n');
  const r = FR.integrate({ stateDir: env.stateDir, runId: 'rV7', plan, waveIndex: 0 });
  ok(!r.ok && r.errors.some((e) => /越域改动/.test(e)), 'SC-R3-7: verify 组越 allowed 改测试文件必拒');
});

t('[SC-R3-8] 洗历史: 中间 commit 藏密钥再恢复（net diff 干净）→ squash 后最终历史无处容身', () => {
  const env = mkRunEnv({ files: ['a.ts'] });
  mkdirSync(env.stateDir, { recursive: true }); mkdirSync(env.wtRoot, { recursive: true });
  const { art, plan, scm } = mkRunSetup(env,
    [{ id: 'g1', sc_ids: ['SC-0'], paths: ['a.ts'] }], [['g1']],
    [{ id: 'SC-0', kind: 'fix', finding_ids: ['f0'], change: 'c', holds: 'h', verify: VF('test', ['-f', 'a.ts']) }]);
  FR.initRun({ stateDir: env.stateDir, runId: 'rL', repoDir: env.r, plan, scManifest: scm, sourceArtifact: art, featureBranch: 'feat' });
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rL', plan, waveIndex: 0, worktreeRoot: env.wtRoot });
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
  const a = FR.allocate({ stateDir: env.stateDir, runId: 'rM', plan, waveIndex: 0, worktreeRoot: env.wtRoot });
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
  const a2 = FR.allocate({ stateDir: env.stateDir, runId: 'rM2', plan, waveIndex: 0, worktreeRoot: join(env.d, 'wt2') });
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
