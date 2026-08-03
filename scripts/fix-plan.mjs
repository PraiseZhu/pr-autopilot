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
//   6. archive-wave（R10-A1/A2）: kind=archive 的 SC 文件域固定为 ARCHIVE_PATH（README.md，
//      不从 anchor_paths 派生），与 verify SC 同进最后一波（互不相交，并行）；
//      hub 门（fix/verify/archive 三池同判据）按 D1「可移除性」判定——archive 池天然
//      全落在同一路径、移除后余集为空 = 真同文件耦合而放行，不需要单独豁免
//
// 单调性: 冲突边由脚本连成，lead 不可拆（拆=切冲突边=并发改同文件）也不可合并独立组。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, parseArgs, fail, isMain, hashObject, canonicalJson } from './lib/common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_PATH_RE = /(^|\/)(e2e|fixtures)\/|\.(test|spec)\.[a-z]+$/i;
// R10-A1: archive SC 的文件域固定值——不从 anchor_paths 派生（那是 finding 本体的锚点，
// 不是本次要改的文件）。SKILL.md「ARCHIVE 类的收口」机器契约的唯一落点。
const ARCHIVE_PATH = 'README.md';

// SC-6（R2-P1-3）: capacity 的**唯一可信来源**是宪法层配置文件，planner 与 push-guard
// 各自独立读取——旧实现 `Number(args.capacity ?? 8)` 是 lead 自报，填 1 就能合法全串行。
export function trustedCapacity({ configPath = join(HERE, '../config/orchestration.json') } = {}) {
  const cfg = readJson(configPath);
  const n = cfg.max_parallel_workers;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`config/orchestration.json 的 max_parallel_workers 非法（${n}）——必须是 ≥1 整数（fail-closed）`);
  }
  return n;
}

// SC-R3-5②: hub 路径占比上限（同为宪法层配置）。R3 实证: 8 条 finding 各带一个共享
// tracked 文件（如 .gitignore）即可把 8 个独立 SC 合成 1 组 = 合法全串行。
export function trustedHubShare({ configPath = join(HERE, '../config/orchestration.json') } = {}) {
  const cfg = readJson(configPath);
  const s = cfg.hub_path_max_share;
  if (typeof s !== 'number' || !(s > 0 && s <= 1)) {
    throw new Error(`config/orchestration.json 的 hub_path_max_share 非法（${s}）——必须是 (0,1] 数值（fail-closed）`);
  }
  return s;
}

// hub 门: 某路径出现在 ≥3 条 且 > share 比例的 SC 域中 → degraded（要求 origin 席拆分
// finding 或把「影响范围」移 scope_note）。≥3 的下限保住合法的两两冲突不被误杀。
//
// D1（owner 2026-08-02，复核 mivo-canvas #419 死锁实测）: 判据换成「可移除性」——
// 占比高不等于污染，真正的特征是那条共享路径**冗余**：把它从各 SC 域里删掉，各 SC
// 仍各自有自己的路径，才是「广域锚点」误报。若某条 SC 的**唯一**锚点就是该共享路径，
// 那是真同文件耦合（本就该串行），不是污染——旧判据（纯占比）在单文件 PR（3 条
// blocker/major 全锚同 1 文件）上会误判 degraded，而 coverage-gate 要求每条恰好 1 条
// SC 覆盖、无法合并/无第二文件可拆锚点，push 永远过不去（死锁，非理论风险）。
export function hubViolations(items, share, label) {
  const freq = new Map();
  for (const s of items) for (const p of new Set(s.paths)) freq.set(p, (freq.get(p) ?? 0) + 1);
  const out = [];
  for (const [p, n] of freq) {
    if (!(n >= 3 && n > items.length * share)) continue;
    const holders = items.filter((s) => s.paths.includes(p));
    const allRemovable = holders.every((s) => s.paths.filter((x) => x !== p).length > 0);
    if (!allRemovable) continue;          // 真耦合放行，不是 hub 污染
    out.push(`${label} hub 路径 ${p} 出现在 ${n}/${items.length} 条 SC 域中（> hub_path_max_share=${share}）——广域锚点会把可并行修复串行化，请 origin 席拆分 finding 或移 scope_note（SC-R3-5）`);
  }
  return out.sort();
}

