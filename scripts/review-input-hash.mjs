#!/usr/bin/env node
// review_input_hash 计算器 — 计划依据: §1.1b ⑩ 第一段 hash
// hash(base_sha + candidate_sha + PR 标题/正文 + touches_ui + matched_paths
//      + ui_registry_config_hash + pr_context_digest)
// 派审前可算；三份 verdict 必须携带同一个该值。
import { hashObject, readJson, parseArgs, fail, isMain} from './lib/common.mjs';

const REQUIRED = [
  'base_sha', 'candidate_sha', 'pr_title', 'pr_body',
  'touches_ui', 'matched_paths', 'ui_registry_config_hash', 'pr_context_digest'
];

export function computeReviewInputHash(input) {
  for (const k of REQUIRED) {
    if (!(k in input)) throw new Error(`review-input 缺少必填字段: ${k}`);
  }
  if (typeof input.touches_ui !== 'boolean') throw new Error('touches_ui 必须是 boolean');
  if (!Array.isArray(input.matched_paths)) throw new Error('matched_paths 必须是数组');
  // 只取契约字段参与 hash，多余字段不入锅（防止携带易变字段导致 hash 漂移）
  // 注意（lead 2026-08-07 裁决 2）：pr_number **刻意不入** review_input_hash——
  // 进了会因「Phase 3 建 draft PR」动作（null→N）让同一 candidate 的 input hash 变 →
  // 三份 verdict 全失效 → 整轮重跑，正是轮次膨胀根因之一（与 pr_body 在 input hash 里同病灶）。
  // pr_number 只进 artifact + consensus_artifact_hash（consensus-gate.mjs 处理），
  // 对 review_input_hash 是多余字段，被这里忽略。
  const canonical = {
    base_sha: input.base_sha,
    candidate_sha: input.candidate_sha,
    pr_title: input.pr_title,
    pr_body: input.pr_body,
    touches_ui: input.touches_ui,
    matched_paths: [...input.matched_paths].sort(),
    ui_registry_config_hash: input.ui_registry_config_hash,
    pr_context_digest: input.pr_context_digest
  };
  return hashObject(canonical);
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) fail('用法: review-input-hash.mjs --input <bundle.json>');
  try {
    process.stdout.write(computeReviewInputHash(readJson(args.input)) + '\n');
  } catch (e) {
    fail(e.message);
  }
}
