#!/usr/bin/env node
// intent-check.mjs — 意图契约一致性校验（PR-B1，2026-08-06，GPT 共识计划 SC-4/5/18）
//
// 双载体模型：
//   权威副本 = PR body 的 <!-- pr-intent:start --> ... <!-- pr-intent:end --> marker 区块
//              （经 bundle.pr_body 自动参与 review_input_hash——三席审的输入天然含意图，
//               无需改 review-input-hash.mjs 的 canonical 契约）
//   工作副本 = worktree 根 .pr-intent.md（本机本 worktree 状态，换机可从 marker 重建）
//
// 状态机（exit code 语义）：
//   OK               exit 0  两副本 digest 一致
//   REBUILT          exit 0  文件缺、marker 在 → --write 时重建 .pr-intent.md
//   MISMATCH         exit 1  两副本都在但 digest 不一致（SC-18：Phase 1 硬 FAIL）
//   MARKER_MISSING   exit 2  文件在、marker 缺 → 输出待写入 body 的 marker 区块；
//                            权威副本必须先落 PR body 再算 bundle（动作后重跑）
//   FALLBACK         exit 2  两副本都缺 → 从 --pr-body 首段生成 [auto-generated] 意图，
//                            输出 marker 区块；同样必须先落 body 再算 bundle（SC-5）
//
// exit 2 不是失败，是「权威副本未就位」的 action-required：lead 把 stdout 的 marker 区块
// 写进 PR body（gh pr edit / 待建 PR 的 body 草稿）后重跑本脚本至 exit 0。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { sha256, parseArgs, fail, isMain } from './lib/common.mjs';

export const MARKER_START = '<!-- pr-intent:start -->';
export const MARKER_END = '<!-- pr-intent:end -->';

export function normalizeIntent(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').trim();
}

export function intentDigest(text) {
  return sha256(normalizeIntent(text));
}

export function extractIntentMarker(prBody) {
  const body = String(prBody ?? '');
  const s = body.indexOf(MARKER_START);
  if (s === -1) return null;
  const e = body.indexOf(MARKER_END, s + MARKER_START.length);
  if (e === -1) return null; // 半个 marker 视为缺失（宁可要求重写，不猜边界）
  return body.slice(s + MARKER_START.length, e);
}

export function buildMarkerBlock(intentText) {
  return `${MARKER_START}\n${normalizeIntent(intentText)}\n${MARKER_END}`;
}

// 两副本都缺时的兜底：从 PR body 首个非空段生成最小意图，显式标注 auto-generated。
export function fallbackIntentFromBody(prBody) {
  const paras = String(prBody ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const goal = (paras[0] ?? '(PR body 为空，目标句待 owner 补写)').split('\n')[0].slice(0, 200);
  return [
    '[auto-generated] 本意图由 intent-check 从 PR body 首段生成，owner 应尽早改写为真实契约。',
    `目标: ${goal}`,
    '非目标: (未声明——审查席对范围外意见默认按「推」处置)',
    '验收: (未声明——以 PR body 的 SC/测试证据为准)'
  ].join('\n');
}

export function evaluateIntent({ fileContent, prBody }) {
  const marker = extractIntentMarker(prBody);
  const hasFile = fileContent !== null && fileContent !== undefined;
  if (marker !== null && hasFile) {
    if (intentDigest(marker) === intentDigest(fileContent)) {
      return { status: 'OK', exit: 0, intent: normalizeIntent(marker) };
    }
    return {
      status: 'MISMATCH', exit: 1,
      file_digest: intentDigest(fileContent), marker_digest: intentDigest(marker)
    };
  }
  if (marker !== null) {
    return { status: 'REBUILT', exit: 0, intent: normalizeIntent(marker) };
  }
  if (hasFile) {
    return { status: 'MARKER_MISSING', exit: 2, marker_block: buildMarkerBlock(fileContent) };
  }
  const generated = fallbackIntentFromBody(prBody);
  return { status: 'FALLBACK', exit: 2, marker_block: buildMarkerBlock(generated), auto_generated: true };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const filePath = args['intent-file'] ?? '.pr-intent.md';
  const bodyPath = args['pr-body'];
  if (!bodyPath) fail('用法: intent-check.mjs --pr-body <body文件> [--intent-file .pr-intent.md]');
  const prBody = readFileSync(bodyPath, 'utf8');
  const fileContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  const res = evaluateIntent({ fileContent, prBody });
  if (res.status === 'REBUILT') {
    // REBUILT 的语义就是「工作副本已重建」——无条件落盘，不设开关（审①B1-F1：
    // 可选 --write 留下过「exit 0 但文件没重建」的文档性成功路径）。
    writeFileSync(filePath, `${res.intent}\n`);
  }
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  process.exit(res.exit);
}