// 文件域相交 → union-find 同组。确定性: 组内 sc_ids 字典序、组按最小 sc_id 排序。
export function groupByConflict(items) {
  const parent = new Map(items.map((s) => [s.sc_id, s.sc_id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = new Set(items[i].paths);
      if (items[j].paths.some((p) => A.has(p))) unite(items[i].sc_id, items[j].sc_id);
    }
  }
  const byRoot = new Map();
  for (const s of items) {
    const r = find(s.sc_id);
    if (!byRoot.has(r)) byRoot.set(r, { sc_ids: [], paths: new Set() });
    const g = byRoot.get(r);
    g.sc_ids.push(s.sc_id);
    for (const p of s.paths) g.paths.add(p);
  }
  return [...byRoot.values()]
    .map((g) => ({ sc_ids: g.sc_ids.sort(), paths: [...g.paths].sort() }))
    .sort((a, b) => a.sc_ids[0].localeCompare(b.sc_ids[0]));
}

export function buildFixPlan({ artifact, manifest, capacity = null, hubShare = null, configPath = undefined }) {
  // capacity/hubShare 参数只允许 fixture 注入；生产路径一律从可信配置读
  const cap = capacity ?? trustedCapacity(configPath ? { configPath } : {});
  const hub = hubShare ?? trustedHubShare(configPath ? { configPath } : {});
  const findingById = new Map((artifact.canonical_findings ?? []).map((f) => [f.id, f]));
  const scs = manifest.scs ?? [];
  const degraded = [];

  // SC → 文件域（机器派生）
  const fixScs = [];
  const verifyScs = [];
  const archiveScs = [];
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
    if (sc.kind === 'archive') {
      // R10-A1: finding/anchor_paths 存在性校验（上面）照跑不豁免，但产出的文件域
      // 固定改写为 ARCHIVE_PATH——archive SC 改的是残余风险登记文档，不是 finding 本体锚点。
      archiveScs.push({ sc_id: sc.id, paths: [ARCHIVE_PATH] });
      continue;
    }
    const rec = { sc_id: sc.id, paths: [...paths].sort() };
    if (sc.kind === 'verify') {
      const bad = rec.paths.filter((p) => !TEST_PATH_RE.test(p));
      if (bad.length) degraded.push(`verify SC ${sc.id} 的路径不像测试文件: ${bad.join(',')}（防用 verify 位藏实改）`);
      verifyScs.push(rec);
    } else {
      fixScs.push(rec);
    }
  }

  // SC-R3-5②: hub 门（fix/verify/archive 三池均查，同一套 D1「可移除性」判据）。
  // D2（owner 2026-08-02）: 不再单独豁免 archive 池——多条 archive SC 天然全落在
  // ARCHIVE_PATH、移除该路径后各自余集为空，D1 判据本身就会把它判为真同文件耦合而放行；
  // 特例豁免分支会掩盖测试信号（通用判据被改回旧版时，被豁免的池子测不出来——加固清单
  // 第 8 类「特例短路掩盖断言」），删掉后 archive 池由通用判据保护，才有真信号。
  degraded.push(...hubViolations(fixScs, hub, 'fix'));
  degraded.push(...hubViolations(verifyScs, hub, 'verify'));
  degraded.push(...hubViolations(archiveScs, hub, 'archive'));

  if (degraded.length) return { degraded: true, reasons: degraded };

  // 冲突图分组（fix 与 verify 共用同一确定性算法——SC-7）
  const fixGroups = groupByConflict(fixScs).map((g, i) => ({ id: `g${i + 1}`, ...g }));

  // SC-7（R2-P1-6）: verify SC **也按冲突图分组**，末波内保持多组并行——
  // 旧实现把所有互不相交的 verify SC 合成一个 worker，直接违反 owner「该并行必须并行」。
  const groups = [...fixGroups];
  const waves = [];
  if (fixGroups.length) waves.push(fixGroups.map((g) => g.id));
  // R10-A1: archive 组进末波，与 verify 组并行（两者都只需看见前波产物，域互不相交，
  // 该并行必须并行）——同一个末波数组里既有 v* 也有 a*。
  const vGroups = verifyScs.length ? groupByConflict(verifyScs).map((g, i) => ({ id: `v${i + 1}`, ...g, verify: true })) : [];
  const aGroups = archiveScs.length ? groupByConflict(archiveScs).map((g, i) => ({ id: `a${i + 1}`, ...g, archive: true })) : [];
  groups.push(...vGroups, ...aGroups);
  const finalWave = [...vGroups, ...aGroups].map((g) => g.id);
  if (finalWave.length) waves.push(finalWave);

  const plan = {
    schema_version: 'v1',
    consensus_artifact_hash: artifact.consensus_artifact_hash,
    capacity: cap,
    groups,
    waves,
    n_min_per_wave: waves.map((w) => Math.min(w.length, cap))
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
    fail('用法: fix-plan.mjs --artifact <consensus.json> --manifest <sc-manifest.json> [--out plan.json]\n（capacity 来自 config/orchestration.json，SC-6: 不接受 CLI 自报）');
  }
  const r = buildFixPlan({
    artifact: readJson(args.artifact), manifest: readJson(args.manifest)
  });
  if (r.degraded) {
    for (const m of r.reasons) process.stderr.write(`[FIX-PLAN-DEGRADED] ${m}\n`);
    process.exit(1);
  }
  if (args.out) { const { writeJsonAtomic } = await import('./lib/common.mjs'); writeJsonAtomic(args.out, r.plan); }
  process.stdout.write(JSON.stringify(r.plan, null, 2) + '\n');
}
