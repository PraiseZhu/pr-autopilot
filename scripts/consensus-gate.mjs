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
import { validateVerdict } from './verdict-validate.mjs';
import { computeReviewInputHash } from './review-input-hash.mjs';

const REVIEWERS = ['claude-adversarial', 'codex-adversarial', 'upstream-preview'];

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
  const failReasons = [];

  if (!bundle) failReasons.push('缺 review bundle（共识脚本必须重算 input hash，不信 opaque 值）');
  if (verdicts.length !== 3) failReasons.push(`需要恰好 3 份 verdict，得到 ${verdicts.length}`);

  for (const v of verdicts) {
    const errs = validateVerdict(v, { bundle, requirements: opts.requirements });
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
          status: 'closed' // 走到这里必然全 closed（conjunct② 已断言）
        });
      }
      const c = union.get(key);
      c.origins.push({ reviewer: v.reviewer, finding_id: fd.id });
      for (const p of fd.anchor_paths ?? []) if (!c.anchor_paths.includes(p)) c.anchor_paths.push(p);
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
  const consensus_artifact_hash = sha256(
    base_sha + candidate_sha + review_input_hash + canonicalJson(canonical_findings) + canonicalJson(verdict_hashes)
  );
  return {
    schema_version: 'v1',
    review_input_hash,
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
    canonicalJson(artifact.canonical_findings) + canonicalJson(artifact.verdict_hashes)
  );
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length < 3 || !args.bundle) {
    fail('用法: consensus-gate.mjs <v1.json> <v2.json> <v3.json> --bundle <bundle.json> [--out artifact.json]');
  }
  const verdicts = args._.slice(0, 3).map(readJson);
  const result = runConsensusGate(verdicts, { bundle: readJson(args.bundle) });
  if (result.gate_result === 'pass') {
    if (args.out) writeJsonAtomic(args.out, result);
    process.stdout.write(`PASS consensus_artifact_hash=${result.consensus_artifact_hash}\n`);
  } else {
    for (const r of result.fail_reasons) process.stderr.write(`[GATE-FAIL] ${r}\n`);
    process.exit(1);
  }
}
