#!/usr/bin/env node
// 归因六件套校验 — issue #9 SC 延伸（批次事务协议，i9-batch Task 4）。
// 触发：batch-closure-gate 判据④检出「冻结集 family_key 在终版共识中再次出现」（同族复发）时，
// lead 在下一个修复 commit 前必须产出本归因六件套（与既有 references/convergence-checkpoint.md
// 的「原子六件套」是两套不同载体：那套是设计方法论式（不变量/状态 owner/矩阵/对称审计/判据
// 归一/交错测试，走 checkpoint.json + PR body marker），本套是归因诊断式（上次修了什么/为什么
// 又出现/SC 为什么没拦住/修错还是族归错/根因还是症状/根因在哪+issue）——职责不同，载体独立，
// 命名不共用，避免同名撞车）。
// 六项（lead 派工包 Task 4 原样）：
//   ① 上次修的是什么          prev_fix
//   ② 这次为什么又出现        why_recurred
//   ③ 上次的 SC 为什么没拦住   why_sc_missed
//   ④ 是修错了还是族归错了    fix_or_family_misclassified
//   ⑤ 这次改的是根因还是症状  root_or_symptom
//   ⑥ 若仍是症状，明确指出根因在哪并开 issue  root_cause_and_issue
// 保证等级 T1（如实声明）：机器至多验六项非空 + family_key/batch_id 形状——六项内容是否
// 真的回答了问题、根因是否真的正确，机器无法判定（判同根因本质需要人的判断）；lead 声明的
// family_key 是否确实是「同族二次出现」也只验形状不验语义。不防伪造。
import { readJson, parseArgs, fail, isMain } from './lib/common.mjs';

// 六项键 → 人读标签（消息里点名缺项）
export const ATTRIBUTION_ITEMS = {
  prev_fix: '①上次修的是什么',
  why_recurred: '②这次为什么又出现',
  why_sc_missed: '③上次的 SC 为什么没拦住',
  fix_or_family_misclassified: '④是修错了还是族归错了',
  root_or_symptom: '⑤这次改的是根因还是症状',
  root_cause_and_issue: '⑥若仍是症状，明确指出根因在哪并开 issue'
};

export function checkAttribution({ attribution, runManifest, familyKey }) {
  const errs = [];
  const need = (c, m) => { if (!c) errs.push(m); };

  need(attribution && typeof attribution === 'object', '归因六件套不是对象');
  if (!attribution) return errs;
  need(/^fk1-[0-9a-f]{64}$/.test(String(attribution.family_key ?? '')),
    `attribution.family_key 非法: ${JSON.stringify(attribution.family_key)}（必须是 fk1- 派生的 64-hex key）`);
  if (familyKey && attribution.family_key !== familyKey) {
    errs.push(`attribution.family_key（${String(attribution.family_key).slice(0, 12)}…）≠ 触发复发的 family_key（${String(familyKey).slice(0, 12)}…）——六件套必须针对复发的那一族，不是任一族（i9-batch）`);
  }
  if (runManifest) {
    need(/^[A-Za-z0-9._-]+$/.test(String(attribution.batch_id ?? '')),
      `attribution.batch_id 非法: ${JSON.stringify(attribution.batch_id)}`);
    if (runManifest.batch) {
      need(attribution.batch_id === runManifest.batch.batch_id,
        `attribution.batch_id（${JSON.stringify(attribution.batch_id)}）≠ run manifest batch.batch_id（${JSON.stringify(runManifest.batch.batch_id)}）——六件套必须归属触发它的那个批次（i9-batch）`);
    }
  }

  // 六项非空（T1：只验非空，不验内容质量）
  const items = attribution.items ?? null;
  need(items && typeof items === 'object', 'attribution.items 缺失（六件套必须一次性全部产出，缺一不算——原子性同 convergence-checkpoint.md D1）');
  if (!items) return errs;
  for (const [key, label] of Object.entries(ATTRIBUTION_ITEMS)) {
    const v = items[key];
    need(typeof v === 'string' && v.trim().length > 0, `归因六件套缺项: ${label}（${key}）——六项必须全部非空（机器只验非空，内容质量属 T1 上限）`);
  }
  return errs;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.attribution) {
    fail('用法: convergence-attribution-gate.mjs --attribution <convergence-attribution.json> [--run-manifest <run.json>] [--family-key <fk1-...>]');
  }
  const errs = checkAttribution({
    attribution: readJson(args.attribution),
    runManifest: args['run-manifest'] ? readJson(args['run-manifest']) : null,
    familyKey: args['family-key'] ?? null
  });
  if (errs.length) {
    for (const e of errs) process.stderr.write(`[CONVERGENCE-ATTRIBUTION-FAIL] ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('CONVERGENCE-ATTRIBUTION-OK\n');
}
