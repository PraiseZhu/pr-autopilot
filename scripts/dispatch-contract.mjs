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

import { parseArgs, fail, isMain, sha256, canonicalJson, readJson } from './lib/common.mjs';
import {
  DEFAULT_REQUIREMENTS,
  DEFAULT_ANCHOR_PATHS_MAX,
  SCHEMA_VERSION,
  ATTEMPT_MIN,
  HARDENING_NA_EVIDENCE_MIN_LENGTH,
  REVIEWERS,
  ADVERSARIAL,
  FACES,
  OUT_OF_SCOPE_NOTES_FIELD,
  deriveKnownFamilies
} from './verdict-validate.mjs';
import { HARDENING_CLASS_COUNT, HARDENING_CHECKLIST_VERSION } from './lib/hardening-registry.mjs';

// R2-P1（lead 实测发现的复发风险）: verdict_schema_version / attempt 下限 / hardening_coverage
// [n_a].evidence 最小长度、合法 seat 名单（=REVIEWERS）、对抗席分类（ADVERSARIAL）、七面枚举
// （=FACES）——全部改为从 verdict-validate.mjs import，不再各自读 schema 或手拄第二份数组。
// verdict-validate.mjs 是这些值唯一的物理派生/声明点（前三者它自己从
// schemas/review-verdict.schema.json 派生并 export；后两者是业务分类/枚举，同样由它 export，
// 不再区分"能不能从 schema 派生"——治同一个病就治干净，不留同形状残留）。本文件此前独立读
// schema 派生前三者、又各自手拄 SEATS/ADVERSARIAL/ALL_FACES 三个数组——「一处派生 + 一处手拄」
// 在真相源变化时会自动产生新的不一致，比原来的「两处手拄」更危险（emit 侧跟着真相源变了，
// check/validator 侧不跟，审查席按新契约交卷反而在收卷时被拒）。改成单一物理读取/声明点后，
// 这类复发在构造上不可能再发生。
export const SEATS = REVIEWERS;
export const ALL_FACES = FACES;

// SC-R3-F5（R3-field，2026-08-07）: out_of_scope_channel 此前在本文件独立手拄字面值
// 'out_of_scope_notes'，与 verdict-validate.mjs 里 `v.out_of_scope_notes` 的实际读取点是两份
// 独立数据——同一形状的「一处派生 + 一处手拄」复发风险（同上方 SEATS/ALL_FACES 的治法）。改为
// import verdict-validate.mjs 导出的 OUT_OF_SCOPE_NOTES_FIELD，不再自己手写。

// issue #9 SC-C（状态模型矛盾修复）：「答」「推」两种处置不再走 status=closed + closed_finding_ids
// 双条件——那双条件专属仍留在 findings[] 里的「修」「ARCHIVE」两种载体。这两条字面值直接进
// requiredLiterals，反漂移方式与其余字面值一致：改这两个常量，emit/check 自动跟上。
export const ANSWERED_WITHDRAW_LITERAL = '「答」disposition 须整条撤出 findings，不得只翻 status';
export const DEFERRED_UNIFIED_LITERAL = '「推」disposition 不分 diff 内外统一进 out_of_scope_notes';

