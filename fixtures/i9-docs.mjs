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
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
import { validateVerdict, SCHEMA_VERSION } from '../scripts/verdict-validate.mjs';

// R2-P1 真相源变化测试的通用探针：本进程已经 import 过 dispatch-contract.mjs/verdict-validate.mjs，
// 它们模块顶层派生的常量（SCHEMA_VERSION 等）是「导入时那一刻」的快照，进程内再改磁盘文件不会让
// 已导入的绑定重新求值——所以"改真相源→两侧是否跟着变"这个问题，必须在**全新进程**里验证
// （新进程从磁盘重新读取，天然没有缓存问题），不能靠本进程内的 dynamic import 缓存规避。
// 探针脚本用绝对 file:// URL import 两个待测模块，避免脚本落盘位置影响相对路径解析。
const DC_URL = new URL('../scripts/dispatch-contract.mjs', import.meta.url).href;
const VV_URL = new URL('../scripts/verdict-validate.mjs', import.meta.url).href;
// script 必须是「顶层 import 语句 + try{...console.log(JSON.stringify(...))...}catch{...}」形态——
// import 语句语法上不能包在 try 里，只能放外面；子进程内部真报错（包括 mutation 导致 import 时
// 的派生 guard throw）都会被 catch 成 __probe_error__ 打成 JSON，而不是让 execFileSync 因非零
// 退出码抛出难辨认的异常。
function runProbe(script) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
  const parsed = JSON.parse(out.split('\n').filter(Boolean).pop());
  if (parsed && parsed.__probe_error__) {
    throw new Error(`探针子进程内部报错: ${parsed.__probe_error__}`);
  }
  return parsed;
}

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
  // 有意锚定历史版本（例外，非漏改）: 这条钉的是「v2→v3 迁移已完成」——如果将来 verdict
  // schema 再 bump（如 v4），本行必须由人显式更新（这是迁移事件的有意断点，不是可派生的值；
  // expected 本就来自同一 schema，派生会变成同义反复）。不要顺手改成 expected 或 SCHEMA_VERSION。
  eq(expected, 'v3', '当前 schema 的 schema_version.const 应为 v3（回归锚点，bump 时必须显式更新）');
  eq(contractSpec({ seat: SEAT, round: ROUND }).verdict_schema_version, expected,
    'contractSpec.verdict_schema_version 必须等于 review-verdict.schema.json 的 schema_version.const');
  const text = emitContract({ seat: SEAT, round: ROUND });
  // emit 输出的版本号从 expected（= schema const）派生，不手拄字面量——schema bump 时自动跟随
  ok(text.includes('schema_version: "' + expected + '"'), `emit 输出必须逐字含 schema_version: "${expected}"（从 schema const 派生）`);
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

