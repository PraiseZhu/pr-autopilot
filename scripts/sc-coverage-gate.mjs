#!/usr/bin/env node
// SC 覆盖门 — 修 R1 挖出的既有洞: push-guard 从未把 sc_list 绑回 consensus findings，
// lead 可持合法 consensus hash 配自编 SC 清单 push 照过，三审价值链被架空。
// 本门（push-guard 在场重跑）保证 Phase 2b「共识确认的每条 finding 都提炼成 SC」有机器强制:
//   ① manifest.consensus_artifact_hash 必须等于 artifact 实际重算值（不信自报）
//   ② 每条 severity∈{blocker,major} 的 canonical finding 必须被 ≥1 条 SC 覆盖（exact，无遗漏）
//   ③ SC 引用的 finding_ids 无悬空（必须是 artifact 里真实存在的 canonical id）
//   ④ fix/verify/archive SC 必须引用 ≥1 finding；global SC ≤1 条且不引用 finding
// 任一违 → fail-closed。suggestion 级 finding 不强制覆盖（进 residual，与共识白名单口径一致）。
import { readJson, parseArgs, fail, isMain } from './lib/common.mjs';
import { recomputeArtifactHash } from './consensus-gate.mjs';
import { validateVerifyRecipe } from './fix-run.mjs';

export function checkScCoverage({ manifest, artifact }) {
  const errs = [];
  const need = (c, m) => { if (!c) errs.push(m); };

  need(manifest && typeof manifest === 'object', 'sc manifest 不是对象');
  need(artifact && typeof artifact === 'object', 'consensus artifact 不是对象');
  if (errs.length) return errs;

  // ① artifact hash 绑定（重算，不信自报）
  const real = recomputeArtifactHash(artifact);
  need(artifact.consensus_artifact_hash === real, 'artifact 自身 hash 与内容重算不符（artifact 被改）');
  need(manifest.consensus_artifact_hash === real,
    `sc manifest 的 consensus_artifact_hash 与 artifact 重算值不符（manifest=${String(manifest.consensus_artifact_hash).slice(0, 12)} 实=${real.slice(0, 12)}）——SC 未绑定到本次共识`);

  const canonical = artifact.canonical_findings ?? [];
  const canonicalIds = new Set(canonical.map((f) => f.id));
  const mustCover = canonical.filter((f) => f.severity === 'blocker' || f.severity === 'major');

  const scs = Array.isArray(manifest.scs) ? manifest.scs : [];
  need(scs.length > 0, 'sc manifest 无 SC');

  // ③④ 逐 SC 结构 + SC-4 一对一双射
  // SC-4（R2-P1-2）: 非 global SC 必须**恰好引用 1 条** finding，且每条 blocker/major finding
  // **恰好被 1 条** SC 引用。旧实现允许一条 SC 引用任意多 finding → lead 可写 mega-SC
  // 把多个不相交 finding 塞成一条，使 fix-plan 的冲突图合法退化为单组 = 合法全串行。
  // 多步骤修复写在 change/holds 文本里，不得借 finding_ids 合组。
  const coverCount = new Map();
  let globalCount = 0;
  const seenScIds = new Set();
  const SC_ID_RE = /^SC-[A-Za-z0-9._-]+$/;
  for (const sc of scs) {
    // schema 约束在此真正执行（R2: schema 此前未被任何代码校验）
    need(typeof sc.id === 'string' && SC_ID_RE.test(sc.id), `SC id 格式非法: ${JSON.stringify(sc.id)}（须 ^SC-[A-Za-z0-9._-]+$）`);
    need(!seenScIds.has(sc.id), `SC id 重复: ${sc.id}`);
    seenScIds.add(sc.id);
    for (const f of ['change', 'holds']) {
      need(typeof sc[f] === 'string' && sc[f].trim().length > 0, `SC ${sc.id} 缺必填字段 ${f}`);
    }
    // SC-R3-4（D2）: verify 必须是结构化 argv 配方——自由文本会被 shell 解释（命令注入面）
    const recipeErr = validateVerifyRecipe(sc.verify);
    need(!recipeErr, `SC ${sc.id}: ${recipeErr}`);
    const fids = Array.isArray(sc.finding_ids) ? sc.finding_ids : [];
    if (sc.kind === 'global') {
      globalCount++;
      need(fids.length === 0, `global SC ${sc.id} 不得引用 finding（它是中央验证步）`);
    } else {
      need(['fix', 'verify', 'archive'].includes(sc.kind), `SC ${sc.id} kind 非法: ${sc.kind}`);
      need(fids.length === 1,
        `SC ${sc.id}（${sc.kind}）必须**恰好引用 1 条** finding，实际 ${fids.length}（SC-4: 禁 mega-SC——多个 finding 塞一条会让分组合法退化为串行；多步骤写在 change/holds 文本里）`);
      for (const fid of fids) {
        need(canonicalIds.has(fid), `SC ${sc.id} 引用悬空 finding_id: ${fid}（不在 consensus artifact 中）`);
        coverCount.set(fid, (coverCount.get(fid) ?? 0) + 1);
      }
    }
  }
  need(globalCount <= 1, `global SC 至多 1 条，得到 ${globalCount}`);

  // ② blocker/major 恰好被 1 条 SC 覆盖（漏项 & 重复覆盖都拒）
  for (const f of mustCover) {
    const n = coverCount.get(f.id) ?? 0;
    if (n === 0) {
      need(false, `canonical finding ${f.id}（${f.severity}/${f.primary_face}）未被任何 SC 覆盖——三审确认的问题不得在修复阶段静默丢弃`);
    } else {
      need(n === 1, `canonical finding ${f.id} 被 ${n} 条 SC 重复引用（SC-4: 必须一对一，重复覆盖会污染分组）`);
    }
  }
  // suggestion 级被引用也须唯一（防用 suggestion 当合组载体）
  for (const [fid, n] of coverCount) {
    if (!mustCover.some((f) => f.id === fid)) need(n === 1, `finding ${fid} 被 ${n} 条 SC 引用（须唯一）`);
  }
  return errs;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest || !args.artifact) {
    fail('用法: sc-coverage-gate.mjs --manifest <sc-manifest.json> --artifact <consensus.json>');
  }
  const errs = checkScCoverage({ manifest: readJson(args.manifest), artifact: readJson(args.artifact) });
  if (errs.length) {
    for (const e of errs) process.stderr.write(`[SC-COVERAGE-FAIL] ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('SC-COVERAGE-OK\n');
}
