#!/usr/bin/env node
// verdict 结构校验器 — 计划依据: §1.1b ⑨「任何 schema 校验失败一律 degraded，不设灰区」
// 审②-F1 修复: 增加按 reviewer 角色的跨字段约束（fail-closed，不再允许空面/空门通过）:
//   - 两对抗席: faces 必须恰好覆盖 A〜G 七面、无重复
//   - 第三席: 必须覆盖 requiredFaces（默认 D/E/F/G）+ requiredGates（配置化，缺席=degraded）
//   - 任何 face.result=fail → verdict 必须 REQUIRES_CHANGES（不许 fail+APPROVED）
//   - 存在 primary_face=taxonomy_gap 的 finding → run_status 必须 degraded（⑪ 停轮）
//   - bundle.touches_ui=true 时对抗席 B 面禁 n_a（⑫ 脚本判定为唯一源）
// R10-A3 修复: 加固清单覆盖率契约由纯文档承诺变机器强制——round===1 的两个对抗席必须携带
//   hardening_coverage[9]（class_id 1〜9 各恰好一次，result∈{covered,n_a}，evidence 非空）；
//   第三席与 round>=2 不强制（复核轮不重扫穷举面）
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJson, fail, isMain, normalizeRepoPath } from './lib/common.mjs';
import { HARDENING_CLASS_COUNT, HARDENING_CHECKLIST_VERSION } from './lib/hardening-registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// SC-11: anchor_paths 数量上限来自可信配置（与 capacity 同源，owner 亲手改）
export const DEFAULT_ANCHOR_PATHS_MAX = (() => {
  try { return readJson(join(HERE, '../config/orchestration.json')).anchor_paths_max_per_finding ?? 20; }
  catch { return 20; }
})();

// SC-11: base∪candidate 的 tracked 文件集（「这是真文件」判据）
export function trackedPathSet({ repoDir, baseSha, candidateSha }) {
  const set = new Set();
  for (const ref of [baseSha, candidateSha].filter(Boolean)) {
    try {
      const out = execFileSync('git', ['-C', repoDir, 'ls-tree', '-r', '--name-only', ref], { encoding: 'utf8', timeout: 60_000 });
      for (const line of out.split('\n')) if (line.trim()) set.add(line.trim());
    } catch { /* ref 不可得 → 该 ref 不贡献 */ }
  }
  return set;
}

// SC-R3-5①: 被审 diff 的实改文件集——anchor_paths 必须落在其中。
// R3 实证: 仅 tracked 校验时，一个共享 tracked 文件（如 .gitignore）能把 8 条独立 finding
// 合成 1 组。评审锚点指向的是**被审的 diff**；diff 之外的影响面写 scope_note（不进冲突图）。
export function changedPathSet({ repoDir, baseSha, candidateSha }) {
  const out = execFileSync('git', ['-C', repoDir, 'diff', '-z', '--name-only', `${baseSha}...${candidateSha}`], { encoding: 'utf8', timeout: 60_000 });
  return new Set(String(out).split('\0').filter(Boolean));
}

