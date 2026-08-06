#!/usr/bin/env node
// pr-format-gate.mjs — PR 标题/正文模板合规的**确定性预检**（D2，2026-08-06）
//
// 它解决的问题（实测死锁，不是假想）：
//   「PR 正文缺一个 `## 备注`」此前只能由第三席在 Phase 2 判 `format-gate=fail`，而
//   consensus-gate conjunct④ 要求全部 gate_checks ∈ {pass, n_a} → 共识永不 PASS →
//   **不写 artifact**（实跑确认：gate_result=fail 时 CLI 根本不 writeJsonAtomic）→
//   Phase 2b/2c 的 sc-coverage-gate --artifact 与 fix-run init --source-artifact 是硬依赖，
//   参数层就跑不起来 → 唯一出路是改 PR 正文，而 pr_body 在 review-input-hash 的 REQUIRED
//   字段里 → hash 变 → 三份 verdict 全作废 → 整轮三席穷举重审。
//   即：少一个标题 = 一轮三席作废，且与 SKILL Phase 2「Round 2+ 只审 delta，禁止重审未改代码」
//   直接矛盾——delta 机制在这条路径上够不着。
//
// 为什么修法是「上移到 Phase 1」而不是「给 gate fail 加补救通道」：
//   ① 它是**纯字符串匹配**，不需要模型判断——放在需要模型的席位上是把确定性判据交给非确定性执行者；
//   ② 机读真相源已存在（目标仓 agent-use/docs/pr-rules.json 的 featureSections/bugfixSections/
//      titleTypes/lightTypes，review-pr 的 context.mjs 已在消费同一份数据）；
//   ③ Phase 1 已有查 PR 正文的步骤（intent-check.mjs 的 marker 双载体一致性），这是同类扩展；
//   ④ fail-fast：Phase 1 修正文的代价是零轮审查，Phase 2 修正文的代价是一整轮三席。
//   任何「给 conjunct④ 开补救口」的方案都要削弱 fail-closed 语义（gate fail 却放行），本仓禁止。
//   本修法**不动** conjunct④、不动 format-gate 这个 gate_id：第三席照旧填报它，只是"缺必填段落"
//   这个具体成因在 Phase 1 就已不可能存在，第三席的 format-gate 回到它该管的语义判断上。
//
// 口径**刻意对齐 review-pr 的 scripts/context.mjs**（第三席的职责就是预演 review-pr 的裁决，
//   口径一致才是正确性判据；那是另一个仓 PraiseZhu/Review-PR，本仓只读其口径不改它）：
//   - 段落存在性用标题锚定 `^#{1,6}\s+.*<段落名>`（im），**不做全文 substring**——段落名短
//     （如「备注」），全文 includes 会被正文里的普通词句误命中，硬判层就失去拦截力。
//   - template 选择：type==='fix' → bugfixSections；type ∈ lightTypes → light（**不查段落**）；
//     其余 → featureSections。
//   - title type / 含糊词 / self-review 勾选率：逐字复刻其 `formatIssues` 硬判集（见下方常量注释）。
//   刻意**未**复刻 loopPrExclusion 的前缀剥离：submit-pr 产出的 PR 从不是 loop 托管 PR
//   （loop 是另一条链），此处不引入用不到的分支。若将来 submit-pr 要给 loop 开 PR，需补。
//
// ⚠ **对齐范围如实声明**（2026-08-06 裁决席审出初版正则分叉后重写）：本门覆盖 review-pr
//   `formatIssues` 里**仅由 (title, body, 配置) 就能判定**的四项：① title type 形态/白名单；
//   ② title 含糊词黑名单；③ 缺必填段落；④ self-review 勾选率 <80%。**未**覆盖依赖文件路径或
//   外部状态的两项：`hitsUpdater && !bodyHasOwnerOk`（redlinePaths 命中，属另一条待办）与
//   UI 证据缺失（在 review-pr 侧本就是非阻断提醒）。所以本门 PASS **不等于** review-pr 格式门
//   必过——它只保证「缺段落 / 标题不合规 / 含糊标题 / 勾选率不足」这四个成因在 Phase 1 后
//   不再可能存活。别把它读成"格式已完全预演"。
//   初版事故（本文件自己的）：初版把 title 正则写成 `(\([^)]*\))?!?:\s*\S`，比 review-pr 的
//   `(\([^)]+\))?!?: .+` 宽——`feat(): x` / `feat(scope):x` / `feat:x` 三种在本门 PASS 而
//   review-pr 判 fail，等于 Phase 1 放行、第三席仍判 format-gate=fail → **D2 死锁原地复活**。
//   注释声称"对齐"而无任何东西验证对齐，正是假覆盖。现改为：正则从单一函数派生 + fixture 锁死
//   三个分叉用例 + 一条条件式跨仓对齐探针（review-pr 在场时逐条比对两侧裁决，缺席则如实记 skip）。
//
// 配置源与失败语义（与 size-gate.mjs 同一模式，勿各自发明）：
//   - 从 **merge-base 树** `git show <merge-base>:agent-use/docs/pr-rules.json` 读，绝不读候选
//     工作树——否则被测 PR 自带一份宽配置就能绕闸（size-gate 审 B2-F1 已实测复现过该绕法）。
//   - **真·缺文件**（ref 可解析、ls-tree 确认该路径不存在），或三个键
//     （featureSections/bugfixSections/titleTypes）全缺 → **SKIP**（exit 0）并显式打印原因。
//     这里刻意**不**回退到硬编码段落名：本仓服务多个目标仓，硬编码某一仓的段落名会在其他仓
//     产生假 FAIL（比误放行更糟——它会让人学会忽略这道门）。SKIP 是如实声明「本仓未声明格式
//     契约，本门无判据」，不是"检查过了没问题"。
//   - 键存在但 malformed（类型错/空数组/JSON 坏）→ **fail-closed 抛错**（exit 3），不回退默认。
//   - **任何 git 侧失败**（ref 不可解析 / 非 git 仓 / 路径在但读不出）→ 同样 **fail-closed 抛错**，
//     绝不与"真·缺文件"合流成 SKIP——否则就是把一个错误伪装成"该仓没声明契约"（假 SKIP）。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sha256, canonicalJson, parseArgs, fail, isMain } from './lib/common.mjs';

