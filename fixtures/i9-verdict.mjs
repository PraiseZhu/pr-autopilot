#!/usr/bin/env node
// I9: 十类穷举契约扩展至对抗席全 round + attempt 字段 — 独立回归
// 自包含：不依赖 fixtures/run-fixtures.mjs（418K，派工边界禁止改动），自建最小 verdict 工厂。
// 覆盖 SC-1〜SC-6（见派工包）。运行: node fixtures/i9-verdict.mjs（全过 exit 0，有失败 exit 1）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateVerdict, SCHEMA_VERSION } from '../scripts/verdict-validate.mjs';
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
    schema_version: SCHEMA_VERSION, reviewer, run_status: 'ok', round: 1, attempt: 1,
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
  // 变异定性（2026-08-07）: 本输入**同时摘掉两个字段**（hardening_coverage + checklist_version），
  // 原 `.length > 0` 会被 checklist_version 的错误掩盖——实测挖空「缺 hardening_coverage」检查后
  // 本条（.length>0）保持绿（错误数组只剩 checklist_version 一条），下一行点名式断言变红。本条
  // 未绑定它声称验证的字段，是真 finding；升级为点名式，与下一行共同钉住同一字段。
  ok(errs.some((e) => /缺 hardening_coverage/.test(e)), 'round=2 缺 hardening_coverage 必须点名报错: ' + JSON.stringify(errs));
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

// ========== SC-R3-F1/F2/F3: 顶层 additionalProperties:false（out_of_scope_notes 静默丢失事故）==========
// 修前实测基线（lead 派工包 SC-R3-F1）: 把 out_of_scope_notes（复数）typo 成 out_of_scope_note
// （单数）后 validateVerdict 返回 0 errors——域外真问题静默消失，且因为该字段本就是可选字段，
// 缺失/typo 在结构上无法区分，不会在别处触发任何天然警报。下方三条锁住修复后的行为。
t('[SC-R3-F1] 顶层 out_of_scope_notes typo 成 out_of_scope_note（单数）→ 拒（此前 0 errors 静默丢失）', () => {
  const v = mkVerdict('claude-adversarial', {
    out_of_scope_note: [{ id: 'N1', note: '仓库既有问题', evidence: 'e', suggested_issue_title: 't' }]
  });
  const errs = validateVerdict(v);
  ok(errs.length > 0, 'typo 后必须报错（此前静默通过）: ' + JSON.stringify(errs));
  ok(errs.some((e) => /未知顶层字段: out_of_scope_note（/.test(e)), '必须点名未知字段 out_of_scope_note: ' + JSON.stringify(errs));
});

t('[SC-R3-F2] 顶层任意未知字段（与 out_of_scope_notes 无关的普通 typo）→ 同样拒（证明是通用机制，不是专门为一个字段名打的补丁）', () => {
  const v = mkVerdict('claude-adversarial', { r3f2_bogus_field: 'x' });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /未知顶层字段: r3f2_bogus_field（/.test(e)), '必须点名未知字段 r3f2_bogus_field: ' + JSON.stringify(errs));
});

t('[SC-R3-F3] 合法 verdict（含正确的 out_of_scope_notes 复数 / 或完全不带该可选字段）→ 仍过（新增拒绝不误伤正常路径）', () => {
  const withNotes = mkVerdict('claude-adversarial', {
    out_of_scope_notes: [{ id: 'N1', note: '仓库既有问题', evidence: 'e', suggested_issue_title: 't' }]
  });
  eq(validateVerdict(withNotes).length, 0, '正确的 out_of_scope_notes（复数）应零错误: ' + JSON.stringify(validateVerdict(withNotes)));
  const withoutNotes = mkVerdict('claude-adversarial');
  eq(validateVerdict(withoutNotes).length, 0, '完全不带该可选字段应零错误: ' + JSON.stringify(validateVerdict(withoutNotes)));
});

