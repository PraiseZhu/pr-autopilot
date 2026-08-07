#!/usr/bin/env node
// fixtures/i9-docs.mjs — issue #9 文档/派工契约修复（SC-1/SC-4）的独立回归。
// 范围：只测 dispatch-contract.mjs 新增的两条处置字面值（「答」撤回 / 「推」统一进
// out_of_scope_notes），不改动 fixtures/run-fixtures.mjs 与 fixtures/run-all.sh，
// 独立跑：`node fixtures/i9-docs.mjs`。
//
// 背景：SKILL.md 与 dispatch-contract.mjs 曾要求「答」「推」两种处置也走
// status=closed + closed_finding_ids 双条件，导致它们进 canonical_findings，
// 而 sc-coverage-gate.mjs 的 mustCover 要求每条 blocker/major 恰好被 1 条 SC 覆盖——
// 答/推都没有 SC，收不了口。本次修法：答从 findings[] 撤回、推统一走
// out_of_scope_notes[]，两者都不再进 canonical_findings，因此不需要 SC 覆盖。
import { readFileSync } from 'node:fs';
import {
  contractSpec,
  contractDigest,
  emitContract,
  requiredLiterals,
  checkDispatchPackage,
  ANSWERED_WITHDRAW_LITERAL,
  DEFERRED_UNIFIED_LITERAL,
  SEATS,
} from '../scripts/dispatch-contract.mjs';
import { HARDENING_CHECKLIST_VERSION, HARDENING_CLASS_COUNT } from '../scripts/lib/hardening-registry.mjs';
import { validateVerdict } from '../scripts/verdict-validate.mjs';

