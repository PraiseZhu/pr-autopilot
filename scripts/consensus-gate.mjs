#!/usr/bin/env node
// 共识门 — 计划依据: SP-2 / §1.1b ⑥⑨⑩
// 审②修复（F1/F2/F4）:
//   - conjunct② 收紧: **每一份 verdict 里的每一条 finding** 必须 status=closed 且出现在
//     该 reviewer 自己的 closed_finding_ids —— 聚类只用于报告与去重展示，
//     不再决定"谁负责关"（堵 F2: 一席先关吞掉另一席仍 open 的同簇 finding）
//   - 必须提供 review bundle: 共识脚本用 bundle 重算 review_input_hash，
//     三份 verdict 的 hash 必须等于重算值（不信 opaque 字符串）
//   - verdict 校验走 role-aware 跨字段规则（verdict-validate F1 修复版）
//   - consensus artifact 增记 base_sha / candidate_sha，供 push-guard 绑定（F4）
// 放行四 conjunct（缺一不可）:
//   ① 三 verdict 同 review_input_hash 且 == bundle 重算值
//   ② 每条 finding 由其所属 reviewer 本人 close（全量，无例外）
//   ③ 三 verdict 均 APPROVED
//   ④ 全部 gate_checks ∈ {pass, n_a}（脚本断言，不信模型总 verdict）
import { hashObject, sha256, canonicalJson, readJson, writeJsonAtomic, parseArgs, fail, nowIso, isMain} from './lib/common.mjs';
import { validateVerdict, changedPathSet } from './verdict-validate.mjs';
import { computeReviewInputHash } from './review-input-hash.mjs';

const REVIEWERS = ['claude-adversarial', 'codex-adversarial', 'upstream-preview'];
const SEVERITY_RANK = { suggestion: 1, major: 2, blocker: 3 }; // SC-5: canonical 取最高

// D1（owner 2026-08-02 fable 拍板，gpt 终审阻断修复）: family_key 是跨 reviewer/跨 candidate 的
// 内容派生身份——`family_id` 只是「同 verdict 内」的本地归组标签（SKILL.md 正式定义），两个不同
// reviewer 完全可能各自合法地把同一个标签（如 "F1"）用来指不同的不变量；下游若直接按 family_id
// 字符串分组，会把互不相关的 finding 错误合并（gpt 实测复现: SC-A「状态单一 writer」与 SC-B
// 「删除须 reconciliation」因两席各自的 F1 恰好撞了标签字符串，被合成一族，PR body 只显示了
// 第一个 invariant）。family_key 从 invariant 文本本身派生：同（归一化后）文本 → 同 key，
// 不同文本 → （密码学意义上）不同 key，天然免疫「标签撞车」，也天然支持反过来的「同一 invariant
// 用了不同 family_id 标签」被正确合并。'fk1-' 是算法版本前缀——未来若换归一化规则，旧 key 与新
// key 不再相等，不会被误认成兼容（对齐 hardening-checklist 第 7 类「改契约要同步改」的教训）。
export function normalizeInvariantForKey(invariant) {
  return String(invariant).trim().toLowerCase().replace(/\s+/g, '');
}
export function familyKeyOf(invariant) {
  if (typeof invariant !== 'string' || !invariant) return null;
  return `fk1-${sha256(normalizeInvariantForKey(invariant))}`;
}

// 聚类 key（仅用于去重展示，不参与放行判定）:
// face + 去行号规整 anchor + 语义指纹。同 key 的多席条目并入一簇，
// 全部 origins 保留（审②-F2: 不做先到先得）。
export function canonicalFindingKey(finding) {
  const anchor = String(finding.anchor)
    .toLowerCase()
    .replace(/:\d+(-\d+)?$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const semantic = sha256(
    String(finding.evidence).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)
  ).slice(0, 16);
  return `${finding.primary_face}|${anchor}|${semantic}`;
}