// ========== SC-R3-F6: 另三个字段名类项的逐个实测（不凭推理分类）==========
// close_dual_condition（status/closed_finding_ids）: 均为必填值校验字段——typo 后该字段读到
// undefined，天然落不进任何合法枚举/类型，实测: fail loud（下方两条锁住证据，登记为可容忍残留，
// 不需要根治）。
t('[SC-R3-F6-a1] close_dual_condition: finding.status typo(statuss) → fail loud（可容忍残留，非静默）', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'suggestion', anchor: 'a', anchor_paths: ['x'], evidence: 'e', statuss: 'closed' }]
  });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /status 非法/.test(e)), 'status 必填值校验必须 fail loud: ' + JSON.stringify(errs));
});
t('[SC-R3-F6-a2] close_dual_condition: 顶层 closed_finding_ids typo(closed_finding_id 单数) → fail loud（可容忍残留，非静默）', () => {
  const v = mkVerdict('claude-adversarial', { closed_finding_id: ['X'] });
  delete v.closed_finding_ids;
  const errs = validateVerdict(v);
  ok(errs.some((e) => /closed_finding_ids 必须是数组/.test(e)), 'closed_finding_ids 必填值校验必须 fail loud: ' + JSON.stringify(errs));
});

// forbidden_finding_fields（write_paths/allowed_paths）: 精确字符串匹配的禁入检查，typo 后实测
// 曾是 0 errors 静默放过（D2 写入许可边界失守）——已按 SC-R3-F2 同一机制根治（FINDING_KEYS），
// 下方锁住修复后的行为，同时保留"仍是同一根因、非各自独立打了补丁"的证据。
t('[SC-R3-F6-b1] forbidden_finding_fields: write_paths typo(write_path 单数) → 已根治，现在 fail loud（此前静默）', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F2', primary_face: 'A', severity: 'suggestion', anchor: 'a', anchor_paths: ['x'], evidence: 'e', status: 'open', write_path: ['src/x.ts'] }]
  });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /未知字段: write_path（/.test(e)), 'write_path（typo）必须被 FINDING_KEYS 拒绝: ' + JSON.stringify(errs));
});
t('[SC-R3-F6-b2] forbidden_finding_fields: allowed_paths typo(allowed_path 单数) → 已根治，现在 fail loud（此前静默）', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F3', primary_face: 'A', severity: 'suggestion', anchor: 'a', anchor_paths: ['x'], evidence: 'e', status: 'open', allowed_path: ['src/x.ts'] }]
  });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /未知字段: allowed_path（/.test(e)), 'allowed_path（typo）必须被 FINDING_KEYS 拒绝: ' + JSON.stringify(errs));
});
t('[SC-R3-F6-b3] forbidden_finding_fields sanity: 正确拼写 write_paths/allowed_paths 仍被 D2 专项检查 + FINDING_KEYS 双重拒绝（新机制不替代旧检查）', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F2b', primary_face: 'A', severity: 'suggestion', anchor: 'a', anchor_paths: ['x'], evidence: 'e', status: 'open', write_paths: ['src/x.ts'] }]
  });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /不得提供 write_paths（D2/.test(e)), 'D2 专项检查必须仍在: ' + JSON.stringify(errs));
  ok(errs.some((e) => /未知字段: write_paths（/.test(e)), 'FINDING_KEYS 检查也命中同一 key（双重把关，无害）: ' + JSON.stringify(errs));
});

// actionable_required_fields（invariant/family_id）: 均为必填值校验字段（仅 actionable severity
// 强制），typo 后同样落到 undefined，实测: fail loud（登记为可容忍残留，不需要根治；FINDING_KEYS
// 新机制额外覆盖，但原有必填值校验本身已经足够）。
t('[SC-R3-F6-c1] actionable_required_fields: invariant typo(invariants) → fail loud（可容忍残留，非静默）', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F4', primary_face: 'A', severity: 'blocker', anchor: 'a', anchor_paths: ['x'], evidence: 'e', status: 'open', invariants: 'xxx', family_id: 'fam1' }]
  });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /缺 invariant 或超长/.test(e)), 'invariant 必填值校验必须 fail loud: ' + JSON.stringify(errs));
});
t('[SC-R3-F6-c2] actionable_required_fields: family_id typo(family_ids) → fail loud（可容忍残留，非静默）', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F5', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['x'], evidence: 'e', status: 'open', invariant: 'inv1', family_ids: 'fam1' }]
  });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /缺 family_id/.test(e)), 'family_id 必填值校验必须 fail loud: ' + JSON.stringify(errs));
});

