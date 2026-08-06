#!/usr/bin/env node
// dispatch-contract.mjs — 派工包机器契约段的**生成器 + 前置门**（D1，2026-08-06）
//
// 它解决的问题（实测事故，不是假想）：
//   四个 canonical gate_id（format-gate / rule-compliance / security-privacy-gate /
//   product-arch-gate）此前**只**存在于 verdict-validate.mjs 的 DEFAULT_REQUIREMENTS，
//   skills/submit-pr/ 全目录 grep 零命中。lead 组第三席派工包时无处抄写 → 第三席自创
//   gate_id → verdict-validate 判 degraded → consensus-gate 连跑都跑不起来 → 整轮三席作废。
//   2026-08-06 实测发生一次。同一家族的前一次是 2026-08-03 的 closed_finding_ids 漏写
//   （SKILL.md 里已专门写了一段警告，代价一次往返），**靠"在文档里再写一遍提醒"这个修法
//   已被证伪**——文档与 validator 常量是两份数据，任何一侧漂移就复发。
//
// 修法：把「派工包必须逐字包含哪些机器字面值」从 validator 常量**派生**，并给两个模式：
//   --emit  <seat>  → 打印机器契约段（lead 原文粘进派工包，无需人抄常量）
//   --check <file>  → 校验派工包文本已逐字包含全部必需字面值（缺一即 exit 1）
// 单一真相源：常量只在 verdict-validate.mjs / hardening-registry.mjs 各一处；本文件不复述。
// 反漂移牙齿：emit 输出携带 contract_digest（spec 的内容 hash），--check 要求该 digest
//   逐字出现且等于**当前**重算值——validator 常量一改，旧 digest 立刻失配，粘贴陈旧契约段
//   会被当场拦下（这是「文档提醒」做不到、也是上一次修法失效的根因）。
//
// 保证等级 T1（防疏忽/防漂移）：它拦的是「lead 手抄漏字段 / 粘旧版契约段」这类真实发生过的
//   疏忽；它**不**保证审查席真的按契约填报（那由 verdict-validate 在收卷时拦），也**不**防
//   恶意伪造派工包文本。如实声明，不冒称。

import { parseArgs, fail, isMain, sha256, canonicalJson } from './lib/common.mjs';
import { DEFAULT_REQUIREMENTS, DEFAULT_ANCHOR_PATHS_MAX } from './verdict-validate.mjs';
import { HARDENING_CLASS_COUNT, HARDENING_CHECKLIST_VERSION } from './lib/hardening-registry.mjs';

export const SEATS = ['claude-adversarial', 'codex-adversarial', 'upstream-preview'];
const ADVERSARIAL = ['claude-adversarial', 'codex-adversarial'];
export const ALL_FACES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

// 契约 spec —— 纯数据，从 validator/registry 常量派生。digest 对它取内容 hash。
export function contractSpec({ seat, round, requirements } = {}) {
  if (!SEATS.includes(seat)) throw new Error(`seat 非法: ${seat}（合法值: ${SEATS.join(' / ')}）`);
  if (!Number.isInteger(round) || round < 1) throw new Error(`round 非法: ${round}（必须是 >=1 的整数）`);
  const req = { ...DEFAULT_REQUIREMENTS, ...(requirements ?? {}) };
  const isAdversarial = ADVERSARIAL.includes(seat);
  // 加固清单穷举只对 round===1 的两个对抗席强制——与 verdict-validate 同一条件，勿各自判断
  const hardeningRequired = isAdversarial && round === 1;
  return {
    contract_version: 'dc1',
    seat,
    round,
    verdict_schema_version: 'v2',
    required_faces: isAdversarial ? [...ALL_FACES] : [...req.third_seat_required_faces],
    faces_exact: isAdversarial, // 对抗席必须恰好七面，第三席只要求覆盖必填面
    required_gate_ids: isAdversarial ? [] : [...req.third_seat_required_gates],
    hardening: hardeningRequired
      ? { required: true, checklist_version: HARDENING_CHECKLIST_VERSION, class_count: HARDENING_CLASS_COUNT }
      : { required: false },
    close_dual_condition: ['status', 'closed_finding_ids'],
    forbidden_finding_fields: ['write_paths', 'allowed_paths'],
    actionable_required_fields: ['invariant', 'family_id'],
    anchor_paths_max_per_finding: DEFAULT_ANCHOR_PATHS_MAX,
    out_of_scope_channel: 'out_of_scope_notes'
  };
}

export function contractDigest(spec) {
  return sha256(canonicalJson(spec));
}

// 必须逐字出现在派工包文本里的字面值。**由 spec 派生，不手写清单**——
// validator 常量新增一个 gate_id，本函数与 emit 同时自动跟上（fixture [D1-DC] 锁住这条）。
export function requiredLiterals({ seat, round, requirements } = {}) {
  const spec = contractSpec({ seat, round, requirements });
  const lits = [
    spec.seat,
    `schema_version: "${spec.verdict_schema_version}"`,
    'anchor_paths',
    ...spec.close_dual_condition,
    ...spec.actionable_required_fields,
    ...spec.forbidden_finding_fields,
    spec.out_of_scope_channel,
    spec.required_faces.join('/'),
    ...spec.required_gate_ids,
    `contract_digest=${contractDigest(spec)}`
  ];
  if (!spec.required_gate_ids.length) lits.push('faces');
  else lits.push('gate_checks');
  if (spec.hardening.required) {
    lits.push('hardening_coverage', `checklist_version: ${spec.hardening.checklist_version}`, `恰好 ${spec.hardening.class_count} 项`);
  }
  return [...new Set(lits)];
}

