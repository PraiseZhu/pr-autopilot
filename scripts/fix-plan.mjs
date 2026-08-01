#!/usr/bin/env node
// 修复分组/波次规划器 — 纯函数，lead 无输入位（审 R1-P1-4: 分组不容裁量）。
// 输入: consensus artifact + sc manifest（+ capacity）。输出确定性 → fix_plan_hash 可重算验证。
//
// 规则（docs/plan/fix-orchestration-gate.md §3）:
//   1. 每条 fix-SC 的文件域 = 其 finding_ids 对应 canonical findings 的 anchor_paths 并集（机器派生）
//   2. 冲突图: 文件域相交的 fix-SC → union-find 同组（组内串行由单 worker 承担）
//   3. verify-wave: kind=verify 的 SC 全进最后一波（base=前波集成 tip）；
//      verify 的 anchor_paths 必须全命中测试路径模式，否则 fail-closed（防用 verify 位藏实改）
//   4. global SC 不进波次（lead 中央验证步）
//   5. 任何 fix/verify SC 引用的 finding 缺 anchor_paths → degraded，不产出可派工 plan
//
// 单调性: 冲突边由脚本连成，lead 不可拆（拆=切冲突边=并发改同文件）也不可合并独立组。
import { readJson, parseArgs, fail, isMain, hashObject, canonicalJson } from './lib/common.mjs';

const TEST_PATH_RE = /(^|\/)(e2e|fixtures)\/|\.(test|spec)\.[a-z]+$/i;

export function buildFixPlan({ artifact, manifest, capacity = 8 }) {
  const findingById = new Map((artifact.canonical_findings ?? []).map((f) => [f.id, f]));
  const scs = manifest.scs ?? [];
  const degraded = [];

  // SC → 文件域（机器派生）
  const fixScs = [];
  const verifyScs = [];
  for (const sc of scs) {
    if (sc.kind === 'global') continue;
    const paths = new Set();
    for (const fid of sc.finding_ids ?? []) {
      const f = findingById.get(fid);
      if (!f) { degraded.push(`SC ${sc.id} 引用未知 finding ${fid}`); continue; }
      if (!Array.isArray(f.anchor_paths) || f.anchor_paths.length === 0) {
        degraded.push(`SC ${sc.id} 的 finding ${fid} 缺 anchor_paths`);
        continue;
      }
      for (const p of f.anchor_paths) paths.add(p);
    }
    if (paths.size === 0) degraded.push(`SC ${sc.id} 无有效文件域（无法分组）`);
    const rec = { sc_id: sc.id, paths: [...paths].sort() };
    if (sc.kind === 'verify') {
      const bad = rec.paths.filter((p) => !TEST_PATH_RE.test(p));
      if (bad.length) degraded.push(`verify SC ${sc.id} 的路径不像测试文件: ${bad.join(',')}（防用 verify 位藏实改）`);
      verifyScs.push(rec);
    } else {
      fixScs.push(rec);
    }
  }

  if (degraded.length) return { degraded: true, reasons: degraded };

  // 冲突图 union-find（仅 fix-SC；文件域相交 → 同组）
  const parent = new Map(fixScs.map((s) => [s.sc_id, s.sc_id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let i = 0; i < fixScs.length; i++) {
    for (let j = i + 1; j < fixScs.length; j++) {
      const A = new Set(fixScs[i].paths);
      if (fixScs[j].paths.some((p) => A.has(p))) unite(fixScs[i].sc_id, fixScs[j].sc_id);
    }
  }
  // 收组
  const byRoot = new Map();
  for (const s of fixScs) {
    const r = find(s.sc_id);
    if (!byRoot.has(r)) byRoot.set(r, { sc_ids: [], paths: new Set() });
    const g = byRoot.get(r);
    g.sc_ids.push(s.sc_id);
    for (const p of s.paths) g.paths.add(p);
  }
  // 确定性: 组内 sc_ids 字典序，组按最小 sc_id 排序，赋 g1..gN
  const fixGroups = [...byRoot.values()]
    .map((g) => ({ sc_ids: g.sc_ids.sort(), paths: [...g.paths].sort() }))
    .sort((a, b) => a.sc_ids[0].localeCompare(b.sc_ids[0]))
    .map((g, i) => ({ id: `g${i + 1}`, ...g }));

  // verify 组: 全部 verify-SC 合成一组进最后一波（它们跑测试，天然可共存于集成 tip）
  const groups = [...fixGroups];
  const waves = [];
  if (fixGroups.length) waves.push(fixGroups.map((g) => g.id));
  if (verifyScs.length) {
    const vg = { id: `v${fixGroups.length + 1}`, sc_ids: verifyScs.map((s) => s.sc_id).sort(), paths: [...new Set(verifyScs.flatMap((s) => s.paths))].sort(), verify: true };
    groups.push(vg);
    waves.push([vg.id]);
  }

  const plan = {
    schema_version: 'v1',
    consensus_artifact_hash: artifact.consensus_artifact_hash,
    capacity,
    groups,
    waves,
    n_min_per_wave: waves.map((w) => Math.min(w.length, capacity))
  };
  plan.fix_plan_hash = computeFixPlanHash(plan);
  return { degraded: false, plan };
}

// 重算等价（审 R1-P1-3: plan 是纯函数，push-guard 自己重跑比对，非自报）
export function computeFixPlanHash(plan) {
  return hashObject({
    v: 'fix-plan/v1',
    consensus_artifact_hash: plan.consensus_artifact_hash,
    capacity: plan.capacity,
    groups: plan.groups,
    waves: plan.waves
  });
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.artifact || !args.manifest) {
    fail('用法: fix-plan.mjs --artifact <consensus.json> --manifest <sc-manifest.json> [--capacity 8] [--out plan.json]');
  }
  const r = buildFixPlan({
    artifact: readJson(args.artifact), manifest: readJson(args.manifest),
    capacity: Number(args.capacity ?? 8)
  });
  if (r.degraded) {
    for (const m of r.reasons) process.stderr.write(`[FIX-PLAN-DEGRADED] ${m}\n`);
    process.exit(1);
  }
  if (args.out) { const { writeJsonAtomic } = await import('./lib/common.mjs'); writeJsonAtomic(args.out, r.plan); }
  process.stdout.write(JSON.stringify(r.plan, null, 2) + '\n');
}