// 契约 spec —— 纯数据，从 validator/registry 常量派生。digest 对它取内容 hash。
export function contractSpec({ seat, round, requirements, parentArtifact } = {}) {
  if (!SEATS.includes(seat)) throw new Error(`seat 非法: ${seat}（合法值: ${SEATS.join(' / ')}）`);
  if (!Number.isInteger(round) || round < 1) throw new Error(`round 非法: ${round}（必须是 >=1 的整数）`);
  const req = { ...DEFAULT_REQUIREMENTS, ...(requirements ?? {}) };
  const isAdversarial = ADVERSARIAL.includes(seat);
  // SC-T7b（SC-2）: known families 权威只来自同一谱系 parentArtifact.canonical_findings
  // （deriveKnownFamilies，verdict-validate.mjs 唯一实现）——round=1（无 parent）→ null
  // （空集合语义，reuse 必拒）；round>=2 传 parent 时从 parent 现场派生排序去重。不创建
  // state-dir 历史注册表（SC-2 明确禁止）——永远现场派生，无持久化、无跨 PR 全局历史（SC-4）。
  const knownFamilies = parentArtifact ? deriveKnownFamilies(parentArtifact) : null;
  // issue #9: 加固清单穷举适用范围已扩大到「对抗席全 round」（i9-verdict 移除了
  // verdict-validate.mjs 里的 `&& v.round === 1` 限制）——本行必须与之同条件，勿各自判断。
  // 不改会造成 R2+ 派工契约不要求填 hardening_coverage，审查席老实交卷却被 validator 拒收，
  // 整轮三席作废（同 D1 头部注释描述的 gate_id 事故是同一类形状：契约与 validator 各念各的经）。
  const hardeningRequired = isAdversarial;
  return {
    contract_version: 'dc1',
    seat,
    round,
    verdict_schema_version: SCHEMA_VERSION,
    attempt_min: ATTEMPT_MIN,
    required_faces: isAdversarial ? [...ALL_FACES] : [...req.third_seat_required_faces],
    faces_exact: isAdversarial, // 对抗席必须恰好七面，第三席只要求覆盖必填面
    required_gate_ids: isAdversarial ? [] : [...req.third_seat_required_gates],
    hardening: hardeningRequired
      ? {
          required: true,
          checklist_version: HARDENING_CHECKLIST_VERSION,
          class_count: HARDENING_CLASS_COUNT,
          na_evidence_min_length: HARDENING_NA_EVIDENCE_MIN_LENGTH
        }
      : { required: false },
    close_dual_condition: ['status', 'closed_finding_ids'],
    forbidden_finding_fields: ['write_paths', 'allowed_paths'],
    actionable_required_fields: ['invariant', 'family_id'],
    anchor_paths_max_per_finding: DEFAULT_ANCHOR_PATHS_MAX,
    out_of_scope_channel: OUT_OF_SCOPE_NOTES_FIELD,
    // SC-T7b（SC-2）: known_families 进 spec → 进 contract_digest——parent 的 family 集合一变，
    // 旧契约段 digest 立刻失配，被 --check 前置门当场拦下（反漂移牙齿，与其余 spec 字段同一机制）。
    // known_families_digest 是对家族集合（排序去重后的 {family_key, invariant} 列表）内容 hash，
    // 供正文校验用；round=1（null）时两者都为 null，契约声明「无 known families，reuse 必拒」。
    known_families: knownFamilies,
    known_families_digest: knownFamilies
      ? sha256(canonicalJson(knownFamilies))
      : null
  };
}

export function contractDigest(spec) {
  return sha256(canonicalJson(spec));
}

// 必须逐字出现在派工包文本里的字面值。**由 spec 派生，不手写清单**——
// validator 常量新增一个 gate_id，本函数与 emit 同时自动跟上（fixture [D1-DC] 锁住这条）。
export function requiredLiterals({ seat, round, requirements, parentArtifact } = {}) {
  const spec = contractSpec({ seat, round, requirements, parentArtifact });
  const lits = [
    spec.seat,
    `schema_version: "${spec.verdict_schema_version}"`,
    'attempt',
    'anchor_paths',
    ...spec.close_dual_condition,
    ...spec.actionable_required_fields,
    ...spec.forbidden_finding_fields,
    spec.out_of_scope_channel,
    spec.required_faces.join('/'),
    ...spec.required_gate_ids,
    ANSWERED_WITHDRAW_LITERAL,
    DEFERRED_UNIFIED_LITERAL,
    `contract_digest=${contractDigest(spec)}`
  ];
  if (!spec.required_gate_ids.length) lits.push('faces');
  else lits.push('gate_checks');
  if (spec.hardening.required) {
    lits.push(
      'hardening_coverage',
      `checklist_version: ${spec.hardening.checklist_version}`,
      `恰好 ${spec.hardening.class_count} 项`,
      '路径:行号',
      `${spec.hardening.na_evidence_min_length} 字符`
    );
  }
  // SC-T7b: family_claim 契约字面值——kind/target_family_key/reason 三键 + digest 绑定。
  // known_families_digest 逐字出现 → 契约段携带的家族集合与当前 parent 现场派生结果一致；
  // parent 一变 → digest 失配 → --check 拦下旧契约段（同 contract_digest 的机制）。
  lits.push('family_claim', 'kind', 'target_family_key', 'reason', 'fk1-');
  if (spec.known_families_digest) lits.push(`known_families_digest=${spec.known_families_digest}`);
  return [...new Set(lits)];
}

