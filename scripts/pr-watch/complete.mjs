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
import { ackDispatch } from './ack.mjs';
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
    fail('用法: complete.mjs --manifest <pr-fix.json> --snapshot-cmd "<cmd>" --state-dir <dir> [--journal <f>]（candidate 来自 finalize receipt，不自报——审④-F4）');
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
  const ack = ackDispatch({
    stateDir: args['state-dir'], owner: manifest.owner, repo: manifest.repo,
    prNumber: manifest.pr_number, dispatchId: manifest.dispatch_id, journalFile: args.journal
  });
  process.stdout.write(JSON.stringify(ack) + '\n');
  process.exit(ack.ok ? 0 : 1);
}