let pass = 0, failCount = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failCount++;
    failures.push(name);
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg = '') {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg} expected=${jb} got=${ja}`);
}

// round=2（非首轮）：验证两条新字面值在 round>=2 下同样生效——issue #9 落地后加固清单穷举
// 已扩大到「对抗席全 round」（hardeningRequired 不再判 round===1），round=2 现在也会带
// hardening_coverage 要求，用它做默认场景正好覆盖这条，不必额外切到 round=1。
const SEAT = 'claude-adversarial';
const ROUND = 2;

console.log('\n[i9-docs] SC-1/SC-4 独立回归');

t('[I9-DOC-01] emit 输出逐字包含两条新处置字面值（答撤回 / 推统一通道）', () => {
  const text = emitContract({ seat: SEAT, round: ROUND });
  ok(text.includes(ANSWERED_WITHDRAW_LITERAL), 'emit 输出须含答撤回字面值');
  ok(text.includes(DEFERRED_UNIFIED_LITERAL), 'emit 输出须含推统一通道字面值');
});

t('[I9-DOC-02] requiredLiterals 同步收录两条新字面值（单一真相源，不手写清单）', () => {
  const lits = requiredLiterals({ seat: SEAT, round: ROUND });
  ok(lits.includes(ANSWERED_WITHDRAW_LITERAL), 'requiredLiterals 须含答撤回字面值');
  ok(lits.includes(DEFERRED_UNIFIED_LITERAL), 'requiredLiterals 须含推统一通道字面值');
});

t('[I9-DOC-03] 正向: emit 输出必过自身 check（新字面值不破坏既有闭环）', () => {
  const text = emitContract({ seat: SEAT, round: ROUND });
  const r = checkDispatchPackage(text, { seat: SEAT, round: ROUND });
  ok(r.ok, `emit 自身应过 check，缺: ${r.missing.join(', ')}`);
});

t('[I9-DOC-04] 反向变异①: 删掉「答」撤回字面值 → check 必拦、且恰好红这 1 条', () => {
  const text = emitContract({ seat: SEAT, round: ROUND });
  ok(text.includes(ANSWERED_WITHDRAW_LITERAL), '前置条件: 原文本须包含该字面值');
  const mutated = text.split(ANSWERED_WITHDRAW_LITERAL).join('（此处曾说明答类处置，字面值被删）');
  const r = checkDispatchPackage(mutated, { seat: SEAT, round: ROUND });
  ok(!r.ok, '删掉必需字面值后 check 必须拦下');
  eq(r.missing, [ANSWERED_WITHDRAW_LITERAL], '必须恰好红这 1 条，不多不少');
});

t('[I9-DOC-05] 反向变异②: 删掉「推」统一通道字面值 → check 必拦、且恰好红这 1 条', () => {
  const text = emitContract({ seat: SEAT, round: ROUND });
  ok(text.includes(DEFERRED_UNIFIED_LITERAL), '前置条件: 原文本须包含该字面值');
  const mutated = text.split(DEFERRED_UNIFIED_LITERAL).join('（此处曾说明推类处置，字面值被删）');
  const r = checkDispatchPackage(mutated, { seat: SEAT, round: ROUND });
  ok(!r.ok, '删掉必需字面值后 check 必须拦下');
  eq(r.missing, [DEFERRED_UNIFIED_LITERAL], '必须恰好红这 1 条，不多不少');
  // 顺带核对：`out_of_scope_notes` 这个独立字面值仍由 emit 输出里紧随其后的
  // `${spec.out_of_scope_channel}[]` 用法满足，不会因为删掉 DEFERRED_UNIFIED_LITERAL
  // 而连带误报——证明两条要求彼此独立、不是同一处文本在做双重记账。
  ok(mutated.includes('out_of_scope_notes'), '独立字面值 out_of_scope_notes 应仍在场（另一处引用）');
});

t('[I9-DOC-06] 陈旧契约段（缺两条新字面值）必被拦，且缺项清单明确点名这两条', () => {
  // 模拟「改动前」粘贴的旧契约段：同时抹掉两条新字面值，验证 check 不是只靠 digest
  // 兜底拦截，缺项清单本身也明确列出这两条——lead 看错误信息就知道该补什么。
  const staleText = emitContract({ seat: SEAT, round: ROUND })
    .split(ANSWERED_WITHDRAW_LITERAL).join('（旧版契约段：无此说明）')
    .split(DEFERRED_UNIFIED_LITERAL).join('（旧版契约段：无此说明）');
  const r = checkDispatchPackage(staleText, { seat: SEAT, round: ROUND });
  ok(!r.ok, '缺两条新字面值必拦');
  ok(r.missing.includes(ANSWERED_WITHDRAW_LITERAL), '缺项清单必须点名答撤回字面值');
  ok(r.missing.includes(DEFERRED_UNIFIED_LITERAL), '缺项清单必须点名推统一通道字面值');
});

t('[I9-DOC-07] 三席 × round 1/2 全覆盖: emit→check 闭环不因新增字面值对任一组合失效', () => {
  for (const seat of SEATS) {
    for (const round of [1, 2]) {
      const text = emitContract({ seat, round });
      const r = checkDispatchPackage(text, { seat, round });
      ok(r.ok, `seat=${seat} round=${round} 应过 check，缺: ${r.missing.join(', ')}`);
      ok(text.includes(ANSWERED_WITHDRAW_LITERAL), `seat=${seat} round=${round} 应含答撤回字面值`);
      ok(text.includes(DEFERRED_UNIFIED_LITERAL), `seat=${seat} round=${round} 应含推统一通道字面值`);
    }
  }
});

t('[I9-DOC-08a] 加固清单穷举适用范围=对抗席全 round: contractSpec 对两对抗席任一 round 都要求 hardening，第三席任一 round 都不要求', () => {
  for (const round of [1, 2, 3]) {
    eq(contractSpec({ seat: 'claude-adversarial', round }).hardening.required, true, `claude-adversarial round=${round} 应要求 hardening`);
    eq(contractSpec({ seat: 'codex-adversarial', round }).hardening.required, true, `codex-adversarial round=${round} 应要求 hardening`);
    eq(contractSpec({ seat: 'upstream-preview', round }).hardening.required, false, `upstream-preview round=${round} 不应要求 hardening`);
  }
});

t('[I9-DOC-08b] round>=2 的 emit/requiredLiterals 同步带上 hardening_coverage 要求（不再是 round===1 独有）', () => {
  const text = emitContract({ seat: SEAT, round: ROUND }); // ROUND=2
  ok(text.includes('hardening_coverage'), 'round=2 的 emit 输出必须含 hardening_coverage（对抗席全 round 强制）');
  ok(text.includes(`checklist_version: ${HARDENING_CHECKLIST_VERSION}`), 'round=2 的 emit 输出必须含当前 checklist_version');
  const lits = requiredLiterals({ seat: SEAT, round: ROUND });
  ok(lits.includes('hardening_coverage'), 'round=2 的 requiredLiterals 必须含 hardening_coverage');
  // 反向变异: 陈旧派工包（改动前生成，缺 hardening_coverage）在 round=2 下必被拦——
  // 这正是 lead 指出的「R2 契约不要求填十类 → 审查席老实交卷未带 → validator 拒收 → 整轮作废」
  // 那条死锁链的机器验证：check 层必须先行拦下，不能等 validator 收卷才发现。
  const staleR2 = text.split('hardening_coverage').join('');
  const r = checkDispatchPackage(staleR2, { seat: SEAT, round: ROUND });
  ok(!r.ok, '缺 hardening_coverage 的 round=2 派工包必须被 check 拦下');
  ok(r.missing.includes('hardening_coverage'), '缺项清单必须点名 hardening_coverage');
});

t('[I9-DOC-08] digest 反漂移未被新字面值破坏：spec 改动仍会让旧 digest 失配', () => {
  // 用第三席（upstream-preview）——只有它的 spec 真正读取 `requirements.third_seat_required_gates`
  // （对抗席的 required_gate_ids 恒为 []，改 requirements 对其 spec/digest 无影响）。
  const thirdSeat = 'upstream-preview';
  const oldText = emitContract({ seat: thirdSeat, round: ROUND });
  const requirements = { third_seat_required_gates: ['brand-new-i9-gate'] };
  const rStale = checkDispatchPackage(oldText, { seat: thirdSeat, round: ROUND, requirements });
  ok(!rStale.ok, '旧契约段在新 requirements 下必失配（digest 或字面值任一变化都应被拦）');
  const d = contractDigest(contractSpec({ seat: SEAT, round: ROUND }));
  ok(emitContract({ seat: SEAT, round: ROUND }).includes(`contract_digest=${d}`), 'emit 输出必须携带与当前 spec 一致的 digest');
});

// ========== R2-P1 契约漂移修复回归（SC-R2-C1〜C6）==========
// 背景：本仓 blocker 实测——dispatch-contract.mjs 手拄 verdict_schema_version:'v2'，
// verdict-validate.mjs 早已只收 'v3'；契约完全不提 attempt 必填；hardening_coverage 的
// evidence 分支约束（covered 需路径:行号 / n_a 需最小长度）只在 validator 里强制，契约段
// 只字未提。三处都是「契约与 validator 各念各的经」同一形状的复发。以下测试锁住修法本体：
// schema_version/attempt_min/n_a 最小长度全部改从 schemas/review-verdict.schema.json 派生。
console.log('\n[R2-P1] 契约漂移修复回归（SC-R2-C1〜C6）');

const LIVE_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/review-verdict.schema.json', import.meta.url), 'utf8'));

t('[SC-R2-C1] verdict_schema_version 从 schema 常量派生，不是手拄字面值（v2→v3 漂移的直接复现）', () => {
  const expected = LIVE_SCHEMA.properties.schema_version.const;
  eq(expected, 'v3', '当前 schema 的 schema_version.const 应为 v3（回归锚点）');
  eq(contractSpec({ seat: SEAT, round: ROUND }).verdict_schema_version, expected,
    'contractSpec.verdict_schema_version 必须等于 review-verdict.schema.json 的 schema_version.const');
  const text = emitContract({ seat: SEAT, round: ROUND });
  ok(text.includes('schema_version: "v3"'), 'emit 输出必须逐字含 schema_version: "v3"');
  ok(!text.includes('schema_version: "v2"'), 'emit 输出不得残留 schema_version: "v2"');
});

t('[SC-R2-C2] 契约要求顶层 attempt: emit 含该字面值，requiredLiterals 收录，缺失时 check 必拦', () => {
  const text = emitContract({ seat: SEAT, round: ROUND });
  ok(text.includes('attempt'), 'emit 输出必须提及 attempt 必填要求');
  const lits = requiredLiterals({ seat: SEAT, round: ROUND });
  ok(lits.includes('attempt'), 'requiredLiterals 必须收录 attempt');
  const mutated = text.split('attempt').join('（此处曾说明该字段必填要求，字面值被删）');
  ok(!mutated.includes('attempt'), '前置条件: 变异文本不得残留 attempt 字样（替换文案本身不能含目标字面值）');
  const r = checkDispatchPackage(mutated, { seat: SEAT, round: ROUND });
  ok(!r.ok, '缺 attempt 字面值的派工包必须被 check 拦下');
  ok(r.missing.includes('attempt'), `缺项清单必须点名 attempt，实际: ${JSON.stringify(r.missing)}`);
});

t('[SC-R2-C3] hardening_coverage 的 evidence 分支约束: covered 需路径:行号、n_a 需最小长度，对抗席必含、第三席不涉及', () => {
  const spec = contractSpec({ seat: SEAT, round: ROUND });
  ok(spec.hardening.required, '前置条件: claude-adversarial 应要求 hardening');
  const naMinLen = LIVE_SCHEMA.properties.hardening_coverage.items.allOf
    .find((c) => c?.if?.properties?.result?.const === 'n_a')?.then?.properties?.evidence?.minLength;
  eq(spec.hardening.na_evidence_min_length, naMinLen, 'contractSpec 的 na_evidence_min_length 必须等于 schema 里 n_a 分支的 evidence.minLength');
  const text = emitContract({ seat: SEAT, round: ROUND });
  ok(text.includes('路径:行号'), '对抗席契约必须提及 covered 分支的路径:行号要求');
  ok(text.includes(`${naMinLen} 字符`), '对抗席契约必须提及 n_a 分支的最小长度要求（从 schema 派生，不手拄数字）');
  const lits = requiredLiterals({ seat: SEAT, round: ROUND });
  ok(lits.includes('路径:行号'), 'requiredLiterals 必须收录路径:行号要求');
  ok(lits.includes(`${naMinLen} 字符`), 'requiredLiterals 必须收录最小长度要求');
  const thirdText = emitContract({ seat: 'upstream-preview', round: ROUND });
  ok(!thirdText.includes('路径:行号'), '第三席不强制加固清单穷举，不应出现该分支约束文案');
  const mutated = text.split('路径:行号').join('（此处曾说明 covered 分支格式要求，字面值被删）');
  const r = checkDispatchPackage(mutated, { seat: SEAT, round: ROUND });
  ok(!r.ok, '缺路径:行号字面值的派工包必须被 check 拦下');
  ok(r.missing.includes('路径:行号'), `缺项清单必须点名路径:行号，实际: ${JSON.stringify(r.missing)}`);
});

function buildMinimalVerdictFromContract({ seat, round, attempt = 1 }) {
  const spec = contractSpec({ seat, round });
  const sha = (n) => String(n).padStart(40, '0'); // 十进制数字字符集 ⊂ hex 字符集，满足 SHA_RE 形状
  const hash64 = 'a'.repeat(64); // 满足 HASH_RE 形状；本测试只测字段/形状，不重算真实 review_input_hash
  const faces = spec.required_faces.map((face) => ({
    face, result: 'pass', evidence: `${face} 面无问题（SC-R2-C4 端到端测试构造）`
  }));
  const gate_checks = spec.required_gate_ids.map((gate_id) => ({
    gate_id, result: 'pass', evidence: `${gate_id} 通过（SC-R2-C4 端到端测试构造）`
  }));
  const v = {
    schema_version: spec.verdict_schema_version,
    reviewer: seat,
    run_status: 'ok',
    round,
    attempt,
    base_sha: sha(1),
    candidate_sha: sha(2),
    review_input_hash: hash64,
    verdict: 'APPROVED',
    closed_finding_ids: [],
    faces,
    findings: [],
    gate_checks
  };
  if (spec.hardening.required) {
    v.checklist_version = spec.hardening.checklist_version;
    v.hardening_coverage = Array.from({ length: spec.hardening.class_count }, (_, i) => ({
      class_id: i + 1,
      result: 'covered',
      evidence: `scripts/dispatch-contract.mjs:${i + 1}（SC-R2-C4 端到端测试构造的覆盖证据）`
    }));
  }
  return v;
}

t('[SC-R2-C4] emit→validator 端到端(正向): 按契约构造的 verdict 必过真实 validateVerdict（三席 × round 1/2）', () => {
  for (const seat of SEATS) {
    for (const round of [1, 2]) {
      const v = buildMinimalVerdictFromContract({ seat, round });
      const errs = validateVerdict(v);
      eq(errs, [], `seat=${seat} round=${round} 按契约构造的 verdict 应零错误通过 validateVerdict，实际: ${JSON.stringify(errs)}`);
    }
  }
});

t('[SC-R2-C4] emit→validator 端到端(反向变异): 把 schema_version 改回 v2 → validateVerdict 必红（证明本门真能抓到本轮的漂移形状，不是自洽假绿）', () => {
  const v = buildMinimalVerdictFromContract({ seat: 'claude-adversarial', round: 1 });
  eq(validateVerdict(v), [], '前置条件: 变异前必须先零错误通过');
  const mutated = { ...v, schema_version: 'v2' };
  const errs = validateVerdict(mutated);
  ok(errs.length > 0, '变异后 validateVerdict 必须报错');
  ok(errs.some((e) => /schema_version/.test(e)), `报错必须点名 schema_version，实际: ${JSON.stringify(errs)}`);
});

t('[SC-R2-C5] SKILL.md 已同步声明 verdict schema **v3**（不再声明 v2）', () => {
  const skill = readFileSync(new URL('../skills/submit-pr/SKILL.md', import.meta.url), 'utf8');
  ok(skill.includes('review-verdict.schema.json` **v3**'), 'SKILL 必须声明 verdict schema **v3**');
  ok(!skill.includes('review-verdict.schema.json` **v2**'), 'SKILL 不得残留 verdict schema **v2** 的声明');
});

