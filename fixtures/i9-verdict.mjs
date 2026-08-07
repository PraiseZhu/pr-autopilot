#!/usr/bin/env node
// I9: 十类穷举契约扩展至对抗席全 round + attempt 字段 — 独立回归
// 自包含：不依赖 fixtures/run-fixtures.mjs（418K，派工边界禁止改动），自建最小 verdict 工厂。
// 覆盖 SC-1〜SC-6（见派工包）。运行: node fixtures/i9-verdict.mjs（全过 exit 0，有失败 exit 1）。
import { validateVerdict } from '../scripts/verdict-validate.mjs';
import { HARDENING_CLASS_COUNT, HARDENING_CHECKLIST_VERSION } from '../scripts/lib/hardening-registry.mjs';

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

const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40);
const RIH = 'e'.repeat(64); // 格式校验用固定合法 64-hex；本文件不校验其与 bundle 内容的对应关系

const FULL_FACES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((f) => ({ face: f, result: f === 'B' ? 'n_a' : 'pass', evidence: `${f} 面走查完成` }));
const THIRD_FACES = ['D', 'E', 'F', 'G'].map((f) => ({ face: f, result: 'pass', evidence: `${f} 面走查完成` }));
const THIRD_GATES = ['format-gate', 'rule-compliance', 'security-privacy-gate', 'product-arch-gate'].map((g) => ({ gate_id: g, result: 'pass', evidence: `${g} 走查完成` }));
// 默认 evidence 已是「路径:行号」形态（SC-5 要求），本文件自身路径当锚点
const FULL_HARDENING = Array.from({ length: HARDENING_CLASS_COUNT }, (_, i) => ({ class_id: i + 1, result: 'covered', evidence: `fixtures/i9-verdict.mjs:${i + 1} 第${i + 1}类核对完成` }));

function mkVerdict(reviewer, over = {}) {
  return {
    schema_version: 'v3', reviewer, run_status: 'ok', round: 1, attempt: 1,
    base_sha: SHA_A, candidate_sha: SHA_B, review_input_hash: RIH,
    faces: reviewer === 'upstream-preview' ? THIRD_FACES : FULL_FACES,
    findings: [], gate_checks: reviewer === 'upstream-preview' ? THIRD_GATES : [],
    verdict: 'APPROVED', closed_finding_ids: [],
    ...(reviewer === 'upstream-preview' ? {} : { hardening_coverage: FULL_HARDENING, checklist_version: HARDENING_CHECKLIST_VERSION }),
    ...over
  };
}

// ========== SC-1 ==========
t('[SC-1] 对抗席 round=2 缺 hardening_coverage → 拒，且报错可分辨"缺十类覆盖"', () => {
  const v = mkVerdict('claude-adversarial', { round: 2, hardening_coverage: undefined, checklist_version: undefined });
  const errs = validateVerdict(v);
  ok(errs.length > 0, 'round=2 缺 hardening_coverage 必须报错: ' + JSON.stringify(errs));
  ok(errs.some((e) => /缺 hardening_coverage/.test(e)), '必须有明确指向"缺 hardening_coverage"的错误: ' + JSON.stringify(errs));
});

// ========== SC-2 ==========
t('[SC-2] 对抗席 round=2 携带完整合法十类 → 过', () => {
  const v = mkVerdict('codex-adversarial', { round: 2 });
  const errs = validateVerdict(v);
  eq(errs.length, 0, 'round=2 + 完整十类应零错误: ' + JSON.stringify(errs));
});

// ========== SC-3 ==========
t('[SC-3] 第三席任何 round 都不要求十类（round=1/round=2 均不带该字段也应过）', () => {
  eq(validateVerdict(mkVerdict('upstream-preview', { round: 1 })).length, 0, '第三席 round=1 应过');
  eq(validateVerdict(mkVerdict('upstream-preview', { round: 2 })).length, 0, '第三席 round=2 应过');
});

// ========== SC-4：exact 集合约束在全 round 下照旧生效，四种畸形互相隔离 ==========
t('[SC-4-a] round=2 只有 9 项 → 拒（数量/缺项，不混入其他三种畸形）', () => {
  const v = mkVerdict('claude-adversarial', { round: 2, hardening_coverage: FULL_HARDENING.slice(0, 9) });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /必须恰好 10 项|缺 class_id=10/.test(e)), '必须指向数量/缺项: ' + JSON.stringify(errs));
  ok(!errs.some((e) => /重复|清单版本过期|evidence 缺「路径/.test(e)), '不应混入重复/版本/evidence-格式 错误: ' + JSON.stringify(errs));
});

t('[SC-4-b] round=2 class_id 重复 → 拒（重复，不混入其他三种畸形）', () => {
  const dupCov = [...FULL_HARDENING.slice(0, 9), { class_id: 1, result: 'covered', evidence: FULL_HARDENING[0].evidence }];
  const v = mkVerdict('claude-adversarial', { round: 2, hardening_coverage: dupCov });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /重复/.test(e)), '必须报 class_id 重复: ' + JSON.stringify(errs));
  ok(!errs.some((e) => /清单版本过期|evidence 缺「路径/.test(e)), '不应混入版本/evidence-格式 错误: ' + JSON.stringify(errs));
});