// R2-P1（lead 实测发现的复发风险）: 上面 SC-R2-C1〜C4 只证明了"当前取值一致"，没证明"真相源
// 一变、两侧真的会一起变"——lead 实测把 schema.properties.schema_version.const 改成 v9，
// dispatch-contract 的派生值跟着变了，但 verdict-validate.mjs 的判等仍手拄 'v3' 没跟。这比修复前
// 的"两处手拄"更危险：两处手拄时真相源一变两边都不动，仍然彼此一致（虽然过期）；一处派生一处
// 手拄时真相源一变，一边动一边不动，自动产生新的不一致——形状与刚修的 blocker 完全相同。
// 以下三条测试真的去改磁盘上的真相源文件（schema.json / verdict-validate.mjs 源码），在全新子
// 进程里验证 dispatch-contract 与 verdict-validate 是否**都**跟着变，改完必还原（try/finally）。
t('[SC-R2-C7] 真相源变化(schema.properties.schema_version.const)→ dispatch-contract 与 verdict-validate 双侧同步跟着变', () => {
  const schemaPath = fileURLToPath(new URL('../schemas/review-verdict.schema.json', import.meta.url));
  const original = readFileSync(schemaPath, 'utf8');
  // 变异前的当前版本（模块级 LIVE_SCHEMA 在变异前读取）——「旧值」从真相源派生，不手拄字面量
  const originalVersion = LIVE_SCHEMA.properties.schema_version.const;
  try {
    const mutatedSchema = JSON.parse(original);
    mutatedSchema.properties.schema_version.const = 'v9-MUTATION-TEST';
    writeFileSync(schemaPath, JSON.stringify(mutatedSchema, null, 2) + '\n');
    const probe = `
import { contractSpec } from '${DC_URL}';
import { validateVerdict, SCHEMA_VERSION } from '${VV_URL}';
try {
  const spec = contractSpec({ seat: 'claude-adversarial', round: 1 });
  const base = { reviewer: 'claude-adversarial', run_status: 'ok', round: 1, attempt: 1,
    base_sha: '0'.repeat(40), candidate_sha: '1'.repeat(40), review_input_hash: 'a'.repeat(64),
    verdict: 'APPROVED', closed_finding_ids: [], findings: [], gate_checks: [],
    faces: ['A','B','C','D','E','F','G'].map((face) => ({ face, result: 'pass', evidence: 'e' })),
    checklist_version: ${HARDENING_CHECKLIST_VERSION},
    hardening_coverage: Array.from({ length: ${HARDENING_CLASS_COUNT} }, (_, i) => ({ class_id: i + 1, result: 'covered', evidence: 'scripts/x.mjs:' + (i + 1) }))
  };
  const vFollowing = { ...base, schema_version: spec.verdict_schema_version };
  const vStale = { ...base, schema_version: '${originalVersion}' };
  console.log(JSON.stringify({
    specVersion: spec.verdict_schema_version,
    followingErrs: validateVerdict(vFollowing),
    staleErrs: validateVerdict(vStale)
  }));
} catch (e) {
  console.log(JSON.stringify({ __probe_error__: String((e && e.stack) || e) }));
}
`;
    const { specVersion, followingErrs, staleErrs } = runProbe(probe);
    eq(specVersion, 'v9-MUTATION-TEST', 'dispatch-contract 的派生值必须跟着真相源变化（emit 侧）');
    eq(followingErrs, [], `按当前真相源构造的 verdict 必须零错误通过 validateVerdict（validator 侧必须同步跟着变）: ${JSON.stringify(followingErrs)}`);
    ok(staleErrs.some((e) => /schema_version/.test(e)), `仍用旧值 v3 的 verdict 必须被 validator 拒（证明判等真的跟着真相源走，不是巧合一致）: ${JSON.stringify(staleErrs)}`);
  } finally {
    writeFileSync(schemaPath, original);
  }
});