export const CONFIG_PATH = 'agent-use/docs/pr-rules.json';
// null = 该键未声明（→ 相应检查 SKIP）；[] 是**非法**值（声明了却为空 = 配置错，fail-closed）
export const EMPTY_FORMAT_CONFIG = Object.freeze({ featureSections: null, bugfixSections: null, titleTypes: null, lightTypes: [] });

const STRING_ARRAY_KEYS = ['featureSections', 'bugfixSections', 'titleTypes'];

function readStringArray(rules, key, { allowEmpty }) {
  if (!(key in rules) || rules[key] === null || rules[key] === undefined) return null;
  const v = rules[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new Error(`pr-format-gate: ${key} 必须是非空字符串数组（fail-closed，不回退默认）`);
  }
  if (!allowEmpty && v.length === 0) {
    throw new Error(`pr-format-gate: ${key} 声明了却是空数组（配置错误，fail-closed；不想启用该检查请整键删除）`);
  }
  return [...v];
}

// 返回 {config, source: 'base'|'default'}；malformed 与**任何 git 侧失败**一律 throw（fail-closed）。
//
// 「真·缺文件」与「git 失败」必须分开（2026-08-06 裁决席第三条，实测：初版对
// `git show` 无条件 catch → 坏 ref / 空 ref / 非 git 仓全部静默返回 source=default，
// 即"本门无判据"。CLI 路径当时被前置的 `git merge-base` 挡住了坏 ref，但导出函数直接
// 被调用时无保护，且「merge-base 成功但 show 因权限/坏对象失败」这条路径两边都没挡。
// 后果不是放宽四 conjunct，而是**假 SKIP**：一个本该 fail-closed 的错误被伪装成
// "该仓没声明格式契约"，与本文件自己声明的「SKIP 不是检查通过」直接矛盾）。
// 三步判别，每步的失败语义都不同：
//   ① ref 必须可解析成 tree（rev-parse --verify）——exit 1 = ref 不存在，其他 = 仓库/git 不可用；
//   ② ls-tree 列该路径——exit 0 且**输出为空** = 真·缺文件（唯一允许 SKIP 的情形）；非 0 = 错误；
//   ③ 到这步路径已确认存在，`git show` 再失败就是真错误，不得回退默认。
export function loadFormatConfig(repoDir, ref) {
  const git = (args) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{tree}`]);
  } catch (e) {
    const code = e?.status;
    throw new Error(code === 1
      ? `pr-format-gate: ref「${ref}」无法解析成 tree（base 传错了？fail-closed，不当作"无配置"）`
      : `pr-format-gate: git 不可用或「${repoDir}」不是 git 仓库（fail-closed，不当作"无配置"）: ${String(e?.stderr ?? e.message).trim().slice(0, 200)}`);
  }
  let listed;
  try {
    listed = git(['ls-tree', '--name-only', ref, '--', CONFIG_PATH]);
  } catch (e) {
    throw new Error(`pr-format-gate: 无法列出 ${ref}:${CONFIG_PATH}（fail-closed，不当作"无配置"）: ${String(e?.stderr ?? e.message).trim().slice(0, 200)}`);
  }
  if (!listed.trim()) {
    return { config: { ...EMPTY_FORMAT_CONFIG }, source: 'default' }; // 真·缺文件 → 无判据
  }
  let text;
  try {
    text = git(['show', `${ref}:${CONFIG_PATH}`]);
  } catch (e) {
    throw new Error(`pr-format-gate: ${CONFIG_PATH} 在 ${ref} 里存在却读不出（fail-closed）: ${String(e?.stderr ?? e.message).trim().slice(0, 200)}`);
  }
  let rules;
  try { rules = JSON.parse(text); } catch (e) {
    throw new Error(`pr-format-gate: base 树 ${CONFIG_PATH} 解析失败（fail-closed，不回退默认）: ${e.message}`);
  }
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
    throw new Error(`pr-format-gate: base 树 ${CONFIG_PATH} 顶层必须是对象（fail-closed）`);
  }
  const config = { ...EMPTY_FORMAT_CONFIG };
  for (const k of STRING_ARRAY_KEYS) config[k] = readStringArray(rules, k, { allowEmpty: false });
  config.lightTypes = readStringArray(rules, 'lightTypes', { allowEmpty: true }) ?? [];
  const declared = STRING_ARRAY_KEYS.some((k) => config[k] !== null);
  return { config, source: declared ? 'base' : 'default' };
}

export function formatConfigHash(config) {
  return sha256(canonicalJson({
    featureSections: config.featureSections, bugfixSections: config.bugfixSections,
    titleTypes: config.titleTypes, lightTypes: [...config.lightTypes].sort()
  }));
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 段落存在性：标题锚定（复刻 review-pr context.mjs 口径，见文件头）
export function hasSection(body, heading) {
  return new RegExp(`^#{1,6}\\s+.*${escRe(heading)}`, 'im').test(String(body ?? ''));
}

