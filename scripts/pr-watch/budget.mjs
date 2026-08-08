#!/usr/bin/env node
// 预算闸 v3 — 计划依据: W-6「全局 $30/天兜底闸 = 暂停等确认」
// 审③-F13-R + 审④-F7:
//   - 判定 = spent + 估算 > cap 即暂停
//   - reserve 按 dispatch_id 幂等（同 id 重试不重复占额）
//   - actual 必须 finite 且 ≥0（负数/NaN 洗账被拦）；同 id 只认第一条 actual
//   - dispatch 失败调用 releaseReserve → reserve 被 release 取代，预算不漂
//   - 全部读改写持同一把 ledger 锁
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs, fail, nowIso, isMain } from '../lib/common.mjs';
import { withLock } from '../lib/state-lock.mjs';

function dayStartMs(nowMs) { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); return d.getTime(); }

function readEntries(ledgerFile, nowMs) {
  if (!ledgerFile || !existsSync(ledgerFile)) return [];
  const cutoff = dayStartMs(nowMs);
  return readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => Date.parse(r.at) >= cutoff);
}

// 审(2026-08-08 GPT R2): 结算判定必须扫**全账本**——跨日重试时昨天的 actual 行
// 不能被当日 cutoff 过滤掉（否则昨天结算过的 dispatch 今天又被重复结算、追加 actual）。
// 只读全量、不做任何过滤；spentToday 的当日口径不在此处（见 readEntries）。
function readAllEntries(ledgerFile) {
  if (!ledgerFile || !existsSync(ledgerFile)) return [];
  return readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function validCost(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }

// 审⑤-F2: 每 dispatch 按台账行序折叠**最新状态**（reserve→release→reserve→actual 状态机），
// 不再用「历史上出现过 release 就永久 settled」的集合——release 之后的新 reserve 必须重新计入。
// 折叠规则: actual 一旦出现即终态（首条合法 actual 定值，后续 reserve/release 全忽略）；
// 否则最后一条 reserve/release 决定当前是否占额。无 id 的合法 actual 直接累加。
export function foldDispatchStates(entries) {
  const byId = new Map(); // id → { actual: number|null, reserved: number|null }
  let noIdSum = 0;
  for (const r of entries) {
    if (r.kind === 'reserve') {
      if (!r.dispatch_id) throw new Error('台账 reserve 缺 dispatch_id（无法结算的预留，fail-closed）');
      if (!validCost(r.cost_usd)) throw new Error('台账含非法 reserve 金额（fail-closed）');
      const s = byId.get(r.dispatch_id) ?? { actual: null, reserved: null };
      if (s.actual === null) s.reserved = r.cost_usd; // 最新 reserve 取代旧状态
      byId.set(r.dispatch_id, s);
    } else if (r.kind === 'release') {
      if (!r.dispatch_id) throw new Error('台账 release 缺 dispatch_id（fail-closed）');
      const s = byId.get(r.dispatch_id) ?? { actual: null, reserved: null };
      if (s.actual === null) s.reserved = null;
      byId.set(r.dispatch_id, s);
    } else if (r.kind === 'actual' || r.kind === undefined) { // actual 或旧格式（kind 缺失）
      if (!validCost(r.cost_usd)) throw new Error(`台账含非法实花金额 ${r.cost_usd}（负数/NaN 洗账被拦，fail-closed）`);
      if (r.dispatch_id) {
        const s = byId.get(r.dispatch_id) ?? { actual: null, reserved: null };
        if (s.actual === null) {
          s.actual = r.cost_usd; s.reserved = null;
          // 2026-08-08: 结算来源标记——complete 无 --actual 时以 estimate 结算（settlement='estimate'，
          // 估算结算可被同 id 的真实成本覆盖）；显式实值/人工 record 一律按真实成本（settlement='actual'）
          s.settlement = r.settlement === 'estimate' ? 'estimate' : 'actual';
        } else if (s.settlement === 'estimate' && r.settlement !== 'estimate') {
          // 真实成本同 id 覆盖估算结算（后续实值入账取代估算值）
          s.actual = r.cost_usd; s.settlement = 'actual';
        }
        byId.set(r.dispatch_id, s);
      } else noIdSum += r.cost_usd;
    } else {
      // 审⑥-F6: 未知 kind 不得被静默解释成 actual 终态——账本损坏/版本漂移必须炸出来
      throw new Error(`台账含未知 kind「${r.kind}」（不当 actual 洗账，fail-closed 需人工核账）`);
    }
  }
  return { byId, noIdSum };
}

// 2026-08-08: 该 dispatch 是否已结算（存在 actual 即已结算）——complete 估算结算幂等跳过依据
// 审(2026-08-08 GPT R2): 必须扫**全账本**按 dispatch_id 折叠——跨日重试时昨天的
// actual 行仍是结算证据（当日 cutoff 是 spentToday 的口径，不是结算幂等的口径）。
// 跨日语义: 昨天已结算 → 今天 isDispatchSettled 仍 true → 重跑 complete 幂等跳过、不追加。
export function isDispatchSettled(ledgerFile, dispatchId) {
  if (!ledgerFile || !existsSync(ledgerFile) || !dispatchId) return false;
  const { byId } = foldDispatchStates(readAllEntries(ledgerFile));
  const s = byId.get(dispatchId);
  return s !== undefined && s.actual !== null;
}

// 审(2026-08-08 GPT R2): 结算状态细节（是否已结算 + 结算来源）。isDispatchSettled 的
// 布尔版只够估算幂等；真实成本入账需要区分「已按 estimate 结算（可覆盖）」与
// 「已按 actual 结算（幂等跳过，不追加）」。折叠状态携带 settlement 标记（fold 内维护）。
function settledState(ledgerFile, dispatchId) {
  if (!ledgerFile || !existsSync(ledgerFile) || !dispatchId) return { settled: false, settlement: null };
  const { byId } = foldDispatchStates(readAllEntries(ledgerFile));
  const s = byId.get(dispatchId);
  if (s === undefined || s.actual === null) return { settled: false, settlement: null };
  return { settled: true, settlement: s.settlement ?? 'actual' };
}

export function spentToday(ledgerFile, nowMs = Date.now()) {
  const { byId, noIdSum } = foldDispatchStates(readEntries(ledgerFile, nowMs));
  let sum = noIdSum;
  for (const s of byId.values()) sum += s.actual ?? s.reserved ?? 0;
  return sum;
}

// 审(2026-08-08 GPT R2): 完工机械结算原语——从 complete.mjs 移入（预算逻辑归预算层，
// 供 ack.mjs 的锁内复合原语调用；避免 ack↔complete 循环 import）。
// 幂等规则（SC-B4 跨日）:
//   - 真实成本（actualUsd）: 同 id **已按真实成本结算** → 幂等跳过（次日重试不追加行）；
//     同 id 仅按 estimate 结算 → 真实成本覆盖（estimate 是估算，可被实值取代，fold 内维护）；
//     未结算 → 追加。
//   - 估算结算（无 actualUsd）: isDispatchSettled（全账本）→ 幂等跳过；否则 estimate 必须
//     是有穷 ≥0 数字（缺失/非法 fail-closed——不结算就不允许 ack，调用方在锁内抛错保 pending）。
// 本原语本身**不带锁**——由调用方（ack 锁内 / fixtures）决定临界区，避免嵌套同锁死锁。
export function settleDispatchBudget({ ledgerFile, dispatchId, actualUsd = null, estimateUsd = null }) {
  if (!ledgerFile || !dispatchId) {
    throw new Error(`结算缺 ledger/dispatch_id（无法结算的 reserve，fail-closed——不允许 ack 后留 reserve）`);
  }
  if (actualUsd !== null) {
    // 真实成本: 已按实值结算 → 幂等跳过；estimate 结算可被实值覆盖；未结算则直接入账
    const st = settledState(ledgerFile, dispatchId);
    if (st.settled && st.settlement === 'actual') return { settled: true, skipped: true };
    recordCost(ledgerFile, { cost_usd: actualUsd, kind: 'actual', dispatch_id: dispatchId, settlement: 'actual', note: 'settled-by-complete (actual)' });
    return { settled: true };
  }
  // 估算结算: 同 id 已结算（含昨日，全账本）→ 幂等跳过（重复 complete/跨日重试不追加噪音行）
  if (isDispatchSettled(ledgerFile, dispatchId)) return { settled: true, skipped: true };
  if (!(typeof estimateUsd === 'number' && Number.isFinite(estimateUsd) && estimateUsd >= 0)) {
    throw new Error(`结算缺实际成本且 estimate 不可得（${estimateUsd}，fail-closed——无法结算的 reserve 不许 ack）`);
  }
  recordCost(ledgerFile, { cost_usd: estimateUsd, kind: 'actual', dispatch_id: dispatchId, settlement: 'estimate', note: 'settled-by-complete (estimate, 可同 id 真实成本覆盖)' });
  return { settled: true };
}

export function recordCost(ledgerFile, { cost_usd, session, note, kind = 'actual', dispatch_id = null, settlement = null }) {
  if (kind !== 'release' && !validCost(cost_usd)) {
    throw new Error(`拒绝入账: cost_usd 必须是 ≥0 的有限数，得到 ${cost_usd}（审④-F7）`);
  }
  mkdirSync(dirname(ledgerFile), { recursive: true });
  const rec = { at: nowIso(), kind, dispatch_id, cost_usd: kind === 'release' ? 0 : cost_usd, session: session ?? null, note: note ?? null };
  if (settlement) rec.settlement = settlement; // 仅显式传入时落盘（旧行格式不变）
  appendFileSync(ledgerFile, JSON.stringify(rec) + '\n');
}

// dispatch 前原子预留（幂等: 同 dispatch_id 已有未结算 reserve → 直接放行不重复占额）
export function reserveBudget({ ledgerFile, capUsd, estimateUsd, dispatchId, nowMs = Date.now() }) {
  if (!capUsd || capUsd <= 0) return { allowed: false, spent: null, reason: '预算 cap 未配置（fail-closed）' };
  if (!validCost(estimateUsd) || estimateUsd <= 0) {
    return { allowed: false, spent: null, reason: '本次成本估算不可得（fail-closed: unavailable ≠ free）' };
  }
  if (!dispatchId) return { allowed: false, spent: null, reason: '缺 dispatch_id（reserve 必须可幂等/可结算）' };
  return withLock(`${ledgerFile}.lock`, () => {
    // 审⑤-F2: already 判断同样基于折叠后的最新状态（release 之后的 reserve 是新预留，不是重复）
    // 审(2026-08-08 GPT R3): 幂等判定必须扫**全账本**——跨日重试时昨天的 reserve/actual
    // 行不能被当日 cutoff 过滤掉（否则昨日已结算/已预留的 dispatch 今天又被重新 reserve、
    // 重复占额）。当日口径只属于 cap 计算：spentToday 内部按当日 fold，昨日占额不滚入今日
    // cap（cap 按日重置）；昨日已结算 → already-settled、昨日在途 → already-reserved，
    // 均不追加、不占今日额度；在途 reserve 在收口结算时以 actual 计入**结算当天**。
    const { byId } = foldDispatchStates(readAllEntries(ledgerFile));
    const cur = byId.get(dispatchId) ?? { actual: null, reserved: null };
    const already = cur.actual === null && cur.reserved !== null;
    const spent = spentToday(ledgerFile, nowMs);
    if (cur.actual !== null) return { allowed: true, spent, reason: 'already-settled（该 dispatch 已有实花入账——含昨日，不再追加 reserve）' };
    if (already) return { allowed: true, spent, reason: 'already-reserved（幂等重试不重复占额——含昨日在途 reserve，不占今日 cap）' };
    if (spent + estimateUsd > capUsd) {
      return { allowed: false, spent, reason: `今日已花/预留 $${spent.toFixed(2)} + 估算 $${estimateUsd} > cap $${capUsd}（暂停等 owner 确认，不是放弃）` };
    }
    recordCost(ledgerFile, { cost_usd: estimateUsd, kind: 'reserve', dispatch_id: dispatchId, note: 'pre-dispatch reserve' });
    return { allowed: true, spent: spent + estimateUsd, reason: 'reserved' };
  });
}

// dispatch 投递失败时释放预留（审④-F7: 失败重试不得让预算漂移）
export function releaseReserve({ ledgerFile, dispatchId }) {
  return withLock(`${ledgerFile}.lock`, () => {
    recordCost(ledgerFile, { cost_usd: 0, kind: 'release', dispatch_id: dispatchId, note: 'dispatch-failed release' });
  });
}

export function budgetCheck({ ledgerFile, capUsd, estimateUsd = 0, nowMs = Date.now() }) {
  if (!capUsd || capUsd <= 0) return { allowed: false, spent: null, reason: '预算 cap 未配置（fail-closed）' };
  const spent = spentToday(ledgerFile, nowMs);
  if (spent + estimateUsd > capUsd || spent >= capUsd) {
    return { allowed: false, spent, reason: `今日 $${spent.toFixed(2)} + 估算 $${estimateUsd} 超 cap $${capUsd}` };
  }
  return { allowed: true, spent, reason: 'within budget' };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.record) {
    if (!args.ledger || !args.cost) fail('用法: budget.mjs --record --ledger <jsonl> --cost <usd> [--dispatch-id d] [--session s] [--note n]');
    recordCost(args.ledger, { cost_usd: Number(args.cost), session: args.session, note: args.note, kind: 'actual', dispatch_id: args['dispatch-id'] ?? null });
    process.stdout.write('recorded\n');
  } else {
    if (!args.ledger || !args.cap) fail('用法: budget.mjs --ledger <jsonl> --cap <usd> [--estimate <usd>]');
    const res = budgetCheck({ ledgerFile: args.ledger, capUsd: Number(args.cap), estimateUsd: Number(args.estimate ?? 0) });
    process.stdout.write(JSON.stringify(res) + '\n');
    process.exit(res.allowed ? 0 : 2);
  }
}