export function runConsensusGate(verdicts, opts = {}) {
  const bundle = opts.bundle ?? null;
  // SC-3（R2-P1-1）: delta 轮必须 exact 绑定上一轮 artifact——只比 base_sha 挡不住
  // 「同 base 的另一份源 artifact 冒充」。首轮为 null。
  const parentArtifactHash = opts.parentArtifactHash ?? null;
  // R4-P1: changed-set 校验必须在**共识入口**生效，不能只活在 validator CLI——
  // 否则 tracked-but-unchanged 的 hub 路径能穿过 live 路径污染冲突图。
  // repoDir 在场时脚本自算实改集；调用方也可直接注入 changedPaths（fixture 用）。
  let changedPaths = opts.changedPaths ?? null;
  const failReasons = [];
  if (!changedPaths && opts.repoDir && bundle) {
    try { changedPaths = changedPathSet({ repoDir: opts.repoDir, baseSha: bundle.base_sha, candidateSha: bundle.candidate_sha }); }
    catch (e) { failReasons.push(`无法计算 base..candidate 实改集（fail-closed）: ${e.message}`); }
  }
  // R5-P1: 函数契约本身 fail-closed——changedPaths 与 repoDir 双缺 = 调用方漏传（T1 要拦的
  // 正是这种疏忽），不允许产出 pass artifact。不设旁路 flag。
  if (!changedPaths) {
    failReasons.push('缺 base..candidate 实改集（changedPaths / repoDir 二者必居其一）——anchor 污染门不允许 fail-open（R5-P1）');
  }

  if (!bundle) failReasons.push('缺 review bundle（共识脚本必须重算 input hash，不信 opaque 值）');
  if (verdicts.length !== 3) failReasons.push(`需要恰好 3 份 verdict，得到 ${verdicts.length}`);

  for (const v of verdicts) {
    const errs = validateVerdict(v, { bundle, changedPaths, requirements: opts.requirements });
    if (errs.length) failReasons.push(`verdict(${v?.reviewer ?? '?'}) schema/跨字段校验失败 → degraded: ${errs[0]}`);
    else if (v.run_status !== 'ok') failReasons.push(`verdict(${v.reviewer}) run_status=degraded ≠ APPROVED（⑦ fail-closed）`);
  }

  const seen = new Set(verdicts.map((v) => v?.reviewer));
  for (const r of REVIEWERS) {
    if (!seen.has(r)) failReasons.push(`缺少三席之一: ${r}`);
  }
  if (failReasons.length) return { gate_result: 'fail', fail_reasons: failReasons };

  // conjunct ①: 同 hash 且等于 bundle 重算值
  let recomputed = null;
  try {
    recomputed = computeReviewInputHash(bundle);
  } catch (e) {
    failReasons.push(`bundle 无法重算 input hash（fail-closed）: ${e.message}`);
  }
  const hashes = new Set(verdicts.map((v) => v.review_input_hash));
  if (hashes.size !== 1) {
    failReasons.push(`conjunct① 失败: review_input_hash 不一致（${[...hashes].map((h) => h.slice(0, 12)).join(' / ')}）`);
  } else if (recomputed && [...hashes][0] !== recomputed) {
    failReasons.push(`conjunct① 失败: verdict 携带的 hash 与 bundle 重算值不符（携带=${[...hashes][0].slice(0, 12)} 重算=${recomputed.slice(0, 12)}）`);
  }
  // SHA 一致性: 三份 verdict 的 base/candidate 必须一致且与 bundle 相同
  for (const field of ['base_sha', 'candidate_sha']) {
    const vals = new Set(verdicts.map((v) => v[field]));
    if (vals.size !== 1) failReasons.push(`三份 verdict 的 ${field} 不一致`);
    else if (bundle && bundle[field] && [...vals][0] !== bundle[field]) {
      failReasons.push(`verdict 的 ${field} 与 bundle 不一致`);
    }
  }

  // conjunct ②（收紧版）: 全量 finding 逐条由本人 close
  for (const v of verdicts) {
    for (const fd of v.findings) {
      const closed = fd.status === 'closed' && v.closed_finding_ids.includes(fd.id);
      if (!closed) failReasons.push(`conjunct② 失败: ${v.reviewer} 的 finding ${fd.id} 未被本人 close（他席关闭不算，lead 代关不算）`);
    }
  }

  // conjunct ③
  for (const v of verdicts) {
    if (v.verdict !== 'APPROVED') failReasons.push(`conjunct③ 失败: ${v.reviewer} verdict=${v.verdict}`);
  }

  // conjunct ④
  for (const v of verdicts) {
    for (const g of v.gate_checks) {
      if (!['pass', 'n_a'].includes(g.result)) {
        failReasons.push(`conjunct④ 失败: ${v.reviewer} gate_check ${g.gate_id}=${g.result}`);
      }
    }
  }

  if (failReasons.length) return { gate_result: 'fail', fail_reasons: failReasons };

  // 聚类（展示层）: 全 origins 保留
  const union = new Map();
  for (const v of verdicts) {
    for (const fd of v.findings) {
      const key = canonicalFindingKey(fd);
      if (!union.has(key)) {
        union.set(key, {
          canonical_key: key,
          id: sha256(key).slice(0, 12), // v2: 稳定 canonical finding id，供 SC manifest 引用
          origins: [],
          primary_face: fd.primary_face,
          severity: fd.severity,
          anchor: fd.anchor,
          anchor_paths: [], // v2: 各 origin 并集，随 artifact hash——下游换路径即断裂
          // SC-B1（D1）: invariant 冻结自**首个**（按 verdicts 到达顺序）提供该字段的
          // origin——与 anchor/primary_face 同一处理方式（只有 severity 特殊取最高，见下方）。
          // 归属本就发生在 origin 席自己的 verdict 里（同 verdict 内 family_id 已由
          // verdict-validate 强制自洽），这里只做「冻结第一手」，不做跨 origin 的语义合并/裁决。
          // suggestion 级 finding 不强制该字段——不带就不带，不写 null（schema 类型是 string）。
          // D1: family_key 从冻结后的 invariant 派生——跨 reviewer/跨 candidate 的真实身份，
          // 下游分组/校验全部改绑这个字段，不再信任 family_id 字符串本身（见上方 familyKeyOf）。
          ...(typeof fd.invariant === 'string' && fd.invariant ? { invariant: fd.invariant, family_key: familyKeyOf(fd.invariant) } : {}),
          // D1: origin_family_ids 保留每个 origin 自己的本地标签，供人工回溯「这条记录是哪个
          // reviewer 用哪个标签指过」——不参与任何机器分组判定，纯审计用途。
          origin_family_ids: [],
          status: 'closed' // 走到这里必然全 closed（conjunct② 已断言）
        });
      }
      const c = union.get(key);
      c.origins.push({ reviewer: v.reviewer, finding_id: fd.id });
      if (typeof fd.family_id === 'string' && fd.family_id) {
        c.origin_family_ids.push({ reviewer: v.reviewer, family_id: fd.family_id });
      }
      for (const p of fd.anchor_paths ?? []) if (!c.anchor_paths.includes(p)) c.anchor_paths.push(p);
      // SC-5（R2-P1-2 附带洞）: canonical severity 取同簇**最高**——旧实现取首个 origin，
      // 一席 suggestion 一席 major 时输入顺序能把 canonical 降为 suggestion，
      // 从而绕过 coverage gate 的强制覆盖。
      if (SEVERITY_RANK[fd.severity] > SEVERITY_RANK[c.severity]) c.severity = fd.severity;
    }
  }

  const review_input_hash = verdicts[0].review_input_hash;
  for (const c of union.values()) c.anchor_paths.sort(); // 确定性: 并集顺序不依赖 origin 到达序
  const canonical_findings = [...union.values()].sort((a, b) => a.canonical_key.localeCompare(b.canonical_key));
  const verdict_hashes = {};
  for (const v of verdicts) verdict_hashes[v.reviewer] = hashObject(v);
  const base_sha = verdicts[0].base_sha;
  const candidate_sha = verdicts[0].candidate_sha;
  // 审③-F4-R: base/candidate 必须入锅——只改 artifact 声明的 SHA 即 hash 失效
  // SC-3: parent_artifact_hash 一并入锅——谱系被换即 hash 失效
  const consensus_artifact_hash = sha256(
    base_sha + candidate_sha + review_input_hash + canonicalJson(canonical_findings) + canonicalJson(verdict_hashes) +
    canonicalJson({ parent: parentArtifactHash })
  );
  return {
    schema_version: 'v2',
    review_input_hash,
    parent_artifact_hash: parentArtifactHash,
    base_sha,
    candidate_sha,
    canonical_findings,
    verdict_hashes,
    consensus_artifact_hash,
    created_at: nowIso(),
    gate_result: 'pass',
    fail_reasons: []
  };
}