export function emitContract({ seat, round, requirements } = {}) {
  const spec = contractSpec({ seat, round, requirements });
  const digest = contractDigest(spec);
  const L = [];
  L.push(`<!-- pr-autopilot:dispatch-contract seat=${spec.seat} round=${spec.round} contract_digest=${digest} -->`);
  L.push(`### 机器契约段（脚本生成，勿手改；改一个字 digest 即失配被前置门拦下）`);
  L.push('');
  L.push(`- reviewer: \`${spec.seat}\`；round: \`${spec.round}\`；verdict \`schema_version: "${spec.verdict_schema_version}"\`（schemas/review-verdict.schema.json）。`);
  if (spec.faces_exact) {
    L.push(`- faces：必须**恰好七面全填** \`${spec.required_faces.join('/')}\`，每面 result ∈ pass|fail|n_a 且 evidence 非空（空结果 ≠ pass）。`);
  } else {
    L.push(`- faces：必须覆盖必填面 \`${spec.required_faces.join('/')}\`（可多填），每面 evidence 非空。`);
  }
  if (spec.required_gate_ids.length) {
    L.push(`- \`gate_checks[]\`：**必须逐字包含以下全部 gate_id**（缺任一 = fail-open，verdict-validate 直接判 degraded，整轮作废）：`);
    for (const g of spec.required_gate_ids) L.push(`  - \`${g}\``);
    L.push(`  每条 result ∈ pass|fail|n_a 且 evidence 非空；存在 fail 时总 verdict 必须 REQUIRES_CHANGES。`);
  }
  if (spec.hardening.required) {
    L.push(`- 加固清单穷举（本席本轮强制）：\`checklist_version: ${spec.hardening.checklist_version}\` + \`hardening_coverage\` **恰好 ${spec.hardening.class_count} 项**，class_id 1〜${spec.hardening.class_count} 各恰好一次，result ∈ covered|n_a，evidence 非空。逐条扫 references/hardening-checklist.md，不是"看到什么报什么"。`);
  }
  L.push(`- 每条 finding 必填 \`anchor_paths\`：仓库相对精确文件路径（POSIX、非目录、去重、≤ ${spec.anchor_paths_max_per_finding} 条），且**必须落在 base..candidate 实改文件集内**。它是证据锚点，**不是写入许可**。`);
  L.push(`- actionable（blocker/major）finding 另必填 \`${spec.actionable_required_fields.join('` + `')}\`；同一 family_id 下 invariant 必须逐字一致。`);
  L.push(`- finding 上**禁止**出现 \`${spec.forbidden_finding_fields.join('\` / \`')}\`（出现即结构性拒收）。`);
  L.push(`- **关 finding 是双条件**：该 finding 的 \`status\` 置为 \`closed\` **且**它的 id 必须出现在同一份 verdict 的 \`closed_finding_ids\` 数组里。只翻 status 不列 id → verdict-validate 给 exit 0，但 consensus-gate conjunct② 必拒（2026-08-03 实测，白跑一次往返）。`);
  L.push(`- diff 之外的真问题（仓库既有问题等）**不要塞进 finding 的 anchor_paths**（会被实改集校验拒），写进 \`${spec.out_of_scope_channel}[]\`：每条 \`{id, note, evidence, suggested_issue_title, ref_paths?}\`，走 Phase 2c 意见三分法的「推」通道（开 issue 跟踪）。该字段不进共识判定、不进 SC 台账。`);
  L.push('');
  return `${L.join('\n')}\n`;
}

// 返回 {ok, missing[]}。substring 逐字匹配——派工包是自由文本，不做结构解析。
export function checkDispatchPackage(text, { seat, round, requirements } = {}) {
  const body = String(text ?? '');
  const missing = requiredLiterals({ seat, round, requirements }).filter((lit) => !body.includes(lit));
  return { ok: missing.length === 0, missing };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const USAGE = ' 用法:\n'
    + '  dispatch-contract.mjs --emit <seat> --round <n>\n'
    + '  dispatch-contract.mjs --check <派工包文本文件> --seat <seat> --round <n>\n'
    + `  seat ∈ ${SEATS.join(' | ')}`;
  const round = args.round === undefined ? NaN : Number(args.round);
  try {
    if (args.emit) {
      process.stdout.write(emitContract({ seat: args.emit, round }));
    } else if (args.check) {
      const { readFileSync } = await import('node:fs');
      const r = checkDispatchPackage(readFileSync(args.check, 'utf8'), { seat: args.seat, round });
      if (!r.ok) {
        for (const m of r.missing) process.stderr.write(`[DISPATCH-CONTRACT-FAIL] 派工包缺必需字面值: ${m}\n`);
        process.stderr.write(`[DISPATCH-CONTRACT] 共缺 ${r.missing.length} 项——用 --emit ${args.seat} --round ${round} 生成契约段原文粘贴，勿手抄\n`);
        process.exit(1);
      }
      process.stdout.write(`DISPATCH-CONTRACT-OK seat=${args.seat} round=${round}\n`);
    } else {
      fail(USAGE);
    }
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
}