const REVIEWERS = ['claude-adversarial', 'codex-adversarial', 'upstream-preview'];
const ADVERSARIAL = ['claude-adversarial', 'codex-adversarial'];
const FACES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const RESULTS = ['pass', 'fail', 'n_a'];
const SEVERITIES = ['blocker', 'major', 'suggestion'];
const ACTIONABLE_SEVERITIES = ['blocker', 'major'];
const SHA_RE = /^[0-9a-f]{7,40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
// R10-A3/SC-B4: 加固清单类别数与版本单一来源——scripts/lib/hardening-registry.mjs
// （9→10 迁移见 D5：exact 集合变更，不是新增一条 append，因此同步 bump checklist_version）。
const HARDENING_RESULTS = ['covered', 'n_a'];

export const DEFAULT_REQUIREMENTS = {
  third_seat_required_faces: ['D', 'E', 'F', 'G'],
  third_seat_required_gates: ['format-gate', 'rule-compliance', 'security-privacy-gate', 'product-arch-gate']
};

export function validateVerdict(v, opts = {}) {
  const req = { ...DEFAULT_REQUIREMENTS, ...(opts.requirements ?? {}) };
  const bundle = opts.bundle ?? null;
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };

  need(v && typeof v === 'object', 'verdict 不是对象');
  if (errs.length) return errs;
  need(v.schema_version === 'v2', `schema_version 必须为 v2，得到 ${v.schema_version}`);
  need(REVIEWERS.includes(v.reviewer), `reviewer 非法: ${v.reviewer}`);
  need(['ok', 'degraded'].includes(v.run_status), `run_status 非法: ${v.run_status}`);
  need(Number.isInteger(v.round) && v.round >= 1, `round 非法: ${v.round}`);
  need(SHA_RE.test(v.base_sha ?? ''), `base_sha 非法: ${v.base_sha}`);
  need(SHA_RE.test(v.candidate_sha ?? ''), `candidate_sha 非法: ${v.candidate_sha}`);
  need(HASH_RE.test(v.review_input_hash ?? ''), 'review_input_hash 必须是 64 位 hex');
  need(['APPROVED', 'REQUIRES_CHANGES'].includes(v.verdict), `verdict 非法: ${v.verdict}`);
  need(Array.isArray(v.closed_finding_ids), 'closed_finding_ids 必须是数组');
  if (errs.length) return errs;

  // faces 逐项
  need(Array.isArray(v.faces), 'faces 必须是数组');
  const seenFaces = new Set();
  for (const f of v.faces ?? []) {
    need(FACES.includes(f.face), `faces.face 非法: ${f.face}`);
    need(!seenFaces.has(f.face), `face ${f.face} 重复填报`);
    seenFaces.add(f.face);
    need(RESULTS.includes(f.result), `faces.result 非法: ${f.result}`);
    need(typeof f.evidence === 'string' && f.evidence.length > 0, `face ${f.face} 缺 evidence（空结果 ≠ pass，⑦）`);
  }

  // 角色覆盖约束（F1 核心）
  if (ADVERSARIAL.includes(v.reviewer)) {
    for (const face of FACES) {
      need(seenFaces.has(face), `对抗席 ${v.reviewer} 缺检查面 ${face}（必须恰好七面全填，② 审⑧）`);
    }
    need((v.faces ?? []).length === 7, `对抗席 faces 数量必须为 7，得到 ${(v.faces ?? []).length}`);
  } else if (v.reviewer === 'upstream-preview') {
    for (const face of req.third_seat_required_faces) {
      need(seenFaces.has(face), `第三席缺必填检查面 ${face}（② 审⑧: F/G/E/D 为主）`);
    }
    const gateIds = new Set((v.gate_checks ?? []).map((g) => g.gate_id));
    for (const gid of req.third_seat_required_gates) {
      need(gateIds.has(gid), `第三席缺必填过程门 ${gid}（gate 缺席 = fail-open，禁止）`);
    }
  }

  // R10-A3: 加固清单覆盖率机器强制——仅 round===1 的两个对抗席（第三席/round>=2 不复核穷举面）。
  // MUST-FIX-2 反例: 旧实现只在 SKILL.md 里写"必须标 covered/n_a"，没有任何字段/schema/校验落地，
  // 三份完全不带 hardening_coverage 的 round:1 verdict 照样能让 runConsensusGate 返回 pass。
  if (ADVERSARIAL.includes(v.reviewer) && v.round === 1) {
    // SC-B4（D5）: checklist_version 是独立于「缺项计数」的校验——9→10 是 exact 集合变更，
    // 旧的 9 项 verdict（即便碰巧凑到 9 个合法 class_id）必须显式报「清单版本过期需重审」，
    // 不能被淹没进「缺项/漏项」的普通计数错误里（下面的 length/class_id 检查仍会照常触发，
    // 两条错误可以同时出现，但版本错误必须独立可辨认）。
    need(v.checklist_version === HARDENING_CHECKLIST_VERSION,
      `对抗席 ${v.reviewer} R1 的 checklist_version=${JSON.stringify(v.checklist_version)} 与当前加固清单版本 ${HARDENING_CHECKLIST_VERSION} 不符（清单版本过期需重审，不是缺项——D5: hardening-checklist.md 类别集合发生了 exact 变更）`);
    const items = v.hardening_coverage;
    if (!Array.isArray(items)) {
      need(false, `对抗席 ${v.reviewer} R1 缺 hardening_coverage（十类加固清单机器覆盖字段必填，R10-A3）`);
    } else {
      need(items.length === HARDENING_CLASS_COUNT,
        `对抗席 ${v.reviewer} R1 的 hardening_coverage 必须恰好 ${HARDENING_CLASS_COUNT} 项，得到 ${items.length}`);
      const seenClassIds = new Set();
      for (const item of items) {
        const cid = item?.class_id;
        const validId = Number.isInteger(cid) && cid >= 1 && cid <= HARDENING_CLASS_COUNT;
        need(validId, `hardening_coverage.class_id 非法: ${JSON.stringify(cid)}`);
        if (validId) {
          need(!seenClassIds.has(cid), `hardening_coverage.class_id 重复: ${cid}`);
          seenClassIds.add(cid);
        }
        need(HARDENING_RESULTS.includes(item?.result), `hardening_coverage[class_id=${cid}].result 非法: ${item?.result}`);
        need(typeof item?.evidence === 'string' && item.evidence.length > 0, `hardening_coverage[class_id=${cid}] 缺 evidence`);
      }
      for (let cid = 1; cid <= HARDENING_CLASS_COUNT; cid++) {
        need(seenClassIds.has(cid), `对抗席 ${v.reviewer} R1 的 hardening_coverage 缺 class_id=${cid}（十类必须逐一覆盖，不许分轮细水长流）`);
      }
    }
  }

  // face=fail 与总 verdict 交叉约束
  const anyFaceFail = (v.faces ?? []).some((f) => f.result === 'fail');
  if (anyFaceFail) need(v.verdict === 'REQUIRES_CHANGES', 'face 存在 fail 但总 verdict=APPROVED（交叉约束违例）');

  // touches_ui 与 B 面（⑫: reviewer 无自判权）
  if (bundle && bundle.touches_ui === true && ADVERSARIAL.includes(v.reviewer)) {
    const bFace = (v.faces ?? []).find((f) => f.face === 'B');
    need(bFace && bFace.result !== 'n_a', `bundle 判定 touches_ui=true 但 ${v.reviewer} 的 B 面为 n_a（⑫ 违例）`);
  }

  // findings
  need(Array.isArray(v.findings), 'findings 必须是数组');
  let hasTaxonomyGap = false;
  const seenFindingIds = new Set(); // e2e-consensus 实测缺口: 重复 id 会让一次 close 覆盖多条 finding
  for (const fd of v.findings ?? []) {
    need(typeof fd.id === 'string' && fd.id.length > 0, 'finding 缺 id');
    need(!seenFindingIds.has(fd.id), `finding id 重复: ${fd.id}（一次 close 不得覆盖多条）`);
    seenFindingIds.add(fd.id);
    need([...FACES, 'taxonomy_gap'].includes(fd.primary_face), `finding ${fd.id} primary_face 非法（⑪）`);
    if (fd.primary_face === 'taxonomy_gap') hasTaxonomyGap = true;
    need(SEVERITIES.includes(fd.severity), `finding ${fd.id} severity 非法`);
    need(typeof fd.anchor === 'string' && fd.anchor.length > 0, `finding ${fd.id} 缺 anchor`);
    // D2（anchor_paths 三用途拆分，2026-08-02）: 写入许可字段不受理外部输入——两个入口
    // 同等 fail-closed（本函数是唯一校验实现，CLI 只是薄封装，天然满足）。这里拒的是「字段
    // 出现即拒」，不是「出现被忽略」：schema 文档同步加 additionalProperties:false。
    for (const forbidden of ['write_paths', 'allowed_paths']) {
      need(!(forbidden in fd), `finding ${fd.id} 不得提供 ${forbidden}（D2: 写入许可只能由脚本从 SC kind 推导，不受理 lead/AI 自报——见 anchor_paths 三用途拆分设计）`);
    }
    // v2: anchor_paths 机器字段——分组唯一输入源，逐条 POSIX 精确文件校验（污染面从严）
    if (!Array.isArray(fd.anchor_paths) || fd.anchor_paths.length === 0) {
      need(false, `finding ${fd.id} 缺 anchor_paths（v2 机器字段必填，分组据此，degraded）`);
    } else {
      // SC-11（R2-P1-5）: 语法校验之外再加三道——
      //   ① 去重（uniqueItems）；② 数量上限（可信配置，防把「影响范围」当「证据锚点」广列
      //   进而制造假冲突把并行工作串行化）；③ 有 repoDir 时逐条验证是**真实 tracked blob**
      //   （"src" 这类无尾斜杠的真实目录在纯语法层会通过）
      const seenPaths = new Set();
      for (const p of fd.anchor_paths) {
        const r = normalizeRepoPath(p);
        need(r.ok, `finding ${fd.id} anchor_paths「${p}」非法: ${r.reason ?? ''}`);
        if (r.ok) {
          need(!seenPaths.has(r.path), `finding ${fd.id} anchor_paths 重复: ${r.path}`);
          seenPaths.add(r.path);
        }
      }
      const cap = opts.anchorPathsMax ?? DEFAULT_ANCHOR_PATHS_MAX;
      need(fd.anchor_paths.length <= cap,
        `finding ${fd.id} 的 anchor_paths 有 ${fd.anchor_paths.length} 条 > 上限 ${cap}（SC-11: 广列路径会制造假冲突把可并行工作串行化；请由 origin 席拆分成多条 finding）`);
      if (opts.trackedPaths) {
        for (const p of fd.anchor_paths) {
          const r = normalizeRepoPath(p);
          if (r.ok) {
            need(opts.trackedPaths.has(r.path),
              `finding ${fd.id} 的 anchor_paths「${r.path}」不是 base∪candidate 里的 tracked 文件（目录/不存在路径不收——SC-11）`);
          }
        }
      }
      // SC-R3-5①: anchor_paths ⊆ 被审 diff 实改集——tracked-but-unchanged 的共享 hub
      // （R3 的 .gitignore 攻击）在此被拦；diff 外影响面请写 scope_note
      if (opts.changedPaths) {
        for (const p of fd.anchor_paths) {
          const r = normalizeRepoPath(p);
          if (r.ok) {
            need(opts.changedPaths.has(r.path),
              `finding ${fd.id} 的 anchor_paths「${r.path}」不在 base..candidate 实改文件集内（评审锚点必须落在被审 diff 上；影响面写 scope_note——SC-R3-5）`);
          }
        }
      }
    }
    need(typeof fd.evidence === 'string' && fd.evidence.length > 0, `finding ${fd.id} 缺 evidence`);
    need(['open', 'closed'].includes(fd.status), `finding ${fd.id} status 非法`);
    // SC-B1（D1）: 归属在 finding 生成时（审查席）完成——actionable（blocker/major）finding
    // 必须携带 invariant + family_id；suggestion 不强制（未来即便被某条 SC 引用也不要求）。
    if (ACTIONABLE_SEVERITIES.includes(fd.severity)) {
      need(typeof fd.invariant === 'string' && fd.invariant.length > 0 && fd.invariant.length <= 120,
        `finding ${fd.id}（${fd.severity}）缺 invariant 或超长（SC-B1: actionable finding 必须给出 ≤120 字的「被破坏的不变量」）`);
      need(typeof fd.family_id === 'string' && fd.family_id.length > 0,
        `finding ${fd.id}（${fd.severity}）缺 family_id（SC-B1: actionable finding 必须归族，即便是「自成一族」）`);
    }
  }
  // SC-B1（D1）: family_id 引用合法性——同一 verdict 内，同一个 family_id 下的全部 finding
  // 必须携带**逐字相同**的 invariant（同 verdict 内自洽）。机器只做这一件事：格式/引用合法、
  // 逐字相等；「这几处是不是真的同一个不变量」的语义判断永远是审查席自己的事，机器不裁决、
  // 也不因此合并 SC（D2）。
  {
    const familyInvariant = new Map();
    for (const fd of v.findings ?? []) {
      if (!ACTIONABLE_SEVERITIES.includes(fd.severity)) continue;
      if (typeof fd.family_id !== 'string' || !fd.family_id) continue; // 上面已报错，此处不重复
      if (typeof fd.invariant !== 'string' || !fd.invariant) continue;
      if (!familyInvariant.has(fd.family_id)) {
        familyInvariant.set(fd.family_id, fd.invariant);
      } else {
        need(familyInvariant.get(fd.family_id) === fd.invariant,
          `finding ${fd.id} 的 family_id=${fd.family_id} 与同 verdict 内其他成员的 invariant 不一致（"${fd.invariant}" ≠ "${familyInvariant.get(fd.family_id)}"）——同一 family 内 invariant 必须逐字一致（同 verdict 内自洽，D1）`);
      }
    }
  }
  if (hasTaxonomyGap) {
    need(v.run_status === 'degraded', 'taxonomy_gap 存在但 run_status≠degraded（⑪: 必须停轮，禁止丢弃）');
  }

  // gate_checks
  need(Array.isArray(v.gate_checks), 'gate_checks 必须是数组');
  for (const g of v.gate_checks ?? []) {
    need(typeof g.gate_id === 'string' && g.gate_id.length > 0, 'gate_check 缺 gate_id');
    need(RESULTS.includes(g.result), `gate_check ${g.gate_id} result 非法`);
    need(typeof g.evidence === 'string' && g.evidence.length > 0, `gate_check ${g.gate_id} 缺 evidence`);
  }
  const anyGateFail = (v.gate_checks ?? []).some((g) => g.result === 'fail');
  if (anyGateFail) need(v.verdict === 'REQUIRES_CHANGES', 'gate_check 存在 fail 但总 verdict=APPROVED（审⑧交叉约束违例）');

  return errs;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.verdict) fail('用法: verdict-validate.mjs --verdict <verdict.json> [--bundle <bundle.json>]');
  // SC-11 + SC-R3-5: 传 --repo-dir 时启用 tracked + changed-set 双校验
  const v0 = readJson(args.verdict);
  let trackedPaths = null, changedPaths = null;
  if (args['repo-dir']) {
    trackedPaths = trackedPathSet({ repoDir: args['repo-dir'], baseSha: v0.base_sha, candidateSha: v0.candidate_sha });
    changedPaths = changedPathSet({ repoDir: args['repo-dir'], baseSha: v0.base_sha, candidateSha: v0.candidate_sha });
  }
  const errs = validateVerdict(v0, {
    trackedPaths, changedPaths, bundle: args.bundle ? readJson(args.bundle) : null });
  if (errs.length) {
    for (const e of errs) process.stderr.write(`[SCHEMA-FAIL] ${e}\n`);
    process.stderr.write('[VERDICT] degraded（schema 校验失败一律 degraded，⑨）\n');
    process.exit(1);
  }
  process.stdout.write('ok\n');
}
