#!/usr/bin/env node
// 聚类达阈判定 — 计划依据: §1.3 统一纪律 / §1.3a 周会流程 / R8
// 规则:
//   - 按 (channel + pattern_key) 聚类
//   - 达阈 = 同簇 ≥2 条 event 且 instance_key 互异（单 PR 内回声不算，审⑥④）
//   - E1 只计 why_class 已转正（非 pending）的条目（审⑥⑤: pending 需先 confirm）
//   - 被拒过的同根因（存在 kind=rejected 记录）不重提，除非拒后出现新 instance（R8）
//   - --since 只看窗口内条目（周会: 过去 7 天）
import { existsSync, readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs, fail, isMain, sha256, canonicalJson } from '../lib/common.mjs';

// 审⑤-F6 + 审⑥-F3: confirm 的 HMAC 签名载荷——绑定 id_ref/簇/规则/证据全字段，不可挪用。
// 规则路径同样入签: rule_id 与 evidence_hash 是签名的一部分，自动会话「知道 allowlisted
// 规则名 + 自报任意 64hex」签不出合法 sig（key 只在 owner shell / 受信 evaluator 环境）。
export function confirmSigPayload(rec) {
  return canonicalJson({
    v: 1, kind: 'confirm', id_ref: rec.id_ref, channel: rec.channel, pattern_key: rec.pattern_key,
    rule_id: rec.rule_id ?? null, evidence_hash: rec.evidence_hash ?? null
  });
}
export function signConfirm(rec, key) {
  return createHmac('sha256', key).update(confirmSigPayload(rec)).digest('hex');
}

export function clusterLedger({ lines, sinceIso = null, threshold = 2, expectedHeadHash = undefined, confirmKey = null, confirmRules = [] }) {
  const since = sinceIso ? Date.parse(sinceIso) : -Infinity;
  const clusters = new Map();
  // e2e-evolution 实锤修复①: hash 链验证——每条记录的 prev 必须等于上一行原文的
  // sha256（首条为 GENESIS）。删/改/重写任何历史行（如删掉 rejected 记录重开被拒簇）
  // 都会断链 → fail-closed 抛错，周会拿不到任何达阈簇。
  for (let i = 0; i < lines.length; i++) {
    const rec = JSON.parse(lines[i]);
    const expect = i === 0 ? 'GENESIS' : sha256(lines[i - 1]);
    if (rec.prev !== expect) {
      throw new Error(`台账 hash 链断裂于第 ${i + 1} 行（prev 不匹配）——疑似删改历史（R9 违例），fail-closed`);
    }
  }
  // 截尾检测: prev 链的前缀天然自洽，末行必须与 head 侧车一致
  if (expectedHeadHash !== undefined) {
    const actual = lines.length ? sha256(lines[lines.length - 1]) : null;
    if (actual !== expectedHeadHash) {
      throw new Error('台账末行与 head 侧车不一致——疑似截尾删除历史（R9 违例），fail-closed');
    }
  }
  // e2e-evolution 实锤修复②: confirm 只认 id_ref，且 id_ref 必须命中真实 event id
  const eventById = new Map();
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (rec.kind === 'event') eventById.set(rec.id, rec);
  }
  const confirmed = new Set();
  // 审⑤-F6: 转正权来自鉴权，不来自「知道 id」——
  //   路径A: confirmed_by=owner 且 sig = HMAC(PR_AUTOPILOT_CONFIRM_KEY, {v,kind,id_ref,channel,pattern_key})
  //          key 缺失时 owner confirm 一律不生效（fail-closed，不是放行）
  //   路径B: rule_id ∈ constitution.confirm_rule_allowlist 且 evidence_hash 为 64hex
  //   两路径都要求 confirm 的 channel/pattern_key 与被引用 event 完全一致（跨簇挪用被拒）
  // 审⑥-F3: 两条路径都必须验签——sig 覆盖 rule_id/evidence_hash 全字段；key 缺失一律不生效。
  // 规则路径额外要求 rule_id ∈ 宪法 allowlist + evidence_hash 为 64hex（结构面），
  // 但 authority 来自签名，不来自格式。
  const confirmAuthorized = (rec, ev) => {
    if (!ev) return false;
    if (rec.channel !== ev.channel || rec.pattern_key !== ev.pattern_key) return false;
    if (!confirmKey || !rec.sig || rec.sig !== signConfirm(rec, confirmKey)) return false;
    if (rec.confirmed_by === 'owner' && !rec.rule_id) return true;
    if (rec.rule_id) {
      return confirmRules.includes(rec.rule_id) && /^[0-9a-f]{64}$/.test(String(rec.evidence_hash ?? ''));
    }
    return false;
  };
  // 「拒后新证据」按台账行序判（append-only + hash 链保证有序不可篡改）
  const rejections = new Map();

  lines.forEach((line, seq) => {
    const rec = JSON.parse(line);
    const key = `${rec.channel}|${rec.pattern_key}`;
    if (rec.kind === 'confirm') {
      if (rec.id_ref && confirmAuthorized(rec, eventById.get(rec.id_ref))) confirmed.add(rec.id_ref); // 无鉴权/跨簇/伪 id_ref 全部无效
      return;
    }
    if (rec.kind === 'rejected') { rejections.set(key, seq); return; }
    if (rec.kind !== 'event') return;
    if (Date.parse(rec.at) < since) return;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push({ ...rec, _seq: seq });
  });

  const reached = [];
  for (const [key, recs] of clusters) {
    const usable = recs.filter((r) => {
      if (r.channel === 'E1' && r.why_class === 'pending' && !confirmed.has(r.id)) return false;
      return true;
    });
    const instances = new Set(usable.map((r) => r.instance_key));
    if (instances.size < threshold) continue;

    const rejectedSeq = rejections.get(key);
    if (rejectedSeq !== undefined) {
      // R8: 被拒后必须有新证据实例（台账行序在 rejected 之后）才能重提
      const newer = usable.filter((r) => r._seq > rejectedSeq);
      const newerInstances = new Set(newer.map((r) => r.instance_key));
      if (newerInstances.size === 0) continue;
    }
    const { _seq, ...sample } = usable[0];
    reached.push({
      cluster_key: key,
      channel: usable[0].channel,
      pattern_key: usable[0].pattern_key,
      instance_count: instances.size,
      entry_ids: usable.map((r) => r.id),
      sample
    });
  }
  return reached.sort((a, b) => b.instance_count - a.instance_count);
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ledger) fail('用法: cluster.mjs --ledger <jsonl> [--since <iso>] [--threshold 2] [--max 3]');
  const lines = existsSync(args.ledger) ? readFileSync(args.ledger, 'utf8').split('\n').filter(Boolean) : [];
  const headFile = `${args.ledger}.head`;
  const expectedHeadHash = existsSync(headFile) ? readFileSync(headFile, 'utf8').trim() : undefined;
  // 审⑤-F6: confirm 鉴权配置——rule allowlist 来自宪法固定路径（无 CLI override），key 来自 owner-shell env
  const constitution = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'constitution-paths.json'), 'utf8');
  const confirmRules = JSON.parse(constitution).confirm_rule_allowlist ?? [];
  let reached = clusterLedger({
    lines, sinceIso: args.since ?? null, threshold: Number(args.threshold ?? 2), expectedHeadHash,
    confirmKey: process.env.PR_AUTOPILOT_CONFIRM_KEY ?? null, confirmRules
  });
  const max = Number(args.max ?? 3); // R8: 每周提案 ≤3
  if (reached.length > max) reached = reached.slice(0, max);
  process.stdout.write(JSON.stringify(reached, null, 2) + '\n');
}