t('[SC-R2-C8] 真相源变化(attempt.minimum / hardening n_a evidence.minLength)→ dispatch-contract 与 verdict-validate 双侧同步跟着变', () => {
  const schemaPath = fileURLToPath(new URL('../schemas/review-verdict.schema.json', import.meta.url));
  const original = readFileSync(schemaPath, 'utf8');
  try {
    const mutatedSchema = JSON.parse(original);
    mutatedSchema.properties.attempt.minimum = 5;
    const naClause = mutatedSchema.properties.hardening_coverage.items.allOf.find((c) => c?.if?.properties?.result?.const === 'n_a');
    naClause.then.properties.evidence.minLength = 20;
    writeFileSync(schemaPath, JSON.stringify(mutatedSchema, null, 2) + '\n');
    const probe = `
import { contractSpec } from '${DC_URL}';
import { validateVerdict, SCHEMA_VERSION } from '${VV_URL}';
try {
  const spec = contractSpec({ seat: 'claude-adversarial', round: 1 });
  const faces = ['A','B','C','D','E','F','G'].map((face) => ({ face, result: 'pass', evidence: 'e' }));
  const mkHardening = (naEvidence) => Array.from({ length: ${HARDENING_CLASS_COUNT} }, (_, i) => i === 0
    ? { class_id: 1, result: 'n_a', evidence: naEvidence }
    : { class_id: i + 1, result: 'covered', evidence: 'scripts/x.mjs:' + (i + 1) });
  const naLen = spec.hardening.na_evidence_min_length;
  const base = { schema_version: spec.verdict_schema_version, reviewer: 'claude-adversarial', run_status: 'ok', round: 1,
    base_sha: '0'.repeat(40), candidate_sha: '1'.repeat(40), review_input_hash: 'a'.repeat(64),
    verdict: 'APPROVED', closed_finding_ids: [], findings: [], gate_checks: [], faces,
    checklist_version: ${HARDENING_CHECKLIST_VERSION}
  };
  const vAttemptFollowing = { ...base, attempt: spec.attempt_min, hardening_coverage: mkHardening('y'.repeat(naLen)) };
  const vAttemptBelowMin = { ...base, attempt: spec.attempt_min - 1, hardening_coverage: mkHardening('y'.repeat(naLen)) };
  const vNaFollowing = { ...base, attempt: spec.attempt_min, hardening_coverage: mkHardening('y'.repeat(naLen)) };
  const vNaBelowMin = { ...base, attempt: spec.attempt_min, hardening_coverage: mkHardening('y'.repeat(naLen - 1)) };
  console.log(JSON.stringify({
    attemptMin: spec.attempt_min,
    naMinLen: naLen,
    attemptFollowingErrs: validateVerdict(vAttemptFollowing),
    attemptBelowMinErrs: validateVerdict(vAttemptBelowMin),
    naFollowingErrs: validateVerdict(vNaFollowing),
    naBelowMinErrs: validateVerdict(vNaBelowMin)
  }));
} catch (e) {
  console.log(JSON.stringify({ __probe_error__: String((e && e.stack) || e) }));
}
`;
    const { attemptMin, naMinLen, attemptFollowingErrs, attemptBelowMinErrs, naFollowingErrs, naBelowMinErrs } = runProbe(probe);
    eq(attemptMin, 5, 'dispatch-contract 的 attempt_min 必须跟着真相源变化');
    eq(naMinLen, 20, 'dispatch-contract 的 na_evidence_min_length 必须跟着真相源变化');
    eq(attemptFollowingErrs, [], `attempt=新下限 的 verdict 必须零错误通过: ${JSON.stringify(attemptFollowingErrs)}`);
    ok(attemptBelowMinErrs.some((e) => /attempt 非法/.test(e)), `attempt=新下限-1 必须被拒（证明 validator 真的用了新下限，不是仍卡在旧值 1）: ${JSON.stringify(attemptBelowMinErrs)}`);
    eq(naFollowingErrs, [], `n_a evidence 长度=新最小长度 的 verdict 必须零错误通过: ${JSON.stringify(naFollowingErrs)}`);
    ok(naBelowMinErrs.some((e) => /过短/.test(e)), `n_a evidence 长度=新最小长度-1 必须被拒（证明 validator 真的用了新长度，不是仍卡在旧值 10）: ${JSON.stringify(naBelowMinErrs)}`);
  } finally {
    writeFileSync(schemaPath, original);
  }
});

