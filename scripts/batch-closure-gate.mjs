#!/usr/bin/env node
// 批次闭合门 — issue #9 SC 延伸（批次事务协议，i9-batch）。
// 职责：批次收口时验证「冻结集全处置 + 新 family 不混入本批」，是 sc-coverage-gate 的
// 时间维度补充，不是替代：
//   · sc-coverage-gate 只看「当前 artifact 的 canonical_findings 都被 SC 恰好覆盖 1:1」；
//   · 本门追踪「批次开始时承诺处置的 family 集（frozen_families）在收口时是否全部兑现」——
//     关键增量是冻结集与终版集的**差集**：被「答」撤回（从 findings[] 消失）或审查席删除的
//     family，sc-coverage-gate 看不见（它不在终版 canonical 里），但本门必须拒收口。
// 判据（任一违 → fail-closed，消息互斥以支持反向变异隔离）：
//   ① run manifest 必须携带 batch 段且 status='closed'（open = 批次未收口，不许闭合判定）
//   ② batch.frozen_at_sha 必须 == run manifest 的 source_candidate（起点 CAS 派生，不自报）
//   ③ batch.frozen_families ⊆ 源共识（批次起点）canonical_findings 的 family_key 集
//     （冻结集只能来自源共识——initRun 已验，此处独立重验，防 init 后篡改）
//   ④ batch.frozen_families ∩ 终版共识 canonical_findings 的 family_key 集必须为空
//     （处置语义：冻结集内的 family 在本批 delta 审查中**不再出现** = 上次修住 = 处置完成；
//      再次出现 = 同族复发 = 上次没修住 = 未处置 → 拒收口，并按 Task 4 触发归因六件套——
//      机器检测点即此交集，语义对齐「同一个 family_key 二次出现」）
//   ⑤ 本批 SC（非 global）携带的 family_key 必须 ∈ batch.frozen_families
//     （本批 SC 只处置冻结集内的族；处置冻结集之外的 family = 把下一批的义务混进本批 → 拒）
// 保证等级 T1（如实声明）：
//   · family_key 是逐字内容派生（consensus-gate.mjs 的 familyKeyOf，归一化仅 trim/小写/去空白）——
//     「同一根因换个说法」会算出不同 key，机器视为新族（进下一批，不触发本门）；语义级同族
//     复发检测机器做不到，只能靠 lead 冻结时人工归族。本门只锁形状与集合关系，不防伪造
//     （同本仓其余 T1 条款：本地可构造满足全部条件的 run manifest 同样能通过，无签名/存证）。
//   · suggestion 级 canonical finding 不带 family_key（共识 schema 不强制），其 SC 无 family_key
//     可判定归属 → 放行（不在冻结集模型内）；机器能锁住的 actionable 混入全部锁住。
import { readJson, parseArgs, fail, isMain } from './lib/common.mjs';
import { recomputeArtifactHash, assertArtifactShape } from './consensus-gate.mjs';
import { runManifestHash, verifyEventChain } from './fix-run.mjs';

