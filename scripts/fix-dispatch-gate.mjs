#!/usr/bin/env node
// 派发数量门 — 计划: docs/plan/fix-orchestration-gate.md §4a
// owner 目标「该并行必须并行」的机器强制点: 计划说本波 N 组能并行，lead 就必须派出 N 个
// 不同 worker；只派 1 个串行吃完 = fail-closed 拦下（首跑那次的失败模式）。
//
// ⚠ 保证等级 T1（防疏忽/防漂移），如实声明、不冒充 T2:
//   dispatch record 由 lead 提交，本门验证的是「记录自身完备且与 plan 一致」。
//   恶意 lead 可编造 session id（同 UID 可写任何文件）——那需要宿主级签名回执，本仓做不到。
//   实测失败模式是「lead 老实但按惯性只派一个」，本门对此 100% 有效。
// 校验项（任一违 → 非零）:
//   ① record 绑定 plan: fix_plan_hash 必须等于 plan 重算值（换 plan 即失效）
//   ② 每波: 有派发记录的组 == plan 该波全部组（不多不少，无遗漏无幽灵）
//   ③ 每组恰好一条派发记录（防「一个 worker 挂两组」冒充并行）
//   ④ worker 标识互异（同一 session 不得充当两组）
//   ⑤ 每组必须有交卷材料（tip SHA + 交卷摘要）——空壳记录不算派发
//   ⑥ 批次: 组数 > capacity 时必须分批且每批 size <= capacity，各批组不重复
import { readJson, parseArgs, fail, isMain } from './lib/common.mjs';
import { computeFixPlanHash, trustedCapacity } from './fix-plan.mjs';