// push-guard 复用: 从 artifact 内容重算 hash（F4: 不信自报字符串；F4-R: 含 base/candidate）
export function recomputeArtifactHash(artifact) {
  return sha256(
    artifact.base_sha + artifact.candidate_sha + artifact.review_input_hash +
    canonicalJson(artifact.canonical_findings) + canonicalJson(artifact.verdict_hashes) +
    canonicalJson({ parent: artifact.parent_artifact_hash ?? null })
  );
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  // R4-P1: live 入口必须带 --repo-dir——changed-set 校验缺席 = anchor 污染门形同虚设
  if (args._.length < 3 || !args.bundle || !args['repo-dir']) {
    fail('用法: consensus-gate.mjs <v1.json> <v2.json> <v3.json> --bundle <bundle.json> --repo-dir <dir> [--parent <prev-artifact.json>] [--out artifact.json]\n（--repo-dir 必填: 共识入口自算 base..candidate 实改集校验 anchor_paths——R4-P1；delta 轮必须传 --parent——SC-3）');
  }
  const verdicts = args._.slice(0, 3).map(readJson);
  const parentArtifactHash = args.parent ? readJson(args.parent).consensus_artifact_hash : null;
  const result = runConsensusGate(verdicts, { bundle: readJson(args.bundle), parentArtifactHash, repoDir: args['repo-dir'] });
  if (result.gate_result === 'pass') {
    if (args.out) writeJsonAtomic(args.out, result);
    process.stdout.write(`PASS consensus_artifact_hash=${result.consensus_artifact_hash}\n`);
  } else {
    for (const r of result.fail_reasons) process.stderr.write(`[GATE-FAIL] ${r}\n`);
    process.exit(1);
  }
}
