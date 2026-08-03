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

// hub 检测: 某路径出现在 ≥3 条 且 > share 比例的 SC 域中。≥3 的下限保住合法的两两冲突。
//
// D2（2026-08-02，跨会话第二次死锁实测后重定，**取代 D1 的"阻断"后果，保留其检测**）:
// 本函数的产出**不再进 degraded**（不再阻断产出 plan），改为落进 plan 的
// `parallelism_notes`。根本理由是一句话:**并行度不是正确性属性。**
// hub 条件度量的是"这批修复能不能并行"，而"不能并行"是关于工作本身的事实，不是计划的缺陷。
// 13 条缺陷真的都长在同一个模块里时，正确的计划就是「一组、串行」，不是「没有计划」。
// 拿性能指标做 fail-closed 阻断是范畴错误——代价是完全交付不了，收益只是"跑得快一点"。
//
// 更硬的一条: 机器**分辨不出**「合法同模块耦合」与「锚点污染」——两者产出的 path 集合
// 完全一样，区别只在语义（这 10 条缺陷是不是真的在 gate.mjs 里）。既然分辨不出，
// 就不该由机器下阻断判决；它该做的是把事实**记下来并且删不掉**（notes 进 plan hash，
// push-guard 重算时对不上就断），由人看一眼。这与本仓 ARCHIVE 类「文档化接受」终止
// 循环是同一个立场: fail loud, 不是 fail stuck。
//
// D1（owner 2026-08-02，复核 mivo-canvas #419 死锁）曾把判据从纯占比换成「可移除性」，
// 但那仍是代理指标: 「某条 SC 除该路径外还有别的路径」不等于「该路径对它是多余的」。
// mivo-canvas 第二次死锁就撞在这里——10 条缺陷真在 gate.mjs 里，每条同时也真的碰
// gate.test.mjs，`allRemovable` 因此为真而被判成污染。D1 治了「单文件」，没治「单模块多文件」。
//
// 另: 提案方建议把判据改成逐路径的「移除后分组数是否增加」(after > before)。**不采纳**——
// 它在**冗余连接对**上 fail-open，而 source+test 成对出现正是最常见的形状（也正是提案方
// 自己那个案例）。实测反例: 4 条 SC 各含 [a.mjs, a.test.mjs, xN.mjs]，真实可并行度 4;
// 逐路径探测「移除 a.mjs → 1 组不变」「移除 a.test.mjs → 1 组不变」两条都放行，门完全静默，
// 而两条同时移除得 4 组——4× 的并行度损失被判成"不存在"。见 fixtures 的 [D2-冗余连接对] 一条。
// 但提案方"度量你宣称的那个量"的方法论是对的，已采纳进**报文**: notes 里给出**联合**度量
// （把所有命中路径一起移除，分组数从 X 变 Y），比占比更接近真实损失。
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
  const hits = [];
  for (const [p, n] of freq) {
    if (!(n >= 3 && n > items.length * share)) continue;
    const holders = items.filter((s) => s.paths.includes(p));
    const allRemovable = holders.every((s) => s.paths.filter((x) => x !== p).length > 0);
    if (!allRemovable) continue;          // 真耦合放行，不是 hub 污染
    hits.push(p);
  }
  if (!hits.length) return [];
  // 联合度量: 把**所有**命中路径一起移除后分组数会变成多少——这才是「串行化损失」本身。
  // 逐路径度量在冗余连接对上恒为 0（见上方 D2 说明），联合度量才看得见真实损失。
  const before = groupByConflict(items).length;
  const after = groupCountIgnoring(items, new Set(hits));
  const loss = after > before ? `若这些路径不在各 SC 域中，分组数会从 ${before} 增到 ${after}（并行度损失 ${after - before} 组）` : `即便这些路径都不在各 SC 域中，分组数仍为 ${before}——这些路径不是分组数的成因`;
  return hits.sort().map((p) => {
    const n = freq.get(p);
    return `${label} hub 路径 ${p} 出现在 ${n}/${items.length} 条 SC 域中（> hub_path_max_share=${share}）。${loss}。这是**记录，不阻断**（D2: 并行度不是正确性属性；机器分辨不出合法同模块耦合与锚点污染）——若确属锚点写宽了，请 origin 席拆分 finding 或移 scope_note（SC-R3-5）`;
  });
}

// D2 联合度量用: 忽略给定路径集后的分组数。余集为空的 SC 各算独立一组（它不再与任何人
// 冲突 = 可自由并行），**不能丢弃**——丢弃会低估分组数，把损失算小。
export function groupCountIgnoring(items, ignore) {
  const reduced = items.map((s) => ({ ...s, paths: s.paths.filter((x) => !ignore.has(x)) }));
  const nonEmpty = reduced.filter((s) => s.paths.length > 0);
  const emptyCount = reduced.length - nonEmpty.length;
  return (nonEmpty.length ? groupByConflict(nonEmpty).length : 0) + emptyCount;
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
  // D2: hub 命中不再阻断，落进 plan 的 parallelism_notes（进 plan hash，删不掉）
  const hubNotes = [
    ...hubViolations(fixScs, hub, 'fix'),
    ...hubViolations(verifyScs, hub, 'verify'),
    ...hubViolations(archiveScs, hub, 'archive'),
  ].sort();

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
    n_min_per_wave: waves.map((w) => Math.min(w.length, cap)),
    // D2: hub 事实随 plan 落账并进 fix_plan_hash——lead 不能把它删掉当没看见
    // （push-guard 从源 artifact 重算 plan 并比 hash，删了就对不上，SC-R3-2）。
    // 无命中时是空数组，不是 undefined——形状稳定，hash 才确定。
    parallelism_notes: hubNotes
  };
  plan.fix_plan_hash = computeFixPlanHash(plan);
  return { degraded: false, plan };
}

// 重算等价（审 R1-P1-3: plan 是纯函数，push-guard 自己重跑比对，非自报）
// D2: `v` 从 v1 升到 v2,因为 hash 覆盖面变了(新增 parallelism_notes)。按本仓既有约定
// (对齐 `ik1-`/`fk1-` 前缀的做法): 算法改动就换版本号,让新旧 hash 在数据里可区分,
// 绝不静默改变同名函数的输出——否则两份形状不同的 plan 会被误认成同一个。
// 代价如实说: 升版后**旧 run manifest 绑定的 fix_plan_hash 全部失效**,进行中的 run 需重开。
// 本仓尚无生产数据,这个代价现在付最便宜;不升版才是把「不兼容」伪装成「兼容」。
// parallelism_notes 必须入 hash: 否则 lead 可以把 hub 事实从 plan 里删掉当没看见,
// 而 push-guard 正是靠「从源 artifact 重算 plan 并比 hash」来发现这种摘除(SC-R3-2)。
export function computeFixPlanHash(plan) {
  return hashObject({
    v: 'fix-plan/v2',
    consensus_artifact_hash: plan.consensus_artifact_hash,
    capacity: plan.capacity,
    groups: plan.groups,
    waves: plan.waves,
    parallelism_notes: plan.parallelism_notes ?? []
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
