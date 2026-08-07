#!/usr/bin/env node
// 修复完工收口 — 审③-F6-R: 一次修复的副作用 = push + 回帖，两者都被确认后才 ack。
// finalize 只负责 push（不再 ack）；本 wrapper 幂等探测两项副作用:
//   ① push 落地: 远端 head == candidate SHA
//   ② 回帖落地: PR 评论里存在带 HMAC provenance 且含 dispatch_id 的评论
// 两项都在 → ackDispatch（游标此刻才推进）。任一缺失 → 非零退出，
// 引擎按 at-least-once 重派，重派会话先探测已完成项只补缺失项（副作用幂等）。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readJson, parseArgs, fail, isMain } from '../lib/common.mjs';
import { verifyMarker } from './provenance.mjs';
import { settleAndAckDispatch } from './ack.mjs';
import { settleDispatchBudget } from './budget.mjs';
import { receiptPath } from './finalize.mjs';

// 审④-F4: candidate 不再由调用者自报——只认 finalize 落盘的 receipt
export function checkCompletion({ manifest, snapshot, receipt, hmacKey }) {
  const missing = [];
  if (!receipt) {
    missing.push('无 push receipt（finalize 未成功执行过 push——凭空声称完工被拦，审④-F4）');
    return { ok: false, missing };
  }
  if (receipt.dispatch_id !== manifest.dispatch_id) {
    missing.push(`receipt dispatch_id 不匹配（receipt=${receipt.dispatch_id} manifest=${manifest.dispatch_id}）——跨任务 receipt 被拒`);
    return { ok: false, missing };
  }
  // 审⑤-F1: 只认 committed，或经远端核实的 intent（intent 的核实 = 下方 head==candidate 强制项）
  if (receipt.phase !== 'committed' && receipt.phase !== 'intent') {
    missing.push(`receipt phase 非法（${receipt.phase}）——两段协议之外的 receipt 不认`);
    return { ok: false, missing };
  }
  if (snapshot.head_sha !== receipt.candidate) {
    missing.push(`push 未落地: 远端 head=${String(snapshot.head_sha).slice(0, 12)} ≠ receipt.candidate=${String(receipt.candidate).slice(0, 12)}`);
  }
  const found = (snapshot.comments ?? []).some((c) =>
    c.body && c.body.includes(`dispatch:${manifest.dispatch_id}`) && verifyMarker(c.body, hmacKey)
  );
  if (!found) missing.push(`回帖未落地: 无带 provenance 签名且含 dispatch:${manifest.dispatch_id} 的评论`);
  return { ok: missing.length === 0, missing };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const need = ['manifest', 'snapshot-cmd', 'state-dir'];
  if (need.some((k) => !args[k])) {
    fail('用法: complete.mjs --manifest <pr-fix.json> --snapshot-cmd "<cmd>" --state-dir <dir> [--actual <usd>] [--journal <f>]\n（candidate 来自 finalize receipt，不自报——审④-F4；--actual 为真实成本，缺省以 state 固化的 pending_dispatch.budget.estimate 结算为 actual——结算与 ack 同锁原子，结算失败不 ack）');
  }
  const manifest = readJson(args.manifest);
  const tpl = args['snapshot-cmd'].split(' ').map((p) =>
    p.replace('{owner}', manifest.owner).replace('{repo}', manifest.repo).replace('{pr}', String(manifest.pr_number)));
  const snapshot = JSON.parse(execFileSync(tpl[0], tpl.slice(1), { encoding: 'utf8' }));
  const rp = receiptPath(args['state-dir'], manifest);
  const receipt = existsSync(rp) ? readJson(rp) : null;
  const res = checkCompletion({ manifest, snapshot, receipt, hmacKey: process.env.PR_AUTOPILOT_HMAC_KEY });
  if (!res.ok) {
    for (const m of res.missing) process.stderr.write(`[COMPLETE] ${m}\n`);
    process.exit(1);
  }
  // 审(2026-08-08 GPT R2): 结算与 ack 在**同一 state-lock 临界区**内完成（ack.mjs
  // settleAndAckDispatch）——结算来源只认 state 固化的 pending_dispatch.budget（manifest
  // 可变，不信任；旧 manifest 无 budget 也从 pending 收口）。结算失败 fail-closed：不 ack、
  // 不清 pending，引擎按 at-least-once 重派，重跑 complete 幂等重试。绝不「成功 ack 后仍留
  // reserve」，也绝不留「已结算但 pending 未清」的半状态（结算与清 pending 无窗口）。
  const rawActual = args.actual === undefined || args.actual === null || args.actual === '' ? null : Number(args.actual);
  try {
    const ack = settleAndAckDispatch({
      stateDir: args['state-dir'], owner: manifest.owner, repo: manifest.repo,
      prNumber: manifest.pr_number, dispatchId: manifest.dispatch_id,
      actualUsd: rawActual, journalFile: args.journal
    });
    if (!ack.ok && !/无 pending/.test(ack.reason)) {
      process.stderr.write(`[COMPLETE] ack 失败: ${ack.reason}\n`);
      process.exit(1);
    }
    if (!ack.ok) {
      // 重复 complete（已 ack 过）：结算幂等 + ack 幂等 → 直接判成功，不报错
      process.stdout.write(JSON.stringify({ ok: true, idempotent: true, reason: ack.reason }) + '\n');
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(ack) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[COMPLETE] 预算结算失败（不 ack，pending 保留，下轮重派重跑）: ${e.message}\n`);
    process.exit(1);
  }
}