// ========== SC-T7b: family_claim（validator 单元层）==========
// 背景（owner 批准的 pr-autopilot 剩余 SC-T7b，2026-08-08）: 每条 actionable finding 必须显式
// 声明「复用上一轮真实问题族」或「新问题」；known families 权威只来自同一谱系
// parentArtifact.canonical_findings（deriveKnownFamilies，round=1→null）；机器只证明「引用本
// 谱系存在族」，不判语义（SC-4）。以下测试覆盖 SC-1/SC-2/SC-3 的 validator 层验收点。
import { deriveKnownFamilies, familyKeyOf as vvFamilyKeyOf } from '../scripts/verdict-validate.mjs';
import { familyKeyOf as cgFamilyKeyOf } from '../scripts/consensus-gate.mjs';

// 最小 parent artifact 构造（deriveKnownFamilies 只消费 canonical_findings；validator 层的
// reuse 存在性校验不需要完整 artifact——完整谱系校验属 consensus-gate 层，run-fixtures 覆盖）
function mkParent(canonicalFindings) {
  return { canonical_findings: canonicalFindings };
}
const INV1 = 'X 必须唯一写者';
const K1 = vvFamilyKeyOf(INV1); // 真实 fk1- key（与 consensus-gate 同源派生）
const K2 = vvFamilyKeyOf('删除必须走事务性 reconciliation');

t('[SC-T7b-1] round=1 + kind:new（非空 reason）→ 过；suggestion 不要求 family_claim', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'blocker', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'new', reason: '本轮新发现的问题族' } }],
    closed_finding_ids: ['F1']
  });
  eq(validateVerdict(v, { parentArtifact: null }).length, 0, 'round=1 + new 应零错误: ' + JSON.stringify(validateVerdict(v, { parentArtifact: null })));
  // suggestion 不要求 claim（即便带 actionable 字段的 suggestion 也过）
  const sv = mkVerdict('claude-adversarial', {
    findings: [{ id: 'S1', primary_face: 'A', severity: 'suggestion', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'open', invariant: 'inv-s', family_id: 'fam-s' }]
  });
  eq(validateVerdict(sv).length, 0, 'suggestion 无 claim 应过: ' + JSON.stringify(validateVerdict(sv)));
});

t('[SC-T7b-2] round=1 + kind:reuse → 拒（谱系根无 parent，known families 为空）且点名「无 parent」', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'reuse', target_family_key: K1 } }],
    closed_finding_ids: ['F1']
  });
  const errs = validateVerdict(v, { parentArtifact: null });
  ok(errs.some((e) => /无 parent/.test(e)), 'round=1 reuse 必须点名无 parent: ' + JSON.stringify(errs));
});

t('[SC-T7b-3] round>=2 + reuse 引用 parent 真实 key → 过（reuse 合法，机器只验存在性）', () => {
  const parent = mkParent([{ family_key: K1, invariant: INV1 }]);
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'reuse', target_family_key: K1 } }],
    closed_finding_ids: ['F1']
  });
  eq(validateVerdict(v, { parentArtifact: parent }).length, 0, 'reuse 引用 parent 真实 key 应零错误: ' + JSON.stringify(validateVerdict(v, { parentArtifact: parent })));
});

t('[SC-T7b-4] round>=2 + reuse 引用自造 key（fk1- 前缀合法但不在 parent）→ 拒且点名「不在上一轮 known families」', () => {
  const parent = mkParent([{ family_key: K1, invariant: INV1 }]);
  const forgedKey = 'fk1-' + 'a'.repeat(64); // 格式合法但绝不可能是真实派生 key
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'reuse', target_family_key: forgedKey } }],
    closed_finding_ids: ['F1']
  });
  const errs = validateVerdict(v, { parentArtifact: parent });
  ok(errs.some((e) => /不在上一轮 known families/.test(e)), '自造 key 必须点名不在 known families: ' + JSON.stringify(errs));
});