// title type 形态。**逐字对齐** review-pr `scripts/context.mjs` 的 TITLE_TYPE_RE 源码：
//   new RegExp(`^(${prRules.titleTypes.join('|')})(\\([^)]+\\))?!?: .+`)
// 两个差异点必须原样保持，初版各写错一个就制造了新死锁（见文件头「初版事故」）：
//   ① scope 内容**非空** `[^)]+`（不是 `*`）——`feat(): x` 必须判不合规；
//   ② 冒号后**恰好一个字面空格**再接 `.+`（不是 `\s*\S`）——`feat(scope):x` / `feat:x` 必须判不合规。
// 本侧额外对 type 做了 escRe（review-pr 未做）：titleTypes 实际都是纯单词，编译结果等价；
// 万一将来配置里出现正则元字符，本侧是从严方向，不会比 review-pr 宽。
export function titleTypeRe(titleTypes) {
  return new RegExp(`^(${titleTypes.map(escRe).join('|')})(\\([^)]+\\))?!?: .+`);
}

// 含糊词黑名单。逐字对齐 review-pr context.mjs 的 TITLE_VAGUE_RE。
export const TITLE_VAGUE_RE = /:\s*(bug|update|improve|fix issue|优化|调整|更新|misc|若干|一些)\s*$/i;