export function checkBatchClosure({ runManifest, sourceArtifact, finalArtifact, scManifest }) {
  const errs = [];
  const need = (c, m) => { if (!c) errs.push(m); };

  need(runManifest && typeof runManifest === 'object', 'run manifest 不是对象');
  need(sourceArtifact && typeof sourceArtifact === 'object', '源 consensus artifact 不是对象');
  need(finalArtifact && typeof finalArtifact === 'object', '终版 consensus artifact 不是对象');
  need(scManifest && typeof scManifest === 'object', 'sc manifest 不是对象');
  if (errs.length) return errs;

  // ① 批次段存在且已收口
  const batch = runManifest.batch;
  need(batch && typeof batch === 'object', 'run manifest 无 batch 段（非批次 run，闭合门不适用，fail-closed）');
  if (!batch) return errs;
  need(batch.status === 'closed', `batch.status=${JSON.stringify(batch.status)} ≠ closed（批次未收口，不许闭合判定）`);
  need(/^[A-Za-z0-9._-]+$/.test(String(batch.batch_id ?? '')), `batch.batch_id 非法: ${batch.batch_id}`);

  // 事件链完整（防删改历史，与 fix-run.loadRun 同判据）
  for (const e of verifyEventChain(runManifest)) errs.push(`run manifest: ${e}`);
  need(runManifest.schema_version === 'v3', `run manifest schema_version=${JSON.stringify(runManifest.schema_version)} ≠ v3（批次段是 v3 schema 的字段，i9-batch）`);

  // ② 起点派生不自报
  need(batch.frozen_at_sha === runManifest.source_candidate,
    `batch.frozen_at_sha（${String(batch.frozen_at_sha).slice(0, 12)}）≠ run manifest source_candidate（${String(runManifest.source_candidate).slice(0, 12)}）——批次起点必须由 run 起点派生，不接受自报`);

  // 终版 artifact 结构门 + 自洽（照 sc-coverage-gate：结构门先于 hash，PASS 共识才配闭合）
  for (const e of assertArtifactShape(finalArtifact, '终版 consensus artifact')) errs.push(e);
  for (const e of assertArtifactShape(sourceArtifact, '源 consensus artifact')) errs.push(e);
  if (errs.length) return errs;
  let fReal = null, sReal = null;
  try { fReal = recomputeArtifactHash(finalArtifact); } catch (e) { errs.push(`终版 consensus artifact hash 重算失败（结构非法，fail-closed）: ${e.message}`); }
  try { sReal = recomputeArtifactHash(sourceArtifact); } catch (e) { errs.push(`源 consensus artifact hash 重算失败（结构非法，fail-closed）: ${e.message}`); }
  if (fReal !== null) need(finalArtifact.consensus_artifact_hash === fReal, '终版 consensus artifact 自身 hash 与内容重算不符（artifact 被改）');
  if (sReal !== null) need(sourceArtifact.consensus_artifact_hash === sReal, '源 consensus artifact 自身 hash 与内容重算不符（artifact 被改）');
  if (fReal !== null) need(finalArtifact.gate_result === 'pass', `终版 consensus artifact gate_result=${finalArtifact.gate_result} ≠ pass（只有 PASS 共识才能作闭合判定的终版）`);
  if (sReal !== null) need(sourceArtifact.gate_result === 'pass', `源 consensus artifact gate_result=${sourceArtifact.gate_result} ≠ pass（只有 PASS 共识才能作批次起点）`);
  // 源共识必须是终版共识的谱系祖先（同 base 且 candidate 推进——终版是 delta 轮产物）
  need(finalArtifact.base_sha === sourceArtifact.base_sha, '终版共识与源共识的 base_sha 不同（跨评审拼接，i9-batch）');
  need(finalArtifact.parent_artifact_hash === sReal,
    `终版共识的 parent 不是源共识（parent=${String(finalArtifact.parent_artifact_hash).slice(0, 12)} 源=${String(sReal).slice(0, 12)}）——批次闭合判定要求终版是源共识的直接 delta 轮产物`);

  const frozen = batch.frozen_families ?? [];
  need(Array.isArray(frozen) && frozen.length > 0, 'batch.frozen_families 缺失或为空（冻结集为空 = 没有待处置义务，语义不成立）');

  // ③ 冻结集真实（⊆ 源共识 family_keys）
  const srcKeys = new Set((sourceArtifact.canonical_findings ?? []).map((c) => c.family_key).filter(Boolean));
  for (const fk of frozen) {
    if (!srcKeys.has(fk)) errs.push(`batch.frozen_families 含不在源共识中的 family_key: ${fk.slice(0, 12)}…（冻结集只能从源共识派生，fail-closed）`);
  }

  // ④ 全处置（冻结集 ∩ 终版 family_keys 必须为空——终版再次出现 = 同族复发 = 未处置）
  const finKeys = new Set((finalArtifact.canonical_findings ?? []).map((c) => c.family_key).filter(Boolean));
  const recurred = frozen.filter((fk) => finKeys.has(fk));
  if (recurred.length) {
    for (const fk of recurred) {
      errs.push(`冻结集 family_key ${fk.slice(0, 12)}… 在终版共识中再次出现（同族复发：上次未修住或未 ARCHIVE，不得作为处置兑现，拒收口；按 i9-batch Task 4 须先产出归因六件套）`);
    }
  }

  // ⑤ 本批 SC 不处置冻结集外的 family（新 family 进下一批，不得混入本批）
  const frozenSet = new Set(frozen);
  const scs = Array.isArray(scManifest.scs) ? scManifest.scs : [];
  for (const sc of scs) {
    if (sc.kind === 'global') continue; // global SC 是中央验证步，不引用 finding，无族归属
    if (typeof sc.family_key === 'string' && sc.family_key) {
      if (!frozenSet.has(sc.family_key)) {
        errs.push(`本批 SC ${sc.id} 处置了冻结集之外的 family_key: ${sc.family_key.slice(0, 12)}…（批次期间新冒出的 finding 必须进下一批，不得混入本批 manifest，i9-batch）`);
      }
    }
    // 无 family_key 的 SC = 引用 suggestion 级 finding（共识不强制 suggestion 携带该字段）——
    // 不在冻结集模型内，放行（T1 上限如实声明见文件头）。
  }

  return errs;
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args['run-manifest'] || !args['source-artifact'] || !args['final-artifact'] || !args['sc-manifest']) {
    fail('用法: batch-closure-gate.mjs --run-manifest <run.json> --source-artifact <consensus.json> --final-artifact <consensus.json> --sc-manifest <sc-manifest.json>');
  }
  const errs = checkBatchClosure({
    runManifest: readJson(args['run-manifest']),
    sourceArtifact: readJson(args['source-artifact']),
    finalArtifact: readJson(args['final-artifact']),
    scManifest: readJson(args['sc-manifest'])
  });
  if (errs.length) {
    for (const e of errs) process.stderr.write(`[BATCH-CLOSURE-FAIL] ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('BATCH-CLOSURE-OK\n');
}