t('[SC-R2-C5] SKILL.md 已清除「三席 round 不一致按最大值判」与「round 1 带 parent 仍不拦」的旧语义', () => {
  const skill = readFileSync(new URL('../skills/submit-pr/SKILL.md', import.meta.url), 'utf8');
  ok(!skill.includes('按最大值判'), 'SKILL 不得残留 round 不一致时按最大值判的旧语义');
  ok(!skill.includes('反方向'), 'SKILL 不得残留「round 1 带 parent 仍不拦」段落的引导语');
  ok(/不再\s*静默取最大值/.test(skill), 'SKILL 必须换成新语义描述（round 不一致直接 fail-closed，不取最大值）');
});

t('[SC-R2-C6] review-verdict.schema.json 的 invariant description 已同步 validator 实际行为（按 severity 全 reviewer/全 round，不再声称限 round===1 或限两对抗席）', () => {
  const desc = LIVE_SCHEMA.properties.findings.items.properties.invariant.description;
  ok(!/round\s*===\s*1/.test(desc), 'invariant description 不得残留 round===1 的过期限定');
  ok(!/两对抗席/.test(desc), 'invariant description 不得残留仅两对抗席强制的过期限定（validator 对全部 reviewer 按 severity 强制）');
});

console.log(`\n========== i9-docs fixtures: ${pass} passed, ${failCount} failed ==========`);
if (failCount) {
  console.log('failed: ' + failures.join(' | '));
  process.exit(1);
}
