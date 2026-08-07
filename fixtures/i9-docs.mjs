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

console.log(`\n========== i9-docs fixtures: ${pass} passed, ${failCount} failed ==========`);
if (failCount) {
  console.log('failed: ' + failures.join(' | '));
  process.exit(1);
}
