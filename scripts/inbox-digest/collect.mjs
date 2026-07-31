#!/usr/bin/env node
// 每日卡片第一段: 采集/分桶/排序（确定性）— 计划依据: §3.1
// 桶: B=等我拍板 / C=被@或被回 / E=PR被他人关·issue not_planned / D=杂音(卡片零出现,仅后台标已读)
// 排序（确定性，DeepSeek 不参与排序）: 阻塞别人的 > 等我拍板 > 被@ > 被关 > 其他
// gh 注入式: --notifications <json 文件>（真机由包装脚本 gh api /notifications all=true 全分页产出）
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJson, parseArgs, fail, nowIso, isMain} from '../lib/common.mjs';

const PRIORITY = { blocking_others: 0, awaiting_decision: 1, mentioned: 2, closed_on_me: 3, other: 4 };

export function classify(n) {
  // n: { id, reason, subject: {type, title, url}, repository, unread, blocking_others? }
  const reason = n.reason;
  const type = n.subject?.type;
  if (n.blocking_others === true) return { bucket: 'B', kind: 'blocking_others' };
  if (reason === 'review_requested' || reason === 'approval_requested') return { bucket: 'B', kind: 'awaiting_decision' };
  if (reason === 'mention' || reason === 'team_mention') return { bucket: 'C', kind: 'mentioned' };
  if (reason === 'comment' && (type === 'Issue' || type === 'PullRequest')) return { bucket: 'C', kind: 'mentioned' };
  if (reason === 'state_change' && n.closed_by_other === true) return { bucket: 'E', kind: 'closed_on_me' };
  // 杂音: 自己 push 的滚动记录 / ci 成功 / subscribed 等
  return { bucket: 'D', kind: 'noise' };
}

export function collect({ notifications, markedReadFile }) {
  const items = [];
  const noise = [];
  for (const n of notifications) {
    const c = classify(n);
    if (c.bucket === 'D') { noise.push(n); continue; }
    items.push({
      source_id: String(n.id),
      bucket: c.bucket,
      kind: c.kind,
      repo: n.repository ?? '',
      title: n.subject?.title ?? '',
      url: n.subject?.url ?? '',
      state: n.subject?.state ?? '',
      reason: n.reason
    });
  }
  // D 桶只写 marked-read.jsonl，卡片零出现（含统计行，§4 卡片纪律）
  if (markedReadFile && noise.length) {
    mkdirSync(dirname(markedReadFile), { recursive: true });
    for (const n of noise) appendFileSync(markedReadFile, JSON.stringify({ at: nowIso(), id: n.id, reason: n.reason }) + '\n');
  }
  items.sort((a, b) => (PRIORITY[a.kind] - PRIORITY[b.kind]) || a.source_id.localeCompare(b.source_id));
  return { generated_at: nowIso(), items, noise_marked_read: noise.length };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.notifications) fail('用法: collect.mjs --notifications <json> [--marked-read <jsonl>]');
  const res = collect({ notifications: readJson(args.notifications), markedReadFile: args['marked-read'] });
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
}