export function emitContract({ seat, round, requirements, parentArtifact } = {}) {
  const spec = contractSpec({ seat, round, requirements, parentArtifact });
  const digest = contractDigest(spec);
  const L = [];
  L.push(`<!-- pr-autopilot:dispatch-contract seat=${spec.seat} round=${spec.round} contract_digest=${digest} -->`);
  L.push(`### 机器契约段（脚本生成，勿手改；改一个字 digest 即失配被前置门拦下）`);
  L.push('');
  L.push(`- reviewer: \`${spec.seat}\`；round: \`${spec.round}\`；verdict \`schema_version: "${spec.verdict_schema_version}"\`（schemas/review-verdict.schema.json）。`);
  L.push(`- verdict 顶层必填 \`attempt\`（整数 ≥ ${spec.attempt_min}；当前 round 内第几次审查尝试，三席须一致——一致性由 consensus-gate 核对，本契约只锁「必须填」）。`);
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
    L.push(`  \`evidence\` 按 \`result\` 分支，不是同一句话：\`covered\`（声称已覆盖）必须给出「路径:行号」形态引用（如 \`scripts/foo.mjs:42\`），声称覆盖就要指出在哪覆盖的，不许空话；\`n_a\`（声称不适用）不要求路径:行号——不适用的类没有对应代码位置，强制会逼你编造假锚点——但 evidence 长度须 ≥ ${spec.hardening.na_evidence_min_length} 字符（防"无"/"n/a"这类敷衍）。`);
  }
  L.push(`- 每条 finding 必填 \`anchor_paths\`：仓库相对精确文件路径（POSIX、非目录、去重、≤ ${spec.anchor_paths_max_per_finding} 条），且**必须落在 base..candidate 实改文件集内**。它是证据锚点，**不是写入许可**。`);
  L.push(`- actionable（blocker/major）finding 另必填 \`${spec.actionable_required_fields.join('` + `')}\`；同一 family_id 下 invariant 必须逐字一致。`);
  // SC-T7b（SC-2/SC-4）: family_claim 契约段——正文列 family_key+invariant 与 digest。
  // 机器只证明「引用本谱系存在族」，不判「这个 reuse 判断对不对」的语义（SC-4）——那是审查席
  // 的判断；只覆盖同一 artifact 谱系（parent 链），不冒充跨 PR 全局历史（SC-4）。
  if (spec.known_families) {
    L.push(`- **每条 actionable finding 必填 \`family_claim\`**（SC-T7b）：二选一——\`{kind:'reuse', target_family_key:'fk1-...'}\`（复用**上一轮真实问题族**，key 必须在本契约下方 known families 清单内）或 \`{kind:'new', reason:'非空'}\`（新问题，reason 不得为空串）。suggestion 不要求。inner exact keys——reuse 不得带 reason、new 不得带 target_family_key、未知键一律拒（verdict-validate fail-closed）。`);
    L.push(`  上一轮 known families（权威 = parentArtifact.canonical_findings 现场派生，排序去重；\`known_families_digest=${spec.known_families_digest}\`）：`);
    for (const kf of spec.known_families) {
      L.push(`  - \`${kf.family_key}\` — ${kf.invariant}`);
    }
    L.push(`  机器只证明这些 family_key 在本谱系存在（reuse 引用它们才合法），**不判语义**——「这个 reuse 判断对不对」是审查席的判断，机器不裁决。`);
    L.push(`  只覆盖同一 artifact 谱系（parent 链），不冒充跨 PR 全局历史（SC-4）——known families 从 parent 现场派生，无历史注册表。`);
  } else {
    L.push(`- **每条 actionable finding 必填 \`family_claim\`**（SC-T7b）：二选一——\`{kind:'reuse', target_family_key:'fk1-...'}\`（复用**上一轮真实问题族**）或 \`{kind:'new', reason:'非空'}\`（新问题，reason 不得为空串）。suggestion 不要求。inner exact keys——reuse 不得带 reason、new 不得带 target_family_key、未知键一律拒（verdict-validate fail-closed）。**本轮是 round=1（谱系根，无 parent）——known families 为空，\`kind:'reuse'\` 必拒**；只能声明 \`kind:'new'\`。`);
  }
  L.push(`- finding 上**禁止**出现 \`${spec.forbidden_finding_fields.join('\` / \`')}\`（出现即结构性拒收）。`);
  L.push(`- **关 finding 是双条件**（仅适用于「修」「ARCHIVE」两类仍留在 findings[] 里的处置）：该 finding 的 \`status\` 置为 \`closed\` **且**它的 id 必须出现在同一份 verdict 的 \`closed_finding_ids\` 数组里。只翻 status 不列 id → verdict-validate 给 exit 0，但 consensus-gate conjunct② 必拒（2026-08-03 实测，白跑一次往返）。`);
  L.push(`- ${ANSWERED_WITHDRAW_LITERAL}——本席若认可 lead 的证据回复（Phase 2c 意见三分法「答」），在下一份 verdict 里**不要**把该 finding 留在 \`findings[]\` 里改 \`status\`：直接删掉该条目。留着改 status 会撞上一条的双条件，把本不该进 canonical 的 finding 又送进 \`canonical_findings\`。`);
  L.push(`- ${DEFERRED_UNIFIED_LITERAL}：Phase 2c 意见三分法判定为「推」（范围外真问题，默认外推）的 finding——不论主证据落在 diff 内还是 diff 外——都**不要塞进** \`findings[]\` 的 \`anchor_paths\`（diff 外的会被实改集校验直接拒收），改写进 \`${spec.out_of_scope_channel}[]\`：每条 \`{id, note, evidence, suggested_issue_title, ref_paths?}\`，走开 issue 跟踪。该字段不进共识判定、不进 SC 台账。`);
  L.push('');
  return `${L.join('\n')}\n`;
}

