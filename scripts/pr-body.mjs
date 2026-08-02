#!/usr/bin/env node
// PR body 不变量锚点 — SC-B2（依赖 SC-B1 的 invariant/family_id 数据契约）
// 从 sc-manifest + consensus artifact 生成一段 marker 包围的幂等段落，插入/替换进 PR body：
//   MUST-FIX: 按 family_id 去重列 invariant + 全部 manifestation（sc_id + anchor_paths）
//   ARCHIVE:  列残余风险 + 接受理由 + README.md 锚点——措辞是「已登记接受」，不是「已修复」
// 不外泄敏感路径/证据原文（D2 对齐）：只列 anchor_paths（三审本就公开产出的锚点）与
// invariant/holds 的截断摘要，不列 finding.evidence 全文（可能含内部上下文）。
//
// 关键时序（SC-B2）：scripts/review-input-hash.mjs 已把 pr_body 纳入审查输入 hash——本段
// 必须在**最终 delta review 之前**生成进 body，三席审的就是含锚点段的 body；Phase 3
// create/edit PR 只能提交已审同 hash 的 body。已存在 PR 时只替换 marker 段、保留 owner
// 手写正文；审后若 body 漂移（marker 段之外的文字被改，或再次生成后 hash 不同）→ 视为
// 输入变更，必须重审（不是「反正是自动生成的段落，可以随时重刷」）。
import { readFileSync } from 'node:fs';
import { readJson, parseArgs, fail, isMain } from './lib/common.mjs';

export const SECTION_START = '<!-- pr-autopilot:invariants:start -->';
export const SECTION_END = '<!-- pr-autopilot:invariants:end -->';

function truncate(s, n = 200) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// 纯函数：不读文件、不落盘——由 CLI/调用方决定 existing body 从哪来、结果写到哪。
export function buildInvariantsSection({ artifact, manifest }) {
  const canonical = artifact?.canonical_findings ?? [];
  const scsByFinding = new Map();
  for (const sc of manifest?.scs ?? []) {
    if (sc.kind === 'global') continue;
    for (const fid of sc.finding_ids ?? []) scsByFinding.set(fid, sc);
  }

  // MUST-FIX 侧：按 family_id 去重——同一不变量只列一次 invariant 文本，manifestation 全列。
  const families = new Map(); // family_id -> { invariant, manifestations: [] }
  const archiveEntries = [];
  for (const f of canonical) {
    const sc = scsByFinding.get(f.id);
    if (!sc) continue; // 未被任何 SC 覆盖（suggestion 级常见）——不进 body，不是遗漏
    if (sc.kind === 'archive') {
      archiveEntries.push({ finding_id: f.id, sc_id: sc.id, holds: sc.holds, anchor_paths: f.anchor_paths ?? [] });
      continue;
    }
    if (!f.family_id) continue; // 防御性跳过（actionable finding 理论上都已归族，B1 强制）
    if (!families.has(f.family_id)) families.set(f.family_id, { invariant: f.invariant, manifestations: [] });
    families.get(f.family_id).manifestations.push({ finding_id: f.id, sc_id: sc.id, kind: sc.kind, anchor_paths: f.anchor_paths ?? [] });
  }

  const lines = [SECTION_START, ''];
  lines.push('### MUST-FIX（本轮共识确认，按不变量归族去重）', '');
  if (families.size === 0) {
    lines.push('_本轮无 MUST-FIX 项。_');
  } else {
    for (const [familyId, fam] of [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`- **${truncate(fam.invariant, 120)}**（family=\`${familyId}\`）`);
      for (const m of fam.manifestations.slice().sort((a, b) => a.finding_id.localeCompare(b.finding_id))) {
        lines.push(`  - \`${m.sc_id}\`（${m.kind}）: ${m.anchor_paths.join(', ')}`);
      }
    }
  }
  lines.push('', '### ARCHIVE（已登记接受的残余风险）', '');
  if (archiveEntries.length === 0) {
    lines.push('_本轮无 ARCHIVE 项。_');
  } else {
    for (const a of archiveEntries.slice().sort((x, y) => x.finding_id.localeCompare(y.finding_id))) {
      lines.push(`- \`${a.sc_id}\`: ${truncate(a.holds, 200)}（README.md 锚点，已登记接受）`);
    }
  }
  lines.push('', SECTION_END);
  return lines.join('\n');
}

// 幂等 upsert：marker 存在 → 整段替换（marker 外的 owner 手写正文原样保留）；
// marker 不存在 → 追加到末尾（首次生成）。
export function upsertInvariantsSection(existingBody, section) {
  const body = existingBody ?? '';
  const startIdx = body.indexOf(SECTION_START);
  const endIdx = body.indexOf(SECTION_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = body.slice(0, startIdx);
    const after = body.slice(endIdx + SECTION_END.length);
    return `${before}${section}${after}`;
  }
  const sep = body.trim().length ? '\n\n' : '';
  return `${body}${sep}${section}\n`;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.artifact || !args['sc-manifest']) {
    fail('用法: pr-body.mjs --artifact <consensus.json> --sc-manifest <sc-manifest.json> [--existing-body <body.txt>]\n输出（stdout）: 幂等替换/追加锚点段后的完整 PR body。');
  }
  const section = buildInvariantsSection({ artifact: readJson(args.artifact), manifest: readJson(args['sc-manifest']) });
  const existing = args['existing-body'] ? readFileSync(args['existing-body'], 'utf8') : '';
  process.stdout.write(`${upsertInvariantsSection(existing, section)}\n`);
}