// self-review 勾选率。逐字对齐 review-pr context.mjs：段落标题必须命中 /^#+\s*self-review/im，
// 只统计该标题到**下一个标题**之间的复选框（正文别处的普通 TODO 清单不计入分母），
// 门槛 ratio < 0.8 且 total > 0 且段落存在时才算问题。
export function checklistFacts(body) {
  const text = String(body ?? '');
  const heading = text.match(/^#+\s*self-review.*$/im);
  if (!heading) return { has_section: false, total: 0, done: 0, ratio: 0 };
  const rest = text.slice(heading.index + heading[0].length);
  const next = rest.search(/^#{1,6}\s/m);
  const seg = next >= 0 ? rest.slice(0, next) : rest;
  const total = (seg.match(/^\s*- \[[ xX]\]/gm) ?? []).length;
  const done = (seg.match(/^\s*- \[[xX]\]/gm) ?? []).length;
  return { has_section: true, total, done, ratio: total > 0 ? done / total : 0 };
}

export function evaluateFormat({ title, body, config }) {
  const t = String(title ?? '');
  const type = (t.match(/^(\w+)/)?.[1] ?? '').toLowerCase();
  const reasons = [];

  let titleTypeOk = null; // null = 该检查 SKIP（未声明 titleTypes）
  let titleVague = null;
  if (config.titleTypes) {
    titleTypeOk = titleTypeRe(config.titleTypes).test(t);
    if (!titleTypeOk) {
      reasons.push(`标题不符合 \`<type>(<scope>): <描述>\` 形态或 type 不在白名单内（得到 type=${JSON.stringify(type)}；允许: ${config.titleTypes.join(' / ')}；注意 scope 括号内不得为空、冒号后须有一个空格）`);
    }
    titleVague = TITLE_VAGUE_RE.test(t);
    if (titleVague) reasons.push('标题命中含糊词黑名单（结尾是「优化/调整/更新/bug/update/若干」这类词，等于没说改了什么）');
  }

  const isLight = config.lightTypes.includes(type);
  const template = type === 'fix' ? 'bugfix' : isLight ? 'light' : 'feature';
  const declaredFor = template === 'bugfix' ? config.bugfixSections : template === 'feature' ? config.featureSections : null;
  // light 类（chore/docs/ci…）不查段落——与 review-pr 同口径
  const wantSections = template === 'light' ? [] : (declaredFor ?? []);
  const presentSections = wantSections.filter((h) => hasSection(body, h));
  const missingSections = wantSections.filter((h) => !hasSection(body, h));
  if (missingSections.length) {
    reasons.push(`PR 正文缺必填段落标题: ${missingSections.map((h) => `## ${h}`).join(' / ')}（段落存在性用标题锚定，正文里出现同名词句不算）`);
  }

  // self-review 勾选率同样只在非 light 模板下算（与 review-pr 的 `if (template !== 'light')` 同层）
  const checklist = checklistFacts(body);
  if (template !== 'light' && checklist.has_section && checklist.total > 0 && checklist.ratio < 0.8) {
    reasons.push(`Self-review 勾选率 ${checklist.done}/${checklist.total}（<80%，自检没做完）`);
  }

  const sectionsChecked = template !== 'light' && declaredFor !== null;
  const anythingChecked = sectionsChecked || titleTypeOk !== null;
  const result = !anythingChecked ? 'SKIP' : reasons.length ? 'FAIL' : 'PASS';
  return {
    result, title_type: type, title_type_ok: titleTypeOk, title_vague: titleVague, template,
    sections_checked: sectionsChecked,
    want_sections: wantSections, present_sections: presentSections, missing_sections: missingSections,
    checklist,
    reasons,
    config_hash: formatConfigHash(config)
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const repoDir = args['repo-dir'] ?? '.';
  const baseRef = args.base;
  const bodyFile = args['body-file'];
  const title = args.title ?? (args['title-file'] ? readFileSync(args['title-file'], 'utf8').trim() : undefined);
  if (!baseRef || !bodyFile || title === undefined) {
    fail('用法: pr-format-gate.mjs --repo-dir <dir> --base <ref>（如 origin/main）--title <PR 标题>|--title-file <文件> --body-file <PR 正文文件>');
  }
  let out;
  try {
    const mergeBase = execFileSync('git', ['-C', repoDir, 'merge-base', baseRef, 'HEAD'], { encoding: 'utf8' }).trim();
    const { config, source } = loadFormatConfig(repoDir, mergeBase);
    out = { merge_base: mergeBase, config_source: source, config, ...evaluateFormat({ title, body: readFileSync(bodyFile, 'utf8'), config }) };
  } catch (e) { fail(e.message, 3); }
  if (out.result === 'SKIP') {
    out.skip_reason = `base 树 ${CONFIG_PATH} 未声明 featureSections/bugfixSections/titleTypes（本门无判据；这不是"检查通过"）`;
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.result === 'FAIL' ? 1 : 0);
}
