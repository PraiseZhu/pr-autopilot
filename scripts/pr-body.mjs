#!/usr/bin/env node
// PR body 不变量锚点 — SC-B2（依赖 SC-B1 的 invariant/family_key 数据契约）
// 从 sc-manifest + consensus artifact 生成一段 marker 包围的幂等段落，插入/替换进 PR body：
//   MUST-FIX: 按 family_key（内容派生身份，不是 family_id 本地标签，D1）去重列 invariant +
//             全部 manifestation（sc_id + anchor_paths）
//   ARCHIVE:  列残余风险 + 接受理由 + README.md 锚点——措辞是「已登记接受」，不是「已修复」
// 不外泄敏感路径/证据原文（D2 对齐）：只列 anchor_paths（三审本就公开产出的锚点）与
// invariant/holds 的截断摘要，不列 finding.evidence 全文（可能含内部上下文）。
//
// 关键时序（SC-B2）：scripts/review-input-hash.mjs 已把 pr_body 纳入审查输入 hash——本段
// 必须在**最终 delta review 之前**生成进 body，三席审的就是含锚点段的 body；Phase 3
// create/edit PR 只能提交已审同 hash 的 body。已存在 PR 时只替换 marker 段、保留 owner
// 手写正文；审后若 body 漂移（marker 段之外的文字被改，或再次生成后 hash 不同）→ 视为
// 输入变更，必须重审（不是「反正是自动生成的段落，可以随时重刷」）。
//
// D4（gpt 终审阻断修复）: 原子收敛检查点（references/convergence-checkpoint.md）的六件套
// 产出也要进 PR body，但它是**独立于**上面 MUST-FIX/ARCHIVE 锚点段的另一份内容——两者若共用
// 同一对 marker，任何一方重新生成都会把另一方整段吃掉（旧契约的矛盾: convergence-checkpoint.md
// 与 SKILL.md 都说六件套"进 checkpoint marker 段"，但 buildInvariantsSection 只认自己的
// MUST-FIX/ARCHIVE 内容，手工塞进同一对 marker 的六件套下一轮 upsert 就被整段覆盖）。
// 解法：六件套用**自己独立的第二对 marker**，独立 upsert，互不覆盖。
import { readFileSync } from 'node:fs';
import { readJson, parseArgs, fail, isMain } from './lib/common.mjs';

export const SECTION_START = '<!-- pr-autopilot:invariants:start -->';
export const SECTION_END = '<!-- pr-autopilot:invariants:end -->';
export const CHECKPOINT_SECTION_START = '<!-- pr-autopilot:checkpoint:start -->';
export const CHECKPOINT_SECTION_END = '<!-- pr-autopilot:checkpoint:end -->';