export function checkDispatch({ plan, record, capacity: capacityOverride = null, configPath = undefined }) {
  const errs = [];
  const need = (c, m) => { if (!c) errs.push(m); };

  need(plan && Array.isArray(plan.waves), 'plan 无 waves');
  need(record && typeof record === 'object', 'dispatch record 不是对象');
  if (errs.length) return errs;

  // ① 绑定 plan（重算，不信自报）
  const real = computeFixPlanHash(plan);
  need(plan.fix_plan_hash === real, 'plan 自身 fix_plan_hash 与内容重算不符（plan 被改）');
  need(record.fix_plan_hash === real,
    `dispatch record 的 fix_plan_hash 与 plan 重算值不符（record=${String(record.fix_plan_hash).slice(0, 12)} 实=${real.slice(0, 12)}）——记录未绑定本 plan`);

  // SC-6: capacity 独立从可信配置读并与 plan 声明比对——不信 plan/record 自报
  let capacity = capacityOverride;
  if (capacity === null) {
    try { capacity = trustedCapacity(configPath ? { configPath } : {}); }
    catch (e) { errs.push(`capacity 不可得（fail-closed）: ${e.message}`); return errs; }
  }
  need(plan.capacity === capacity,
    `plan.capacity=${plan.capacity} 与可信配置 ${capacity} 不符（SC-6: capacity 不得由 lead 自报，改并行上限只能 owner 改 config/orchestration.json）`);
  const waves = Array.isArray(record.waves) ? record.waves : [];
  need(waves.length === plan.waves.length, `record 波数 ${waves.length} ≠ plan 波数 ${plan.waves.length}`);

  const seenWorkers = new Set();
  for (let wi = 0; wi < plan.waves.length; wi++) {
    const planned = plan.waves[wi] ?? [];
    const rec = waves[wi] ?? {};
    const dispatches = Array.isArray(rec.dispatches) ? rec.dispatches : [];

    // ② 组集合完全一致
    const recGroups = dispatches.map((d) => d.group_id);
    const plannedSet = new Set(planned);
    const recSet = new Set(recGroups);
    for (const g of planned) {
      need(recSet.has(g), `wave${wi + 1}: 组 ${g} 无派发记录——计划要求并行 ${planned.length} 组，实际缺该组（该并行没并行，fail-closed）`);
    }
    for (const g of recSet) need(plannedSet.has(g), `wave${wi + 1}: 派发了 plan 之外的幽灵组 ${g}`);

    // ③ 每组恰好一条
    const counts = new Map();
    for (const g of recGroups) counts.set(g, (counts.get(g) ?? 0) + 1);
    for (const [g, n] of counts) need(n === 1, `wave${wi + 1}: 组 ${g} 有 ${n} 条派发记录（须恰好 1）`);

    // ④⑤ worker 互异 + 交卷材料
    for (const d of dispatches) {
      const wid = d.worker_session_id ?? d.worker_label;
      need(!!wid, `wave${wi + 1}: 组 ${d.group_id} 缺 worker 标识（worker_session_id/worker_label）`);
      if (wid) {
        need(!seenWorkers.has(wid), `worker ${wid} 被用于多个组（同一会话不得冒充并行）`);
        seenWorkers.add(wid);
      }
      need(/^[0-9a-f]{40}$/.test(String(d.tip ?? '')), `wave${wi + 1}: 组 ${d.group_id} 缺合法 tip SHA（交卷材料，空壳记录不算派发）`);
      // SC-10（R2-P1-6）: 交卷必须**结构化 PASS**——旧实现只要非空字符串，report='FAIL' 也过
      const res = d.result;
      need(res && typeof res === 'object', `wave${wi + 1}: 组 ${d.group_id} 缺结构化 result{status, sc_results[]}`);
      if (res && typeof res === 'object') {
        need(res.status === 'PASS', `wave${wi + 1}: 组 ${d.group_id} result.status=${res.status} ≠ PASS（失败交卷不算完工）`);
        const srs = Array.isArray(res.sc_results) ? res.sc_results : null;
        need(srs && srs.length > 0, `wave${wi + 1}: 组 ${d.group_id} 缺 sc_results[]`);
        if (srs) {
          const group = (plan.groups ?? []).find((x) => x.id === d.group_id);
          const wantScs = new Set(group?.sc_ids ?? []);
          const gotScs = new Set(srs.map((x) => x.sc_id));
          for (const sc of wantScs) need(gotScs.has(sc), `wave${wi + 1}: 组 ${d.group_id} 的 sc_results 缺 ${sc}`);
          for (const sr of srs) {
            need(sr.status === 'PASS', `wave${wi + 1}: 组 ${d.group_id} 的 ${sr.sc_id} status=${sr.status} ≠ PASS`);
            need(typeof sr.evidence === 'string' && sr.evidence.trim().length > 0, `wave${wi + 1}: ${sr.sc_id} 缺 evidence`);
          }
        }
      }
    }

    // ⑥ SC-6（R2-P1-3）: 批次必须是**确定性 canonical partition**——
    // 旧实现只查「每批 ≤ capacity」，singleton batches（capacity=1 或 [[g1],[g2],[g3]]）
    // 与幽灵 id 都能过 = 合法全串行。现要求: 集合 exact 相等、批数 exact、除末批外满载。
    const batches = Array.isArray(rec.batches) ? rec.batches : null;
    const expectBatches = Math.ceil(planned.length / capacity);
    if (planned.length > capacity) {
      need(batches, `wave${wi + 1}: ${planned.length} 组 > capacity ${capacity}，必须分批记录（batches）`);
    }
    if (batches) {
      const flat = batches.flat();
      need(flat.length === planned.length, `wave${wi + 1}: batches 覆盖 ${flat.length} 组 ≠ 计划 ${planned.length} 组`);
      need(new Set(flat).size === flat.length, `wave${wi + 1}: batches 有重复组`);
      for (const g of flat) need(plannedSet.has(g), `wave${wi + 1}: batches 含幽灵组 ${g}`);
      for (const g of planned) need(flat.includes(g), `wave${wi + 1}: batches 缺计划组 ${g}`);
      need(batches.length === expectBatches,
        `wave${wi + 1}: 批数 ${batches.length} ≠ ceil(${planned.length}/${capacity})=${expectBatches}（canonical partition：不得把可并行的组拆成更多批串行化）`);
      batches.forEach((b, bi) => {
        if (bi < batches.length - 1) {
          need(b.length === capacity, `wave${wi + 1} 第 ${bi + 1} 批 size=${b.length} ≠ capacity ${capacity}（非末批必须满载，否则等于降并行）`);
        } else {
          need(b.length >= 1 && b.length <= capacity, `wave${wi + 1} 末批 size=${b.length} 非法`);
        }
      });
    }
    // n_min_per_wave 消费（R2: 此前从未使用）——实际并行组数不得低于计划下界
    const nMin = Array.isArray(plan.n_min_per_wave) ? plan.n_min_per_wave[wi] : null;
    if (Number.isInteger(nMin)) {
      const firstBatch = batches ? batches[0].length : dispatches.length;
      need(firstBatch >= nMin, `wave${wi + 1}: 首批并行 ${firstBatch} 组 < 计划下界 n_min ${nMin}（该并行没并行）`);
    }
  }
  return errs;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.plan || !args.record) {
    fail('用法: fix-dispatch-gate.mjs --plan <plan.json> --record <dispatch-record.json>');
  }
  const errs = checkDispatch({ plan: readJson(args.plan), record: readJson(args.record) });
  if (errs.length) {
    for (const e of errs) process.stderr.write(`[DISPATCH-GATE-FAIL] ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('DISPATCH-GATE-OK\n');
}