t('[SC-4-c] round=2 某项 evidence 为空串 → 拒（缺 evidence，不混入其他三种畸形）', () => {
  const cov = FULL_HARDENING.map((it, i) => (i === 3 ? { ...it, evidence: '' } : it));
  const v = mkVerdict('claude-adversarial', { round: 2, hardening_coverage: cov });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /缺 evidence/.test(e)), '必须报缺 evidence: ' + JSON.stringify(errs));
  ok(!errs.some((e) => /清单版本过期|重复|必须恰好 10 项|缺 class_id=/.test(e)), '不应混入版本/重复/数量 错误: ' + JSON.stringify(errs));
});

t('[SC-4-d] round=2 checklist_version 过期 → 拒，且独立可辨认（不与缺项计数混淆）', () => {
  const v = mkVerdict('claude-adversarial', { round: 2, checklist_version: HARDENING_CHECKLIST_VERSION - 1 });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /清单版本过期需重审/.test(e)), '必须报清单版本过期需重审: ' + JSON.stringify(errs));
  ok(errs.some((e) => /checklist_version/.test(e)), '错误信息必须点名 checklist_version 字段本身: ' + JSON.stringify(errs));
  ok(!errs.some((e) => /必须恰好 10 项|缺 class_id=|重复/.test(e)), '版本错误不得被淹进缺项计数错误里: ' + JSON.stringify(errs));
});

// ========== SC-5：hardening_coverage.evidence 路径:行号 格式 ==========
t('[SC-5] hardening_coverage.evidence 不含"路径:行号" → 拒；含则过', () => {
  const bad = mkVerdict('claude-adversarial', {
    hardening_coverage: FULL_HARDENING.map((it, i) => (i === 0 ? { ...it, evidence: '走查完成，没问题' } : it))
  });
  const errsBad = validateVerdict(bad);
  ok(errsBad.some((e) => /evidence 缺「路径:行号」形态引用/.test(e)), '必须报 evidence 格式错误: ' + JSON.stringify(errsBad));

  const good = mkVerdict('claude-adversarial'); // FULL_HARDENING 默认已是「路径:行号」形态
  eq(validateVerdict(good).length, 0, '合法 evidence 格式应零错误: ' + JSON.stringify(validateVerdict(good)));
});

// ========== SC-5b：n_a 不强制路径:行号（否则逼审查席造假锚点），covered 仍强制 ==========
function withResult(index, result, evidence) {
  return FULL_HARDENING.map((it, i) => (i === index ? { class_id: it.class_id, result, evidence } : it));
}

t('[SC-5b-1] result=n_a + 合法说明文本（无路径:行号）→ 过', () => {
  const v = mkVerdict('claude-adversarial', {
    hardening_coverage: withResult(3, 'n_a', '本 PR 无并发/异步改动，该类无适用面')
  });
  eq(validateVerdict(v).length, 0, 'n_a + 合法说明应零错误: ' + JSON.stringify(validateVerdict(v)));
});

t('[SC-5b-2] result=n_a + 敷衍短文本 → 拒', () => {
  const v = mkVerdict('claude-adversarial', { hardening_coverage: withResult(3, 'n_a', '无') });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /（n_a）的 evidence 过短/.test(e)), '必须报 n_a evidence 过短: ' + JSON.stringify(errs));
});

t('[SC-5b-3] result=covered + 无路径:行号 → 仍拒（SC-5 原意保留，不因分支拆分而漏判）', () => {
  const v = mkVerdict('claude-adversarial', { hardening_coverage: withResult(3, 'covered', '已仔细核对完成，没有问题') });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /（covered）的 evidence 缺「路径:行号」形态引用/.test(e)), '必须报 covered evidence 格式错误: ' + JSON.stringify(errs));
});

// ========== SC-6：attempt 字段 ==========
t('[SC-6-a] attempt 缺失 → 拒', () => {
  ok(validateVerdict(mkVerdict('claude-adversarial', { attempt: undefined })).some((e) => /attempt 非法/.test(e)), 'attempt 缺失必须报错');
});
t('[SC-6-b] attempt 非整数/非 number → 拒', () => {
  ok(validateVerdict(mkVerdict('claude-adversarial', { attempt: 1.5 })).some((e) => /attempt 非法/.test(e)), 'attempt=1.5 必须报错');
  ok(validateVerdict(mkVerdict('claude-adversarial', { attempt: '1' })).some((e) => /attempt 非法/.test(e)), 'attempt="1"（字符串）必须报错');
});
t('[SC-6-c] attempt 小于 1 → 拒', () => {
  ok(validateVerdict(mkVerdict('claude-adversarial', { attempt: 0 })).some((e) => /attempt 非法/.test(e)), 'attempt=0 必须报错');
  ok(validateVerdict(mkVerdict('claude-adversarial', { attempt: -1 })).some((e) => /attempt 非法/.test(e)), 'attempt=-1 必须报错');
});
t('[SC-6-d] attempt 合法（≥1 整数）→ 过', () => {
  eq(validateVerdict(mkVerdict('claude-adversarial', { attempt: 1 })).length, 0, 'attempt=1 应过');
  eq(validateVerdict(mkVerdict('claude-adversarial', { attempt: 7 })).length, 0, 'attempt=7 应过');
});

// ========== 汇总 ==========
console.log(`\n========== i9-verdict fixtures: ${pass} passed, ${failCount} failed ==========`);
if (failCount) { console.log('failed: ' + failures.join(' | ')); process.exit(1); }
process.exit(0);