t('[SC-R2-C9] 真相源变化(verdict-validate.mjs 的 REVIEWERS/ADVERSARIAL 名单)→ dispatch-contract 的 SEATS 与对抗席判断跟着变（不再各自手拄）', () => {
  const vvPath = fileURLToPath(new URL('../scripts/verdict-validate.mjs', import.meta.url));
  const original = readFileSync(vvPath, 'utf8');
  try {
    const reviewersLine = "export const REVIEWERS = ['claude-adversarial', 'codex-adversarial', 'upstream-preview'];";
    const adversarialLine = "export const ADVERSARIAL = ['claude-adversarial', 'codex-adversarial'];";
    ok(original.includes(reviewersLine), '前置条件: 源码须含预期的 REVIEWERS 声明（探针按此字符串定位变异点，源码格式变了要同步改这里）');
    ok(original.includes(adversarialLine), '前置条件: 源码须含预期的 ADVERSARIAL 声明');
    const mutated = original
      .split(reviewersLine).join("export const REVIEWERS = ['claude-adversarial', 'codex-adversarial', 'upstream-preview', 'r2c9-extra-seat'];")
      .split(adversarialLine).join("export const ADVERSARIAL = ['claude-adversarial', 'codex-adversarial', 'r2c9-extra-seat'];");
    writeFileSync(vvPath, mutated);
    const probe = `
import { SEATS, contractSpec } from '${DC_URL}';
import { REVIEWERS, ADVERSARIAL } from '${VV_URL}';
try {
  const spec = contractSpec({ seat: 'r2c9-extra-seat', round: 1 });
  console.log(JSON.stringify({ SEATS, REVIEWERS, ADVERSARIAL, extraSeatHardeningRequired: spec.hardening.required }));
} catch (e) {
  console.log(JSON.stringify({ __probe_error__: String((e && e.stack) || e) }));
}
`;
    const { SEATS: seatsOut, REVIEWERS: reviewersOut, ADVERSARIAL: adversarialOut, extraSeatHardeningRequired } = runProbe(probe);
    eq(reviewersOut, ['claude-adversarial', 'codex-adversarial', 'upstream-preview', 'r2c9-extra-seat'], '前置条件: verdict-validate.mjs 的 REVIEWERS 确实已变异');
    eq(adversarialOut, ['claude-adversarial', 'codex-adversarial', 'r2c9-extra-seat'], '前置条件: verdict-validate.mjs 的 ADVERSARIAL 确实已变异');
    eq(seatsOut, reviewersOut, 'dispatch-contract 的 SEATS 必须等于 verdict-validate.mjs 变异后的 REVIEWERS（不是自己另存一份，contractSpec 才能接受新席位而不 throw "seat 非法"）');
    eq(extraSeatHardeningRequired, true, 'dispatch-contract 的对抗席判断必须用 verdict-validate.mjs 变异后的 ADVERSARIAL——新席位被加入对抗席分类后，contractSpec 对它也要求 hardening_coverage，不是自己另存一份旧名单');
  } finally {
    writeFileSync(vvPath, original);
  }
});