t('[SC-T7b-5] round>=2 + reuse 引用错 parent（传了 parent 但其 canonical 无此 key）→ 拒（同 4 的消息形态）', () => {
  // 错 parent = 引用 K1 但传的 parent 只含 K2——K1 在该谱系不存在
  const wrongParent = mkParent([{ family_key: K2, invariant: '删除必须走事务性 reconciliation' }]);
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'reuse', target_family_key: K1 } }],
    closed_finding_ids: ['F1']
  });
  const errs = validateVerdict(v, { parentArtifact: wrongParent });
  ok(errs.some((e) => /不在上一轮 known families/.test(e)), '错 parent 必须拒（K1 不在该谱系）: ' + JSON.stringify(errs));
});

t('[SC-T7b-6] round>=2 + reuse 但缺 parent 传参 → 拒且点名「无 parent」（known families 无法派生）', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'reuse', target_family_key: K1 } }],
    closed_finding_ids: ['F1']
  });
  const errs = validateVerdict(v); // 不传 parentArtifact
  ok(errs.some((e) => /无 parent/.test(e)), 'reuse 缺 parent 必须点名无 parent: ' + JSON.stringify(errs));
});

t('[SC-T7b-7] actionable 缺 family_claim → 拒且点名「缺 family_claim」', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'blocker', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1' }],
    closed_finding_ids: ['F1']
  });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /缺 family_claim/.test(e)), '缺 claim 必须点名缺 family_claim: ' + JSON.stringify(errs));
});

t('[SC-T7b-8] inner 多余键各自独立拒绝: reuse 带 reason / new 带 target_family_key / 未知键', () => {
  const parent = mkParent([{ family_key: K1, invariant: INV1 }]);
  const reuseWithReason = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'reuse', target_family_key: K1, reason: '多余' } }],
    closed_finding_ids: ['F1']
  });
  const e1 = validateVerdict(reuseWithReason, { parentArtifact: parent });
  ok(e1.some((e) => /不得携带 reason/.test(e)), 'reuse 带 reason 必须拒且点名: ' + JSON.stringify(e1));

  const newWithTarget = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'new', reason: 'x', target_family_key: K1 } }],
    closed_finding_ids: ['F1']
  });
  const e2 = validateVerdict(newWithTarget);
  ok(e2.some((e) => /不得携带 target_family_key/.test(e)), 'new 带 target_family_key 必须拒且点名: ' + JSON.stringify(e2));

  const withUnknown = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'new', reason: 'x', bogus: 'y' } }],
    closed_finding_ids: ['F1']
  });
  const e3 = validateVerdict(withUnknown);
  ok(e3.some((e) => /family_claim 存在未知字段: bogus/.test(e)), '未知键必须拒且点名: ' + JSON.stringify(e3));
});

t('[SC-T7b-9] new reason 空串 → 拒且点名「缺 reason 或为空串」', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'new', reason: '' } }],
    closed_finding_ids: ['F1']
  });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /缺 reason 或为空串/.test(e)), 'new reason 空串必须拒且点名: ' + JSON.stringify(errs));
});

t('[SC-T7b-10] kind 非法 → 拒且点名「kind 非法」', () => {
  const v = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'maybe', reason: 'x' } }],
    closed_finding_ids: ['F1']
  });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /kind 非法/.test(e)), 'kind 非法必须拒且点名: ' + JSON.stringify(errs));
});

t('[SC-T7b-11] reuse target_family_key 空串 / 非 fk1- 前缀 → 各自独立拒', () => {
  const vEmpty = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'reuse', target_family_key: '' } }],
    closed_finding_ids: ['F1']
  });
  const e1 = validateVerdict(vEmpty);
  ok(e1.some((e) => /缺 target_family_key 或为空串/.test(e)), '空串必须点名: ' + JSON.stringify(e1));

  const vBad = mkVerdict('claude-adversarial', {
    findings: [{ id: 'F1', primary_face: 'A', severity: 'major', anchor: 'a', anchor_paths: ['src/a.ts'], evidence: 'e', status: 'closed', invariant: INV1, family_id: 'fam1', family_claim: { kind: 'reuse', target_family_key: 'fk2-abc' } }],
    closed_finding_ids: ['F1']
  });
  const e2 = validateVerdict(vBad);
  ok(e2.some((e) => /须为 fk1- 前缀/.test(e)), '非 fk1- 前缀必须点名: ' + JSON.stringify(e2));
});