function truncate(s, n = 200) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function countOccurrences(haystack, needle) {
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

// 幂等 upsert 的通用实现（D4）：marker 恰好一对（start 恰好 1 次、end 恰好 1 次、end 在
// start 之后）→ 整段替换；两者都不存在 → 追加到末尾（首次生成）；**任何其它形态**——只有
// start、只有 end、start/end 出现 ≥2 次、end 出现在 start 之前——一律 fail loud 拒绝写入，
// 不得静默追加第二段（那会让文档里堆出重复/半残内容，且掩盖了 body 已经损坏的事实）。
function safeUpsertSection(existingBody, start, end, section, label) {
  const body = existingBody ?? '';
  const startCount = countOccurrences(body, start);
  const endCount = countOccurrences(body, end);
  if (startCount === 0 && endCount === 0) {
    const sep = body.trim().length ? '\n\n' : '';
    return `${body}${sep}${section}\n`;
  }
  if (startCount === 1 && endCount === 1) {
    const startIdx = body.indexOf(start);
    const endIdx = body.indexOf(end);
    if (endIdx <= startIdx) {
      throw new Error(`${label}: marker 顺序损坏（end 出现在 start 之前或与 start 重合），拒绝写入——请人工修复现有 body 后重试，不得静默追加第二段`);
    }
    const before = body.slice(0, startIdx);
    const after = body.slice(endIdx + end.length);
    return `${before}${section}${after}`;
  }
  throw new Error(`${label}: marker 残缺/重复（start 出现 ${startCount} 次，end 出现 ${endCount} 次，期望两者都恰好 0 或都恰好 1 次），拒绝写入——半残 marker（只有 start 或只有 end）或重复 marker 不得被当作「找不到就追加」处理`);
}

// 纯函数：不读文件、不落盘——由 CLI/调用方决定 existing body 从哪来、结果写到哪。
export function buildInvariantsSection({ artifact, manifest }) {
  const canonical = artifact?.canonical_findings ?? [];
  const scsByFinding = new Map();
  for (const sc of manifest?.scs ?? []) {
    if (sc.kind === 'global') continue;
    for (const fid of sc.finding_ids ?? []) scsByFinding.set(fid, sc);
  }

  // MUST-FIX 侧：按 family_key 去重——同一不变量只列一次 invariant 文本，manifestation 全列。
  // D1: 分组键必须是 family_key（内容派生），不是 family_id（reviewer 席内本地标签，两个不同
  // reviewer 可能各自合法地把同一标签用来指不同的不变量，按标签去重会把不相关的不变量文本
  // 错误合一，PR body 只显示第一个——gpt 终审实测复现的阻断项）。
  const families = new Map(); // family_key -> { invariant, manifestations: [] }
  const archiveEntries = [];
  for (const f of canonical) {
    const sc = scsByFinding.get(f.id);
    if (!sc) continue; // 未被任何 SC 覆盖（suggestion 级常见）——不进 body，不是遗漏
    if (sc.kind === 'archive') {
      archiveEntries.push({ finding_id: f.id, sc_id: sc.id, holds: sc.holds, anchor_paths: f.anchor_paths ?? [] });
      continue;
    }
    if (!f.family_key) continue; // 防御性跳过（actionable finding 理论上都已归族，B1 强制）
    if (!families.has(f.family_key)) families.set(f.family_key, { invariant: f.invariant, manifestations: [] });
    families.get(f.family_key).manifestations.push({ finding_id: f.id, sc_id: sc.id, kind: sc.kind, anchor_paths: f.anchor_paths ?? [] });
  }

  const lines = [SECTION_START, ''];
  lines.push('### MUST-FIX（本轮共识确认，按不变量归族去重）', '');
  if (families.size === 0) {
    lines.push('_本轮无 MUST-FIX 项。_');
  } else {
    for (const [familyKey, fam] of [...families.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`- **${truncate(fam.invariant, 120)}**（family_key=\`${familyKey}\`）`);
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

// 幂等 upsert：marker 存在 → 整段替换（marker 外的 owner 手写正文原样保留，含另一对
// checkpoint marker——两对 marker 各自独立 upsert，互不覆盖）；marker 不存在 → 追加到末尾。
export function upsertInvariantsSection(existingBody, section) {
  return safeUpsertSection(existingBody, SECTION_START, SECTION_END, section, 'pr-autopilot:invariants');
}

// D4: 原子收敛检查点六件套渲染（references/convergence-checkpoint.md）。纯函数，不判断
// 「六件套是否齐全」——那是 lead 在派工/收口时的过程纪律（convergence-checkpoint.md D1
// 原子性要求），本函数只负责把已产出的结构化内容渲染成人可读的 markdown，齐全与否不是
// 渲染器的职责；六个键都不给也能渲染（会显示为"未提供"），但**不代表**这满足了 D1 的
// 原子性要求。
// checkpoint 结构对应六件套：
//   invariants: [{family, statement}]                     — 1) 每个失败族一句话可判定不变量
//   state_owners: [{field, owner, lifecycle}]              — 2) 每个状态字段的唯一写入 owner
//   event_state_matrix: [{event, state, action, reason}]  — 3) 事件×状态矩阵
//   symmetry_audit: [{path, status, note}]                 — 4) 对称路径审计
//   normalization: [{semantic, consolidated_to}]           — 5) 判据归一
//   tests: [{name, distinguishes}]                         — 6) 可鉴别交错测试
export function buildCheckpointSection(checkpoint) {
  const cp = checkpoint ?? {};
  const lines = [CHECKPOINT_SECTION_START, ''];
  lines.push('### 原子收敛检查点（六件套）', '');
  if (cp.trigger) lines.push(`**触发条件**: ${truncate(cp.trigger, 200)}`, '');

  lines.push('**1. 失败族不变量**', '');
  if (!(cp.invariants ?? []).length) lines.push('_未提供。_');
  else for (const i of cp.invariants) lines.push(`- ${truncate(i.family, 60)}: ${truncate(i.statement, 160)}`);

  lines.push('', '**2. 状态字段写入 owner**', '');
  if (!(cp.state_owners ?? []).length) lines.push('_未提供。_');
  else for (const o of cp.state_owners) lines.push(`- \`${o.field}\` → ${o.owner}（${truncate(o.lifecycle, 100)}）`);

  lines.push('', '**3. 事件 × 状态矩阵**', '');
  if (!(cp.event_state_matrix ?? []).length) lines.push('_未提供。_');
  else for (const m of cp.event_state_matrix) lines.push(`- [${m.event} × ${m.state}] ${m.action}: ${truncate(m.reason, 120)}`);

  lines.push('', '**4. 对称路径审计**', '');
  if (!(cp.symmetry_audit ?? []).length) lines.push('_未提供。_');
  else for (const s of cp.symmetry_audit) lines.push(`- ${s.path}: ${s.status}${s.note ? `（${truncate(s.note, 100)}）` : ''}`);

  lines.push('', '**5. 判据归一**', '');
  if (!(cp.normalization ?? []).length) lines.push('_未提供。_');
  else for (const n of cp.normalization) lines.push(`- ${truncate(n.semantic, 80)} → \`${n.consolidated_to}\``);

  lines.push('', '**6. 可鉴别交错测试**', '');
  if (!(cp.tests ?? []).length) lines.push('_未提供。_');
  else for (const t of cp.tests) lines.push(`- \`${t.name}\`: ${truncate(t.distinguishes, 160)}`);

  lines.push('', CHECKPOINT_SECTION_END);
  return lines.join('\n');
}

export function upsertCheckpointSection(existingBody, section) {
  return safeUpsertSection(existingBody, CHECKPOINT_SECTION_START, CHECKPOINT_SECTION_END, section, 'pr-autopilot:checkpoint');
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.artifact || !args['sc-manifest']) {
    fail('用法: pr-body.mjs --artifact <consensus.json> --sc-manifest <sc-manifest.json> [--existing-body <body.txt>] [--checkpoint-json <checkpoint.json>]\n输出（stdout）: 幂等替换/追加锚点段（+可选独立的检查点段）后的完整 PR body。');
  }
  const section = buildInvariantsSection({ artifact: readJson(args.artifact), manifest: readJson(args['sc-manifest']) });
  const existing = args['existing-body'] ? readFileSync(args['existing-body'], 'utf8') : '';
  let body = upsertInvariantsSection(existing, section);
  if (args['checkpoint-json']) {
    body = upsertCheckpointSection(body, buildCheckpointSection(readJson(args['checkpoint-json'])));
  }
  process.stdout.write(`${body}\n`);
}
