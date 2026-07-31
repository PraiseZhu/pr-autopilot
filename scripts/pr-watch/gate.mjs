#!/usr/bin/env node
// 信号判定 — 计划依据: W-3
// 审②-F7 重写: 指纹改为「按类游标 + exact-head 过滤」，不再用全历史 digest:
//   - review: 只计 commitOid === 当前 head 且 state ∈ {CHANGES_REQUESTED, COMMENTED} 且
//     非 outdated/dismissed 且 node id 不在游标里的新 review
//   - comment: 只计 node id 不在游标里、且非自家 provenance（HMAC 验证）的新评论
//   - ci: 只看当前 head 的红（ci.head_sha 必须等于 snapshot.head_sha）
//   - 旧评论 + head 前进 → 游标已含其 id → 不唤醒（堵「自己 push 重新唤醒旧反馈」）
// decision ∈ none | blocked-external | actionable | terminal
// 游标推进由引擎在 durable ack 后执行（F6），本模块只计算不落盘。
import { readJson, parseArgs, isMain} from '../lib/common.mjs';
import { verifyMarker } from './provenance.mjs';

const HOLD_LABELS = ['hold', 'do-not-merge', 'blocked', 'needs-sign-off'];

// cursors: { review_ids: [], comment_ids: [], ci_red_sha: null, conflict_sha: null }
export function emptyCursors() {
  return { review_ids: [], comment_ids: [], ci_red_sha: null, conflict_sha: null };
}

// snapshot 契约（adapter 归一化 / fixture 同构）:
// { state, head_sha,
//   ci: { green, failing[], head_sha },
//   reviews: [{ id, state, commitOid, outdated?, dismissed?, body }],
//   comments: [{ id, body, author_is_self? }],
//   labels: [], mergeable }
export function evaluate(cursors, snapshot, opts = {}) {
  const hmacKey = opts.hmacKey ?? null;
  cursors = cursors ?? emptyCursors();

  if (snapshot.state === 'merged' || snapshot.state === 'closed') {
    return { decision: 'terminal', cursors, signals: [snapshot.state], newItems: {} };
  }

  const head = snapshot.head_sha;
  const signals = [];
  const newItems = { reviews: [], comments: [] };

  // reviews: exact-head + 非 stale + 新 id
  const seenReviews = new Set(cursors.review_ids);
  for (const r of snapshot.reviews ?? []) {
    if (seenReviews.has(String(r.id))) continue;
    if (r.outdated === true || r.dismissed === true) continue;
    if (r.commitOid && r.commitOid !== head) continue; // 旧 head 的 review 不唤醒
    if (!['CHANGES_REQUESTED', 'COMMENTED'].includes(r.state)) continue;
    newItems.reviews.push(String(r.id));
  }
  if (newItems.reviews.length) signals.push('review');

  // comments: 新 id + 非自家 provenance
  const seenComments = new Set(cursors.comment_ids);
  for (const c of snapshot.comments ?? []) {
    if (seenComments.has(String(c.id))) continue;
    if (c.author_is_self === true) continue;
    if (c.body && verifyMarker(c.body, hmacKey)) continue; // 自家签名评论不算反馈
    newItems.comments.push(String(c.id));
  }
  if (newItems.comments.length) signals.push('comment');

  // ci: 当前 head 的红，且未对同一红派过活
  if (snapshot.ci && snapshot.ci.green === false && snapshot.ci.head_sha === head && cursors.ci_red_sha !== head) {
    signals.push('ci-red');
  }
  // conflict: 同一 head 只唤醒一次
  if (snapshot.mergeable === false && cursors.conflict_sha !== head) {
    signals.push('conflict');
  }

  // 推进后的游标（引擎在 ack 后才持久化，F6）
  const nextCursors = {
    review_ids: [...seenReviews, ...newItems.reviews],
    comment_ids: [...seenComments, ...newItems.comments],
    ci_red_sha: signals.includes('ci-red') ? head : cursors.ci_red_sha,
    conflict_sha: signals.includes('conflict') ? head : cursors.conflict_sha
  };

  const hold = (snapshot.labels ?? []).some((l) => HOLD_LABELS.includes(String(l).toLowerCase()));
  if (hold) {
    // blocked-external: 静默等，且**游标不推进**（审③-F7-R: hold 期间到达的反馈
    // 必须在解除 hold 后仍能被识别为新信号——推进游标会把它们永久吞掉）。
    // 持续 hold 期间每轮都会重新看到这些信号，但因不投递也就不会重复派活。
    return { decision: 'blocked-external', cursors, signals: ['hold-label', ...signals], newItems };
  }
  if (signals.length === 0) {
    return { decision: 'none', cursors, signals: [], newItems };
  }
  return { decision: 'actionable', cursors: nextCursors, signals, newItems };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.snapshot) { process.stderr.write('用法: gate.mjs --snapshot <snap.json> [--cursors <cursors.json>]\n'); process.exit(1); }
  const res = evaluate(args.cursors ? readJson(args.cursors) : null, readJson(args.snapshot), { hmacKey: process.env.PR_AUTOPILOT_HMAC_KEY });
  process.stdout.write(JSON.stringify(res) + '\n');
}