// R2-P1 补漏（lead 复核发现：required_faces 那行早已如实标注"schema 可派生但未做"，是 lead
// 读表时漏看，不是刻意划界）：ALL_FACES/FACES 与 SEATS/REVIEWERS、ADVERSARIAL 是完全同一形状
// 的残留（verdict-validate.mjs 本地 FACES 未导出，dispatch-contract.mjs 独立手拄一份同值数组），
// 同一个病治一半比多花一轮更糟，按已验证过的镜像模式一并根治。
t('[SC-R2-C10] 真相源变化(verdict-validate.mjs 的 FACES 数组)→ dispatch-contract 的 ALL_FACES 与对抗席 required_faces 跟着变（不再各自手拄）', () => {
  const vvPath = fileURLToPath(new URL('../scripts/verdict-validate.mjs', import.meta.url));
  const original = readFileSync(vvPath, 'utf8');
  try {
    const facesLine = "export const FACES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];";
    ok(original.includes(facesLine), '前置条件: 源码须含预期的 FACES 声明（探针按此字符串定位变异点，源码格式变了要同步改这里）');
    const mutated = original.split(facesLine).join("export const FACES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'X-r2c10-sentinel'];");
    writeFileSync(vvPath, mutated);
    const probe = `
import { ALL_FACES, contractSpec } from '${DC_URL}';
import { FACES } from '${VV_URL}';
try {
  const spec = contractSpec({ seat: 'claude-adversarial', round: 1 });
  console.log(JSON.stringify({ ALL_FACES, FACES, requiredFaces: spec.required_faces }));
} catch (e) {
  console.log(JSON.stringify({ __probe_error__: String((e && e.stack) || e) }));
}
`;
    const { ALL_FACES: allFacesOut, FACES: facesOut, requiredFaces } = runProbe(probe);
    eq(facesOut, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'X-r2c10-sentinel'], '前置条件: verdict-validate.mjs 的 FACES 确实已变异');
    eq(allFacesOut, facesOut, 'dispatch-contract 的 ALL_FACES 必须等于 verdict-validate.mjs 变异后的 FACES（不是自己另存一份）');
    ok(requiredFaces.includes('X-r2c10-sentinel'), '对抗席的 required_faces 必须包含变异后新增的哨兵面（contractSpec 用的是活的 ALL_FACES，不是编译期定值的拷贝）');
  } finally {
    writeFileSync(vvPath, original);
  }
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

// ========== [R3-field] out_of_scope_channel 单一真相源 + additionalProperties:false 反向变异 ==========
// SC-R3-F5: 真相源变化(verdict-validate.mjs 的 OUT_OF_SCOPE_NOTES_FIELD)→ dispatch-contract 的
// out_of_scope_channel 跟着变（不再各自手拄）。手法同 [SC-R2-C9]/[SC-R2-C10]：物理改磁盘上的
// verdict-validate.mjs，全新子进程 import 观察，finally 里还原。
t('[SC-R3-F5] 真相源变化(verdict-validate.mjs 的 OUT_OF_SCOPE_NOTES_FIELD)→ dispatch-contract 的 out_of_scope_channel 跟着变（不再各自手拄）', () => {
  const vvPath = fileURLToPath(new URL('../scripts/verdict-validate.mjs', import.meta.url));
  const original = readFileSync(vvPath, 'utf8');
  try {
    const fieldLine = "export const OUT_OF_SCOPE_NOTES_FIELD = 'out_of_scope_notes';";
    ok(original.includes(fieldLine), '前置条件: 源码须含预期的 OUT_OF_SCOPE_NOTES_FIELD 声明（探针按此字符串定位变异点，源码格式变了要同步改这里）');
    const mutated = original.split(fieldLine).join("export const OUT_OF_SCOPE_NOTES_FIELD = 'r3f5_mutated_channel';");
    writeFileSync(vvPath, mutated);
    const probe = `
import { contractSpec } from '${DC_URL}';
import { OUT_OF_SCOPE_NOTES_FIELD } from '${VV_URL}';
try {
  const spec = contractSpec({ seat: 'claude-adversarial', round: 1 });
  console.log(JSON.stringify({ OUT_OF_SCOPE_NOTES_FIELD, outOfScopeChannel: spec.out_of_scope_channel }));
} catch (e) {
  console.log(JSON.stringify({ __probe_error__: String((e && e.stack) || e) }));
}
`;
    const { OUT_OF_SCOPE_NOTES_FIELD: fieldOut, outOfScopeChannel } = runProbe(probe);
    eq(fieldOut, 'r3f5_mutated_channel', '前置条件: verdict-validate.mjs 的 OUT_OF_SCOPE_NOTES_FIELD 确实已变异');
    eq(outOfScopeChannel, 'r3f5_mutated_channel', 'dispatch-contract 的 out_of_scope_channel 必须等于变异后的 OUT_OF_SCOPE_NOTES_FIELD（不是自己另存一份手拄字面值）');
  } finally {
    writeFileSync(vvPath, original);
  }
});

t('[SC-R3-F5-reverse] 反向变异: dispatch-contract.mjs 的 out_of_scope_channel 改回手拄字面值 → 与真相源变化不再同步', () => {
  const dcPath = fileURLToPath(new URL('../scripts/dispatch-contract.mjs', import.meta.url));
  const vvPath = fileURLToPath(new URL('../scripts/verdict-validate.mjs', import.meta.url));
  const dcOriginal = readFileSync(dcPath, 'utf8');
  const vvOriginal = readFileSync(vvPath, 'utf8');
  try {
    const dcLine = 'out_of_scope_channel: OUT_OF_SCOPE_NOTES_FIELD';
    ok(dcOriginal.includes(dcLine), '前置条件: dispatch-contract.mjs 须仍从 import 的常量读取（探针按此字符串定位变异点）');
    const dcMutated = dcOriginal.split(dcLine).join("out_of_scope_channel: 'out_of_scope_notes'");
    writeFileSync(dcPath, dcMutated);
    const fieldLine = "export const OUT_OF_SCOPE_NOTES_FIELD = 'out_of_scope_notes';";
    const vvMutated = vvOriginal.split(fieldLine).join("export const OUT_OF_SCOPE_NOTES_FIELD = 'r3f5rev_mutated_channel';");
    writeFileSync(vvPath, vvMutated);
    const probe = `
import { contractSpec } from '${DC_URL}';
import { OUT_OF_SCOPE_NOTES_FIELD } from '${VV_URL}';
try {
  const spec = contractSpec({ seat: 'claude-adversarial', round: 1 });
  console.log(JSON.stringify({ OUT_OF_SCOPE_NOTES_FIELD, outOfScopeChannel: spec.out_of_scope_channel }));
} catch (e) {
  console.log(JSON.stringify({ __probe_error__: String((e && e.stack) || e) }));
}
`;
    const { OUT_OF_SCOPE_NOTES_FIELD: fieldOut, outOfScopeChannel } = runProbe(probe);
    eq(fieldOut, 'r3f5rev_mutated_channel', '前置条件: verdict-validate.mjs 的真相源确实已变异');
    ok(outOfScopeChannel !== fieldOut, '手拄字面值的 dispatch-contract 不会跟着真相源变化——证明 SC-R3-F5 的同步性确实来自 import，不是巧合');
    eq(outOfScopeChannel, 'out_of_scope_notes', '手拄版本停留在旧字面值');
  } finally {
    writeFileSync(dcPath, dcOriginal);
    writeFileSync(vvPath, vvOriginal);
  }
});

// SC-R3-F2/F6 反向变异: 去掉 verdict-validate.mjs 里新增的未知字段拒绝循环 → typo verdict 变回
// 静默通过（0 errors）——证明 SC-R3-F1/F2/F6-b 的通过真的挂在这段新代码上，不是别处偶然生效。
t('[SC-R3-F2-reverse] 反向变异: 去掉顶层未知字段检查循环 → out_of_scope_note(typo) 变回 0 errors 静默通过', () => {
  const vvPath = fileURLToPath(new URL('../scripts/verdict-validate.mjs', import.meta.url));
  const original = readFileSync(vvPath, 'utf8');
  try {
    const loopBlock = "  for (const k of Object.keys(v)) {\n    need(TOP_LEVEL_KEYS.has(k), `verdict 存在未知顶层字段: ${k}（additionalProperties:false，见 schemas/review-verdict.schema.json）`);\n  }\n";
    ok(original.includes(loopBlock), '前置条件: 源码须含预期的顶层未知字段检查循环（探针按此字符串定位变异点）');
    writeFileSync(vvPath, original.split(loopBlock).join(''));
    const probe = `
import { validateVerdict, SCHEMA_VERSION } from '${VV_URL}';
try {
  const HARDENING_CLASS_COUNT = ${HARDENING_CLASS_COUNT};
  const HARDENING_CHECKLIST_VERSION = ${HARDENING_CHECKLIST_VERSION};
  const FULL_FACES = ['A','B','C','D','E','F','G'].map((f) => ({ face: f, result: f === 'B' ? 'n_a' : 'pass', evidence: f + ' 面走查完成' }));
  const FULL_HARDENING = Array.from({ length: HARDENING_CLASS_COUNT }, (_, i) => ({ class_id: i + 1, result: 'covered', evidence: 'x.mjs:' + (i + 1) + ' 第' + (i + 1) + '类核对完成' }));
  const v = {
    schema_version: SCHEMA_VERSION, reviewer: 'claude-adversarial', run_status: 'ok', round: 1, attempt: 1,
    base_sha: 'a'.repeat(40), candidate_sha: 'b'.repeat(40), review_input_hash: 'e'.repeat(64),
    faces: FULL_FACES, findings: [], gate_checks: [], verdict: 'APPROVED', closed_finding_ids: [],
    hardening_coverage: FULL_HARDENING, checklist_version: HARDENING_CHECKLIST_VERSION,
    out_of_scope_note: [{ id: 'N1', note: 'x', evidence: 'e', suggested_issue_title: 't' }]
  };
  console.log(JSON.stringify({ errCount: validateVerdict(v).length }));
} catch (e) {
  console.log(JSON.stringify({ __probe_error__: String((e && e.stack) || e) }));
}
`;
    const { errCount } = runProbe(probe);
    eq(errCount, 0, '去掉检查循环后，typo 字段必须变回 0 errors（证明 SC-R3-F1/F2 的拒绝真的来自这段代码，不是巧合命中别的检查）');
  } finally {
    writeFileSync(vvPath, original);
  }
});

t('[SC-R3-F6-reverse] 反向变异: 去掉 finding 级未知字段检查循环 → write_path(typo) 变回 0 errors 静默通过', () => {
  const vvPath = fileURLToPath(new URL('../scripts/verdict-validate.mjs', import.meta.url));
  const original = readFileSync(vvPath, 'utf8');
  try {
    const loopBlock = "    for (const k of Object.keys(fd)) {\n      need(FINDING_KEYS.has(k), `finding ${fd.id ?? '?'} 存在未知字段: ${k}（findings additionalProperties:false，见 schemas/review-verdict.schema.json）`);\n    }\n";
    ok(original.includes(loopBlock), '前置条件: 源码须含预期的 finding 级未知字段检查循环（探针按此字符串定位变异点）');
    writeFileSync(vvPath, original.split(loopBlock).join(''));
    const probe = `
import { validateVerdict, SCHEMA_VERSION } from '${VV_URL}';
try {
  const HARDENING_CLASS_COUNT = ${HARDENING_CLASS_COUNT};
  const HARDENING_CHECKLIST_VERSION = ${HARDENING_CHECKLIST_VERSION};
  const FULL_FACES = ['A','B','C','D','E','F','G'].map((f) => ({ face: f, result: f === 'B' ? 'n_a' : 'pass', evidence: f + ' 面走查完成' }));
  const FULL_HARDENING = Array.from({ length: HARDENING_CLASS_COUNT }, (_, i) => ({ class_id: i + 1, result: 'covered', evidence: 'x.mjs:' + (i + 1) + ' 第' + (i + 1) + '类核对完成' }));
  const v = {
    schema_version: SCHEMA_VERSION, reviewer: 'claude-adversarial', run_status: 'ok', round: 1, attempt: 1,
    base_sha: 'a'.repeat(40), candidate_sha: 'b'.repeat(40), review_input_hash: 'e'.repeat(64),
    faces: FULL_FACES, gate_checks: [], verdict: 'APPROVED', closed_finding_ids: [],
    hardening_coverage: FULL_HARDENING, checklist_version: HARDENING_CHECKLIST_VERSION,
    findings: [{ id: 'F2', primary_face: 'A', severity: 'suggestion', anchor: 'a', anchor_paths: ['x'], evidence: 'e', status: 'open', write_path: ['src/x.ts'] }]
  };
  console.log(JSON.stringify({ errCount: validateVerdict(v).length }));
} catch (e) {
  console.log(JSON.stringify({ __probe_error__: String((e && e.stack) || e) }));
}
`;
    const { errCount } = runProbe(probe);
    eq(errCount, 0, '去掉检查循环后，write_path（typo）必须变回 0 errors（证明 SC-R3-F6-b 的拒绝真的来自这段新代码，不是 D2 专项检查碰巧顶上）');
  } finally {
    writeFileSync(vvPath, original);
  }
});

t('[版本字面量] 本文件 verdict 构造须用 SCHEMA_VERSION 派生，不得残留 verdict schema_version 字面量（照 [SC-12] 写法）', () => {
  // 2026-08-07: verdict schema 版本改从 verdict-validate.mjs 导出的 SCHEMA_VERSION 派生。
  // artifact schema 版本（B 类）等 batch-txn 的 ARTIFACT_SCHEMA_VERSION 落地再改；sc_manifest/
  // fix_plan 的 schema_version 是另一套协议，不在此列。例外: [SC-R2-C1] 的回归锚点 eq(expected,'v3')
  // 是有意锚定历史版本（迁移断点），已加注释，不在本自检范围。
  const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  ok(/schema_version: SCHEMA_VERSION, reviewer/.test(own), '本文件 verdict 构造必须用 SCHEMA_VERSION 派生常量');
  const lit = "schema_version: 'v" + "[0-9]', reviewer";
  ok(!new RegExp(lit).test(own), '本文件不得残留 verdict schema_version 字面量（须用 SCHEMA_VERSION 派生）');
});

console.log(`\n========== i9-docs fixtures: ${pass} passed, ${failCount} failed ==========`);
if (failCount) {
  console.log('failed: ' + failures.join(' | '));
  process.exit(1);
}