t('[SC-T7b-12] 旧 schema（v3）→ fail-loud 点名 schema_version（bump 后旧 verdict 必须拒）', () => {
  const v = mkVerdict('claude-adversarial', { schema_version: 'v3' });
  const errs = validateVerdict(v);
  ok(errs.some((e) => /schema_version 必须为/.test(e)), 'v3 verdict 必须 fail-loud 点名 schema_version: ' + JSON.stringify(errs));
});

t('[SC-T7b-13] deriveKnownFamilies: round=1（无 parent）→ null；round>=2 排序去重只留 family_key+invariant', () => {
  eq(deriveKnownFamilies(null), null, '无 parent 必须返回 null（空集合语义）');
  eq(deriveKnownFamilies(undefined), null, 'undefined parent 必须返回 null');
  const k1 = vvFamilyKeyOf('同一不变量的文本');
  const k2 = vvFamilyKeyOf('另一个不变量');
  const parent = mkParent([
    { family_key: k2, invariant: '另一个不变量', extra_field: '不该带出来' },
    { family_key: k1, invariant: '同一不变量的文本' },
    { family_key: k1, invariant: '同一不变量的文本（重复 key）' } // 去重：重复 key 只留首个
  ]);
  const known = deriveKnownFamilies(parent);
  eq(known.length, 2, '去重后应只有 2 个 family: ' + JSON.stringify(known));
  // 排序按 family_key 字符串字典序（localeCompare），不是按 invariant 或插入序
  const sortedKeys = [k1, k2].sort((a, b) => a.localeCompare(b));
  eq(known[0].family_key, sortedKeys[0], '按 family_key 字典序排序，首个应为较小的 key: ' + JSON.stringify(known));
  eq(known[1].family_key, sortedKeys[1], '次个应为较大的 key: ' + JSON.stringify(known));
  eq(Object.keys(known[0]).sort().join(','), 'family_key,invariant', '只带 family_key+invariant 两字段: ' + JSON.stringify(known[0]));
  eq(known[0].invariant, known[0].family_key === k1 ? '同一不变量的文本' : '另一个不变量', 'invariant 取首个遇到的值');
  eq(deriveKnownFamilies(mkParent([])), [], 'parent 无 canonical_findings → 空数组（不是 null，谱系存在但无族）');
});

t('[SC-T7b-14] familyKeyOf 派生单一实现: verdict-validate 与 consensus-gate re-export 逐字一致（SC-4 派生不被 claim 改变）', () => {
  eq(vvFamilyKeyOf(INV1), cgFamilyKeyOf(INV1), '两处 familyKeyOf 必须同值（re-export 单一实现）');
  ok(String(vvFamilyKeyOf(INV1)).startsWith('fk1-'), 'key 必须带 fk1- 前缀');
  // SC-4: claim 不改变派生——同一 invariant 无论带什么 claim，key 都一样
  eq(vvFamilyKeyOf('  同一  不变量 '), vvFamilyKeyOf('同一不变量'), '归一化（去空白）后同文本 → 同 key');
});

// ========== 版本字面量自检（2026-08-07）==========
t('[版本字面量] 本文件 verdict 构造须用 SCHEMA_VERSION 派生，不得残留 verdict schema_version 字面量（照 [SC-12] 写法）', () => {
  const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  ok(/schema_version: SCHEMA_VERSION, reviewer/.test(own), '本文件 verdict 构造必须用 SCHEMA_VERSION 派生常量');
  const lit = "schema_version: 'v" + "[0-9]', reviewer";
  ok(!new RegExp(lit).test(own), '本文件不得残留 verdict schema_version 字面量（须用 SCHEMA_VERSION 派生）');
});

// ========== 汇总 ==========
console.log(`\n========== i9-verdict fixtures: ${pass} passed, ${failCount} failed ==========`);
if (failCount) { console.log('failed: ' + failures.join(' | ')); process.exit(1); }
process.exit(0);