// 返回 {ok, missing[]}。substring 逐字匹配——派工包是自由文本，不做结构解析。
export function checkDispatchPackage(text, { seat, round, requirements, parentArtifact } = {}) {
  const body = String(text ?? '');
  const missing = requiredLiterals({ seat, round, requirements, parentArtifact }).filter((lit) => !body.includes(lit));
  return { ok: missing.length === 0, missing };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const USAGE = ' 用法:\n'
    + '  dispatch-contract.mjs --emit <seat> --round <n> [--parent <parent-artifact.json>]\n'
    + '  dispatch-contract.mjs --check <派工包文本文件> --seat <seat> --round <n> [--parent <parent-artifact.json>]\n'
    + `  seat ∈ ${SEATS.join(' | ')}\n`
    + '  --parent 可选（SC-T7b）: round>=2 时传上一轮 consensus artifact，known families 现场派生进契约段（含 digest）；round=1 不传（谱系根，reuse 必拒）。';
  const round = args.round === undefined ? NaN : Number(args.round);
  try {
    // sc-29b（#21 附带 emit 漏 --parent）: round>=2 且未传 --parent → CLI fail-closed。
    // 此前 parentArtifact 落到 null → knownFamilies=null，契约段被静默降级成 round=1 谱系根
    // 语义——known families 与 digest 缺失，lead 照抄进派工包后第三席交卷 reuse 必被拒，
    // 整轮作废（同 D1 头部注释 gate_id 事故的同一形状：契约与语义各念各的经）。
    // 只有 round=1（谱系根）才允许不传 --parent。
    // round 非整数（如 --round 2.5）不在此拦——那是 contractSpec 自己的"round 非法"职责，
    // 抢先在这里报「缺 --parent」会把用户导向错诊断（补了 --parent 还是会在下一步撞 round 校验）。
    if (Number.isInteger(round) && round >= 2 && !args.parent) {
      fail(`--round ${round} 必须传 --parent <parent-artifact.json>（known families 从 parent 现场派生）；只有 round=1（谱系根）才允许不传 --parent。\n${USAGE}`);
    }
    if (args.emit) {
      process.stdout.write(emitContract({ seat: args.emit, round, parentArtifact: args.parent ? readJson(args.parent) : null }));
    } else if (args.check) {
      const { readFileSync } = await import('node:fs');
      const r = checkDispatchPackage(readFileSync(args.check, 'utf8'), { seat: args.seat, round, parentArtifact: args.parent ? readJson(args.parent) : null });
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
