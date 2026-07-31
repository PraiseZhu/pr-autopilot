#!/usr/bin/env node
// ciReadiness(headSha) 契约 — 计划依据: W-3（exact-head，fail-closed）
// 审②-I4 修复: checks 必须逐条携带 head_sha / completed_at / run_id；
//   - 只统计 head_sha === headSha 的条目（旧 head 的 success 不给新 head 判绿）
//   - 同名 context 按 completed_at 确定性取最新；缺 timestamp / 同刻冲突 → 非绿（不猜）
import { readJson, parseArgs, fail, isMain} from './lib/common.mjs';

// checks: [{ context, state, head_sha, completed_at, run_id }]
export function ciReadiness({ headSha, checks, required }) {
  if (!headSha) return { green: false, reason: '缺 headSha（fail-closed）' };
  if (!Array.isArray(checks)) return { green: false, reason: '检查快照读不到（fail-closed）' };
  if (!Array.isArray(required) || required.length === 0) {
    return { green: false, reason: 'required contexts 清单为空/缺失（fail-closed，不猜）' };
  }
  const byContext = new Map();
  for (const c of checks) {
    if (!c || typeof c.context !== 'string') return { green: false, reason: '检查条目缺 context（fail-closed）' };
    if (c.head_sha !== headSha) continue; // exact-head: 其他 head 的结果一概不算
    if (!c.completed_at || Number.isNaN(Date.parse(c.completed_at))) {
      return { green: false, reason: `context ${c.context} 缺 completed_at（无法确定性排序，fail-closed）` };
    }
    const prev = byContext.get(c.context);
    if (!prev) { byContext.set(c.context, c); continue; }
    const tPrev = Date.parse(prev.completed_at), tCur = Date.parse(c.completed_at);
    if (tCur > tPrev) byContext.set(c.context, c);
    else if (tCur === tPrev && prev.state !== c.state) {
      return { green: false, reason: `context ${c.context} 同刻冲突结果（${prev.state} vs ${c.state}），fail-closed` };
    }
  }
  for (const ctx of required) {
    const entry = byContext.get(ctx);
    if (entry === undefined) return { green: false, reason: `required context 在当前 head 上缺席: ${ctx}` };
    if (entry.state !== 'success') return { green: false, reason: `required context 非绿: ${ctx}=${entry.state}` };
  }
  return { green: true, reason: 'all required contexts success on exact head' };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.checks || !args.required || !args.head) {
    fail('用法: ci-readiness.mjs --head <sha> --checks <checks.json> --required <required.json>');
  }
  let snapshot = null; let required = null;
  try { snapshot = readJson(args.checks); } catch { /* fail-closed */ }
  try { required = readJson(args.required); } catch { /* fail-closed */ }
  const res = ciReadiness({ headSha: args.head, checks: snapshot, required });
  process.stdout.write(JSON.stringify(res) + '\n');
  process.exit(res.green ? 0 : 1);
}
