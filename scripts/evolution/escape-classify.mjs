#!/usr/bin/env node
// 漏检分类器 — 计划依据: SP-6 / E1 / E2（审②-F10: 采集必须接线且带五条防误报纪律）
// 输入: 盯梢快照里的远端结构化 finding + 本地三审 ledger（按 PR 存 JSON）
// 五条纪律（审⑥）:
//   ① 幂等键 = remote node id；跨 bot 回声按 repo+PR+head+规整路径/symbol+语义指纹聚类合并
//   ② 只计在同一 head 上被确认 actionable 的（resolved=true 或 accepted=true）
//   ③ 比对用规整路径+symbol，不用裸行号
//   ④ ≥2 阈值必须跨实例（cluster.mjs 已断言 instance_key 互异）
//   ⑤ why-class 先记 pending（ledger-append 已强制 E1 默认 pending）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, readJson, parseArgs, fail, isMain} from '../lib/common.mjs';
import { appendLedger } from './ledger-append.mjs';

function normalizeAnchor(pathOrSymbol) {
  return String(pathOrSymbol ?? '').toLowerCase().replace(/:\d+(-\d+)?$/, '').replace(/\s+/g, ' ').trim();
}

export function semanticFingerprint(f) {
  return sha256([
    normalizeAnchor(f.path ?? f.anchor),
    String(f.symbol ?? '').toLowerCase(),
    String(f.summary ?? f.body ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160)
  ].join('|')).slice(0, 16);
}

// remoteFindings: snapshot.remote_findings（adapter 归一化）:
// [{ node_id, head_sha, path, symbol, summary, source(bot/human), state, resolved, accepted,
//    kind ('finding'|'evidence-gate-rejection'), registry_path? }]
export function classifyEscapes({ snapshot, owner, repo, prNumber, triReviewLedgerDir, escapeLedger }) {
  const remote = snapshot.remote_findings ?? [];
  if (!remote.length) return { e1: 0, e2: 0, skipped: 0 };

  // 本地三审 ledger: <dir>/<owner>__<repo>__<N>.json = { candidate_sha, findings: [{anchor, evidence, origin_reviewer}], gate_checks: [...] }
  const ledgerFile = join(triReviewLedgerDir, `${owner}__${repo}__${prNumber}.json`);
  if (!existsSync(ledgerFile)) return { e1: 0, e2: 0, skipped: remote.length, reason: '无本地三审 ledger（旁路 PR 不算漏检）' };
  const local = readJson(ledgerFile);
  // 审③-F10-R: 三审 ledger 审的 candidate 必须就是当前 head——
  // 修复后 head 前进时旧 ledger 不能再当基准（跨 head 反馈误记漏检被拦）
  if (local.candidate_sha !== snapshot.head_sha) {
    return { e1: 0, e2: 0, skipped: remote.length, reason: `三审 ledger candidate(${String(local.candidate_sha).slice(0, 12)}) ≠ 当前 head（跨 head 不计漏检）` };
  }
  const localFps = new Set((local.findings ?? []).map((f) => semanticFingerprint({ path: f.anchor, summary: f.evidence })));
  const localGateIds = new Set((local.gate_checks ?? []).map((g) => g.gate_id));

  let e1 = 0, e2 = 0, skipped = 0;
  const clustered = new Set(); // 纪律①: 回声聚类
  for (const rf of remote) {
    // 纪律②: 仅同 head + 确认 actionable
    if (rf.head_sha !== snapshot.head_sha) { skipped++; continue; }
    if (!(rf.resolved === true || rf.accepted === true)) { skipped++; continue; }
    if (['stale', 'outdated', 'dismissed', 'suggestion', 'wrong'].includes(rf.state)) { skipped++; continue; }

    const fp = semanticFingerprint(rf);
    const clusterKey = `${owner}/${repo}#${prNumber}|${rf.head_sha}|${fp}`;
    if (clustered.has(clusterKey)) { skipped++; continue; } // 多 bot 回声算一条
    clustered.add(clusterKey);

    if (rf.kind === 'evidence-gate-rejection') {
      // E2: 上游证据门打回 = registry 漏路径实锤（只接受确认过的）
      const res = appendLedger({
        ledgerFile: escapeLedger,
        entry: {
          channel: 'E2', kind: 'event',
          pattern_key: `registry-miss:${normalizeAnchor(rf.registry_path ?? rf.path)}`,
          instance_key: `${owner}/${repo}#${prNumber}`,
          remote_node_id: rf.node_id,
          summary: String(rf.summary ?? '').slice(0, 200)
        }
      });
      if (res.appended) e2++; else skipped++; // 统计口径与落盘一致（e2e-evolution 观察④）
      continue;
    }

    // E1: 本地三审 ledger 里比不上的 = 漏检（第三席已捕获的上游门类项不算——gate_id 命中即跳过）
    if (rf.gate_id && localGateIds.has(rf.gate_id)) { skipped++; continue; }
    if (localFps.has(fp)) { skipped++; continue; } // 本地已命中，不是漏检
    const res = appendLedger({
      ledgerFile: escapeLedger,
      entry: {
        channel: 'E1', kind: 'event', why_class: 'pending', // 纪律⑤
        pattern_key: `escape:${normalizeAnchor(rf.path)}:${fp.slice(0, 8)}`,
        instance_key: `${owner}/${repo}#${prNumber}`,
        remote_node_id: rf.node_id,
        summary: String(rf.summary ?? '').slice(0, 200)
      }
    });
    if (res.appended) e1++; else skipped++; // 统计口径与落盘一致
  }
  return { e1, e2, skipped };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const need = ['snapshot', 'owner', 'repo', 'pr', 'tri-ledger-dir', 'escape-ledger'];
  if (need.some((k) => !args[k])) fail('用法: escape-classify.mjs --snapshot <f> --owner o --repo r --pr N --tri-ledger-dir <d> --escape-ledger <jsonl>');
  const res = classifyEscapes({
    snapshot: readJson(args.snapshot), owner: args.owner, repo: args.repo, prNumber: args.pr,
    triReviewLedgerDir: args['tri-ledger-dir'], escapeLedger: args['escape-ledger']
  });
  process.stdout.write(JSON.stringify(res) + '\n');
}
